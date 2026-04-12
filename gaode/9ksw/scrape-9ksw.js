/**
 * 9ksw.com（九库书屋）书籍章节列表页：
 * - 入口：`https://9ksw.com/novel{数字}/`（可带 `?p=2` 等，脚本会规范到书籍根并从第 1 页爬分页）
 * - 目录：每页 `#new-chapter` 内约 6 条「最新章节」；`#list-chapter` 内全书目录约 50 条/页。
 *   分页：`/novel{id}/?p=2` … 由 `#pagination` 解析最大页码，逐页合并。
 * - 正文：`#chapter-content` 由页内脚本 POST `/conapi.php` 注入，需等待加载完成后再取文本。
 *
 * 用法：
 *   node gaode/9ksw/scrape-9ksw.js https://9ksw.com/novel45382/
 *   node gaode/9ksw/scrape-9ksw.js https://9ksw.com/novel45382/ 5
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 90000 };

function titleLooksLikeChapterHeading(title) {
  return /第\s*(?:\d+|[零一二三四五六七八九十百千万两廿卅]+)\s*章|间章/.test(String(title || ''));
}

/** 按分页 DOM 顺序保留全书列表；用「最新章节」区链接的 title 覆盖同名 href（通常更完整）。 */
function merge9kswChapterLists(mainRowsInOrder, latestRows) {
  const titleByHref = new Map(mainRowsInOrder.map((r) => [r.href, r.title]));
  for (const r of latestRows) {
    if (titleLooksLikeChapterHeading(r.title)) titleByHref.set(r.href, r.title);
  }
  const ordered = mainRowsInOrder.map((r) => ({
    href: r.href,
    title: titleByHref.get(r.href) || r.title,
  }));
  const seen = new Set(ordered.map((r) => r.href));
  const tail = [];
  for (const r of latestRows) {
    if (seen.has(r.href)) continue;
    seen.add(r.href);
    tail.push({ href: r.href, title: r.title });
  }
  return [...ordered, ...tail];
}

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function parseNovelListUrl(entryUrl) {
  const u = new URL(entryUrl);
  const m = u.pathname.match(/^\/(novel\d+)\/?$/i);
  if (!m) {
    throw new Error(`非九库书籍章节列表路径（需 /novel数字/）：${entryUrl}`);
  }
  const slug = m[1].toLowerCase();
  return { origin: u.origin, slug, catalogPath: `/${slug}/` };
}

function catalogPageUrl(loc, pageNum) {
  const base = `${loc.origin}${loc.catalogPath}`;
  if (!pageNum || pageNum <= 1) return base;
  const u = new URL(base);
  u.searchParams.set('p', String(pageNum));
  return u.href;
}

function extractScrapeFlags(argv) {
  let outputDir = process.env.NOVEL_OUTPUT_DIR?.trim() || 'novel-output';
  let urlFile = process.env.NOVEL_URL_FILE?.trim() || 'chapters_urls.txt';
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

function stripAdLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (/请记住本书|最新章节.*首发|手机阅读|章节错误|报错欠更|本站永久域名|请加入收藏|更多精彩小说|永久地址/i.test(s)) {
        return false;
      }
      return true;
    })
    .join('\n')
    .trim();
}

