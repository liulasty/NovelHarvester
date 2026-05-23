/**
 * book18.org 工作流：
 * 1) 传入目录 URL，从 div.content-wrapper ul li 解析章节链接
 *    - 推荐：/zh-hans/chapters/书名编码 专章列表（全部 li 均为章节）
 *    - 兼容：书籍页或阅读页侧栏目录（首条为书籍总览，会跳过）
 * 2) 逐章打开，从 .reader 提取正文
 *
 * 用法：
 *   node gaode/book18/scrape-novel.js
 *   node gaode/book18/scrape-novel.js https://www.book18.org/zh-hans/chapters/...
 * 不传参数时：优先用环境变量 BOOK18_CHAPTERS_URL；否则若存在 chapters_urls.txt 则读文件；
 *   否则使用脚本内默认的 /zh-hans/chapters/... 目录页。
 * --file 强制只读章节 URL 列表文件（默认 chapters_urls.txt，可用 --url-file= 指定）
 * --out-dir=书籍根目录  元数据（chapters_manifest.json）写在根下；分章 txt 写在 书籍根目录/chapters/
 * --merge 抓取结束后合并为 书籍根目录/merged/{小说名}.txt（有 --merge-title 时以书名为文件名；否则为 全文合并.txt）
 * --merge-title=书名  合并文件抬头（可选）
 *
 * 试跑限制：在 URL 后加数字，如：.../chapters/... 5
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
/** 项目根（含 chapters_urls.txt、novel-workflow.js），与当前工作目录无关 */
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const LIST_ITEM_SEL = 'div.content-wrapper ul li';
const CONTENT_SEL = '.reader';
const DEFAULT_URL_FILE = 'chapters_urls.txt';

/** 训练学园 官方章节目录（可改为你自己的 /zh-hans/chapters/... 链接） */
const DEFAULT_CHAPTERS_LIST_URL =
  'https://www.book18.org/zh-hans/chapters/%E6%80%A7%E5%A5%B4%E8%AE%AD%E7%BB%83%E5%AD%A6%E5%9B%AD';

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 60000 };

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function isDedicatedChaptersListUrl(url) {
  try {
    return /\/chapters\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function discoverChapters(page, entryUrl) {
  await page.goto(entryUrl, GOTO_OPTS);
  await page.waitForSelector(`${LIST_ITEM_SEL} a`, { timeout: 20000 });
  const skipFirstLi = !isDedicatedChaptersListUrl(entryUrl);
  return page.evaluate(
    ({ itemSel, skipFirst }) => {
      let items = [...document.querySelectorAll(itemSel)];
      if (skipFirst && items.length > 1) items = items.slice(1);
      const out = [];
      const seen = new Set();
      for (const li of items) {
        const a = li.querySelector('a');
        if (!a?.href) continue;
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        out.push({ href: a.href, title: a.textContent.trim() });
      }
      return out;
    },
    { itemSel: LIST_ITEM_SEL, skipFirst: skipFirstLi }
  );
}

async function extractReaderText(page, url) {
  await page.goto(url, GOTO_OPTS);
  await page.waitForSelector(CONTENT_SEL, { timeout: 20000 });
  return page.$eval(CONTENT_SEL, (el) => el.innerText.trim());
}

function resolveUrlFilePath(urlFile) {
  if (path.isAbsolute(urlFile)) return urlFile;
  return path.join(PROJECT_ROOT, urlFile);
}

/** 按 BOM 读取列表文件（兼容 UTF-8 / UTF-16 LE，避免 Windows 记事本另存为 UTF-16 后读成 0 条） */
function readUrlFileSync(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.slice(2).toString('utf16be');
  }
  return buf.toString('utf8');
}

/** 从列表文件正文解析章节 URL（去 BOM、忽略空行与注释行） */
function chaptersFromUrlFileText(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => /^https?:\/\//i.test(l))
    .map((href) => ({ href, title: path.basename(href) }));
}

function extractScrapeFlags(argv) {
  let outputDir = process.env.NOVEL_OUTPUT_DIR?.trim() || 'novel-output';
  let urlFile = process.env.NOVEL_URL_FILE?.trim() || DEFAULT_URL_FILE;
  let mergeTitle = '';
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--out-dir=')) outputDir = a.slice(10).trim();
    else if (a.startsWith('--url-file=')) urlFile = a.slice(11).trim();
    else if (a.startsWith('--merge-title=')) mergeTitle = a.slice(14).trim();
    else rest.push(a);
  }
  return { outputDir, urlFile, mergeTitle, restArgv: rest };
}

