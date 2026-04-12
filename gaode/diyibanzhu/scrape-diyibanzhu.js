/**
 * diyibanzhu.quest（第一版主网）工作流：
 * 1) 传入书籍目录 URL（/list/{id}.html），按「章节列表」区块解析章节链接；目录多页时跟随站内「下页」
 * 2) 逐章打开阅读页，从 #nr1 提取正文（#ChapterView .page-content）
 *
 * 用法：
 *   node gaode/diyibanzhu/scrape-diyibanzhu.js https://www.diyibanzhu.quest/list/24595.html
 *   node gaode/diyibanzhu/scrape-diyibanzhu.js https://www.diyibanzhu.quest/list/24595.html 5
 * 不传参数时：优先环境变量 DIYIBANZHU_CHAPTERS_URL；否则使用脚本内默认目录页。
 * --out-dir=书籍根目录  --merge  --merge-title=书名
 * --file / --url-file=  与 book18 相同，可从本地章节 URL 列表抓取
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const CONTENT_SEL = '#nr1';
const DEFAULT_URL_FILE = 'chapters_urls.txt';

/** 默认目录页（可改为任意 /list/{id}.html） */
const DEFAULT_CHAPTERS_LIST_URL = 'https://www.diyibanzhu.quest/list/24595.html';

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 60000 };

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** 从 /list/24595.html 或 /list/24595_34_2.html 取书籍数字 id */
function bookIdFromListUrl(listUrl) {
  try {
    const m = String(new URL(listUrl).pathname).match(/\/list\/(\d+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

async function extractChapterListFromPage(page) {
  return page.evaluate(() => {
    const h4s = [...document.querySelectorAll('h4')];
    /** 与「最新章节」区分：标题含「章节列表」（版面为 .mod 内 .hd>h4 + 同 .mod 下 ul.list） */
    const h = h4s.find((el) => /章节列表/.test(el.textContent || ''));
    if (!h) return { ok: false, reason: 'no_chapter_list_h4', links: [] };
    const mod = h.closest('.mod');
    if (!mod) return { ok: false, reason: 'no_mod', links: [] };
    const ul = mod.querySelector('ul.list, ul');
    if (!ul) return { ok: false, reason: 'no_ul_in_mod', links: [] };
    const out = [];
    const seen = new Set();
    for (const a of ul.querySelectorAll('a[href*="/view/"]')) {
      const href = a.href;
      if (!href || seen.has(href)) continue;
      if (/\/view\/[^/]*_start\.html/i.test(href)) continue;
      if (/从头开始/.test(a.textContent || '')) continue;
      seen.add(href);
      out.push({ href, title: (a.textContent || '').trim() });
    }
    return { ok: true, links: out };
  });
}

async function findNextListPageUrl(page, bookId) {
  if (!bookId) return null;
  return page.evaluate((bid) => {
    const links = [...document.querySelectorAll('a')];
    for (const a of links) {
      const t = (a.textContent || '').trim();
      if (t !== '下页' && t !== '下一页') continue;
      const href = a.getAttribute('href') || '';
      if (!href.includes('/list/')) continue;
      if (!href.includes(bid)) continue;
      try {
        return new URL(a.href, location.origin).href;
      } catch {
        continue;
      }
    }
    return null;
  }, bookId);
}

async function discoverChapters(page, entryUrl) {
  const bookId = bookIdFromListUrl(entryUrl);
  const seenListUrls = new Set();
  const byHref = new Map();
  const ordered = [];

  let listUrl = entryUrl;
  while (listUrl) {
    if (seenListUrls.has(listUrl)) break;
    seenListUrls.add(listUrl);

    await page.goto(listUrl, GOTO_OPTS);
    await page.waitForSelector('h4', { timeout: 25000 });

    const chunk = await extractChapterListFromPage(page);
    if (!chunk.ok) {
      console.warn(`目录页解析: ${listUrl} → ${chunk.reason}，本页 0 条`);
    }
    for (const { href, title } of chunk.links) {
      if (byHref.has(href)) continue;
      byHref.set(href, title);
      ordered.push({ href, title });
    }

    const nextList = await findNextListPageUrl(page, bookId);
    if (!nextList || seenListUrls.has(nextList)) break;
    listUrl = nextList;
  }

  return ordered;
}

async function extractChapterPlainText(page, url) {
  await page.goto(url, GOTO_OPTS);
  await page.waitForSelector(CONTENT_SEL, { timeout: 25000 });
  return page.$eval(CONTENT_SEL, (el) => el.innerText.trim());
}

function resolveUrlFilePath(urlFile) {
  if (path.isAbsolute(urlFile)) return urlFile;
  return path.join(PROJECT_ROOT, urlFile);
}

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
  const envListUrl = process.env.DIYIBANZHU_CHAPTERS_URL?.trim();
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
    console.log('未传 URL、未设置 DIYIBANZHU_CHAPTERS_URL，且缺少 URL 列表文件，使用默认章节目录页');
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
      '未得到任何章节 URL。请确认目录页含「章节列表」标题，或使用 --file 提供章节 URL 列表。'
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
      const text = await extractChapterPlainText(page, href);
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