async function extractChapterSectionsOnePage(page, loc) {
  return page.evaluate(
    ({ origin, slug }) => {
      const chapterPathRe = new RegExp(`^/${slug}/chapter\\d+\\.html$`, 'i');

      function pushValid(arr, a) {
        let href = a.getAttribute('href') || '';
        if (/^javascript:/i.test(href)) return;
        let abs;
        try {
          abs = new URL(href, origin).href;
        } catch {
          return;
        }
        let p = '';
        try {
          p = new URL(abs).pathname;
        } catch {
          return;
        }
        if (!chapterPathRe.test(p)) return;
        const title =
          (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim() ||
          p.split('/').pop();
        arr.push({ href: abs, title });
      }

      const dedupe = (arr) => {
        const seen = new Set();
        return arr.filter((x) => {
          if (seen.has(x.href)) return false;
          seen.add(x.href);
          return true;
        });
      };

      const latest = [];
      const newBox = document.querySelector('#new-chapter');
      if (newBox) {
        for (const a of newBox.querySelectorAll('ul.list-chapter a[href]')) pushValid(latest, a);
      }

      const main = [];
      const listBox = document.querySelector('#list-chapter');
      if (listBox) {
        for (const a of listBox.querySelectorAll('ul.list-chapter a[href]')) pushValid(main, a);
      }

      return { main: dedupe(main), latest: dedupe(latest) };
    },
    { origin: loc.origin, slug: loc.slug }
  );
}

async function readMaxCatalogPage(page) {
  return page.evaluate(() => {
    let max = 1;
    const nav = document.querySelector('#pagination');
    if (!nav) return max;
    for (const a of nav.querySelectorAll('a[href*="?p="]')) {
      try {
        const u = new URL(a.getAttribute('href') || '', location.origin);
        const p = parseInt(u.searchParams.get('p') || '1', 10);
        if (Number.isFinite(p) && p > max) max = p;
      } catch {
        /* ignore */
      }
    }
    return max;
  });
}

async function discoverChapters(page, entryUrl) {
  const loc = parseNovelListUrl(entryUrl);

  const firstUrl = catalogPageUrl(loc, 1);
  console.log(`[9ksw] 打开: ${firstUrl}`);
  await page.goto(firstUrl, GOTO_OPTS);
  await page.waitForSelector('#list-chapter, #new-chapter', { timeout: 60000 });

  const maxPage = await readMaxCatalogPage(page);
  console.log(`[9ksw] 分页: 共 ${maxPage} 页（#pagination ?p=）`);

  const mainAccum = [];

  const chunk0 = await extractChapterSectionsOnePage(page, loc);
  const latestFromFirstPage = chunk0.latest;
  for (const r of chunk0.main) mainAccum.push(r);

  console.log(
    `[9ksw] 第 1 页: 全书区 ${chunk0.main.length} 条, 最新区 ${chunk0.latest.length} 条`
  );

  for (let p = 2; p <= maxPage; p++) {
    const url = catalogPageUrl(loc, p);
    console.log(`[9ksw] 打开: ${url}`);
    await page.goto(url, GOTO_OPTS);
    await page.waitForSelector('#list-chapter', { timeout: 60000 });
    const chunk = await extractChapterSectionsOnePage(page, loc);
    for (const r of chunk.main) mainAccum.push(r);
    console.log(`[9ksw] 第 ${p} 页: 全书区 ${chunk.main.length} 条`);
  }

  const seenHref = new Set();
  const mainDeduped = [];
  for (const r of mainAccum) {
    if (seenHref.has(r.href)) continue;
    seenHref.add(r.href);
    mainDeduped.push(r);
  }

  const merged = merge9kswChapterLists(mainDeduped, latestFromFirstPage);
  console.log(`[9ksw] 合并后共 ${merged.length} 章（全书区顺序 + 最新区标题/补尾）`);
  return merged;
}

async function extractChapterPlainText(page, chapterUrl) {
  const apiDone = page
    .waitForResponse((r) => /conapi\.php/i.test(r.url()), { timeout: 60000 })
    .catch(() => null);
  await page.goto(chapterUrl, GOTO_OPTS);
  await page.waitForSelector('#chapter-content', { timeout: 45000 });
  const apiResp = await apiDone;
  if (!apiResp) {
    console.warn('[9ksw] 未捕获 conapi.php 响应，改以正文节点轮询');
  }
  await page.waitForFunction(
    () => {
      const el = document.getElementById('chapter-content');
      if (!el) return false;
      const t = (el.innerText || '').trim();
      return t.length > 60 && !/正在加载|加载中/.test(t);
    },
    { timeout: 90000 }
  );
  const raw = await page.$eval('#chapter-content', (el) => el.innerText.trim());
  return stripAdLines(raw);
}

async function main() {
  const { outputDir, urlFile, mergeTitle, restArgv } = extractScrapeFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');

  const runMerge = restArgv.includes('--merge');
  const forceChapters = restArgv.includes('--force') || process.env.N9KSW_FORCE === '1';
  const useFileOnly = restArgv.includes('--file');
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  if (forceChapters) {
    console.log('[9ksw] --force：将覆盖已存在且大于 100 字节的章节 txt');
  }

  const headless = process.env.NOVEL_HEADLESS !== '0';
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  let chapters;
  const envListUrl = process.env.N9KSW_CHAPTERS_URL?.trim();
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
    console.log('从书籍章节列表页发现章节:', discoverUrl);
    chapters = await discoverChapters(page, discoverUrl);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);
  } else if (fs.existsSync(resolveUrlFilePath(urlFile))) {
    const urlFileAbs = resolveUrlFilePath(urlFile);
    chapters = chaptersFromUrlFileText(readUrlFileSync(urlFileAbs));
    console.log(`从 ${urlFileAbs} 读取 ${chapters.length} 个 URL`);
  } else {
    console.error('请传入书籍页 URL，例如: node gaode/9ksw/scrape-9ksw.js https://9ksw.com/novel45382/');
    await browser.close();
    process.exit(1);
  }

  if (Number.isFinite(maxChapters) && maxChapters > 0) {
    chapters = chapters.slice(0, maxChapters);
    console.log(`限制为前 ${maxChapters} 章`);
  }

  const total = chapters.length;
  if (total === 0) {
    await browser.close();
    console.error('未得到任何章节 URL。');
    process.exit(1);
  }

  for (let i = 0; i < total; i++) {
    const { href, title } = chapters[i];
    const id = path.basename(new URL(href).pathname);
    const namePart = sanitizeFilePart(title) || id;
    const fileName = `${String(i + 1).padStart(3, '0')}_${namePart}.txt`;
    const outPath = path.join(chaptersDir, fileName);

    if (!forceChapters && fs.existsSync(outPath) && fs.statSync(outPath).size > 100) {
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