async function main() {
  const { outputDir, urlFile, mergeTitle, restArgv } = extractScrapeFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');

  const runMerge = restArgv.includes('--merge');
  const useFileOnly = restArgv.includes('--file');
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let chapters;
  const envListUrl = process.env.BOOK18_CHAPTERS_URL?.trim();
  const discoverUrl = useFileOnly ? null : entryUrl || envListUrl || null;

  if (useFileOnly) {
    const urlFileAbs = resolveUrlFilePath(urlFile);
    if (!fs.existsSync(urlFileAbs)) {
      console.error(`已指定 --file，但未找到 URL 列表文件: ${urlFileAbs}`);
      process.exit(1);
    }
    chapters = chaptersFromUrlFileText(readUrlFileSync(urlFileAbs));
    console.log(`从 ${urlFileAbs} 读取 ${chapters.length} 个 URL`);
  } else if (discoverUrl) {
    console.log('从目录页发现章节:', discoverUrl);
    chapters = await discoverChapters(page, discoverUrl);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);
  } else if (fs.existsSync(resolveUrlFilePath(urlFile))) {
    const urlFileAbs = resolveUrlFilePath(urlFile);
    chapters = chaptersFromUrlFileText(readUrlFileSync(urlFileAbs));
    console.log(`从 ${urlFileAbs} 读取 ${chapters.length} 个 URL`);
  } else {
    console.log('未传 URL、未设置 BOOK18_CHAPTERS_URL，且缺少 URL 列表文件，使用默认章节目录页');
    chapters = await discoverChapters(page, DEFAULT_CHAPTERS_LIST_URL);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);
  }

  if (Number.isFinite(maxChapters) && maxChapters > 0) {
    chapters = chapters.slice(0, maxChapters);
    console.log(`限制为前 ${maxChapters} 章`);
  }

  const total = chapters.length;
  if (total === 0) {
    await browser.close();
    console.error(
      '未得到任何章节 URL。使用 --file 时请确认列表文件位于项目根目录（或传绝对路径），且每行为以 http(s) 开头的链接。'
    );
    process.exit(1);
  }

  for (let i = 0; i < total; i++) {
    const { href, title } = chapters[i];
    const id = path.basename(new URL(href).pathname);
    const namePart = sanitizeFilePart(title) || id;
    const fileName = `${String(i + 1).padStart(3, '0')}_${namePart}.txt`;
    const outPath = path.join(chaptersDir, fileName);

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 100) {
      console.log(`[${i + 1}/${total}] 跳过（已存在） ${fileName}`);
      continue;
    }

    process.stdout.write(`[${i + 1}/${total}] ${id} … `);
    try {
      const text = await extractReaderText(page, href);
      fs.writeFileSync(outPath, `${title}\n\n${text}`, 'utf8');
      console.log(`ok (${text.length} 字)`);
    } catch (e) {
      console.log(`失败: ${e.message}`);
    }
  }

  await browser.close();
  console.log('完成，输出目录:', path.resolve(outputDir));

  if (runMerge) {
    const { mergeNovel } = require(MERGE_NOVEL);
    mergeNovel({
      inputDir: outputDir,
      ...(mergeTitle ? { bookTitle: mergeTitle } : {}),
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
