/**
 * xbiquge345.com（笔趣阁小说网）工作流：
 * 1) 传入书籍目录 URL：`https://www.xbiquge345.com/book/{bookId}/`
 * 2) 目录：`div.border ul.info a` 单页全量章节，DOM 顺序即阅读顺序（第1章 → 第N章）；
 *    章节链接形如 `/chapter/{bookId}/{章节id}.html`
 * 3) 正文：`div#txt`，每章单页（无章内分页）；段首为全角空格缩进，顶部有一行
 *    「一秒记住【笔趣阁小说网】xbiquge345.com，更新快，无弹窗！」广告提示
 *
 * 用法：
 *   node gaode/xbiquge345/scrape-xbiquge345.js https://www.xbiquge345.com/book/80767/
 *   node gaode/xbiquge345/scrape-xbiquge345.js https://www.xbiquge345.com/book/80767/ 5
 * --out-dir= --merge --merge-title= 同其他 scraper
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  sanitizeFilePart,
  isTransientNavError,
  extractFlags,
  useHeadedLaunch,
  appendFailureLog,
} = require(path.join(__dirname, '..', 'lib', 'scraper-common.js'));

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 60000 };
const CATALOG_SEL = 'div.border ul.info a';
const CONTENT_SEL = '#txt';
const MIN_BODY_CHARS = 40;

/** 正文清洗：去段首全角空格缩进，剔除顶部「一秒记住…无弹窗」等广告行 */
const AD_RE = /一秒记住.*笔趣阁|笔趣阁小说网.*(?:更新快|无弹窗)|请记住本站|请收藏本站|更新最快.*笔趣阁|无弹窗.*阅读/i;

function cleanBodyText(raw) {
  const lines = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim()) // 去掉段首全角空格缩进（　 亦被 trim 处理）
    .filter((l) => l && !AD_RE.test(l));
  return lines.join('\n').trim();
}

/** 从 /book/{bookId}/ → { origin, bookId, catalogUrl } */
function parseEntryUrl(entryUrl) {
  const u = new URL(entryUrl);
  const m = u.pathname.match(/^\/book\/(\d+)\/?$/i);
  if (!m) throw new Error(`非 xbiquge345 书籍目录 URL（需 /book/{bookId}/）: ${entryUrl}`);
  return { origin: u.origin, bookId: m[1], catalogUrl: `${u.origin}/book/${m[1]}/` };
}

// --- Catalog ---

async function catalogReadyProbe(page, loc) {
  try {
    return await page.evaluate(
      ({ origin, bookId }) => {
        const re = new RegExp(`^/chapter/${bookId}/\\d+\\.html$`, 'i');
        const hit = [...document.querySelectorAll('a[href]')].some((a) => {
          try { return re.test(new URL(a.getAttribute('href') || '', origin).pathname); }
          catch { return false; }
        });
        return hit ? { ok: true } : { ok: false, reason: 'no_chapter_links' };
      },
      { origin: loc.origin, bookId: loc.bookId }
    );
  } catch (e) {
    if (isTransientNavError(e)) return { ok: false, reason: 'navigating' };
    throw e;
  }
}

async function waitForCatalogReady(page, loc, timeoutMs) {
  const timeout = timeoutMs || 60000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const probe = await catalogReadyProbe(page, loc);
    if (probe.ok) return;
    if (probe.reason === 'navigating') await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
  }
  throw new Error(`[xbiquge345] 目录等待超时（title=${(await page.title().catch(() => '')).slice(0, 80)}）`);
}

async function extractChapterLinks(page, loc) {
  // 优先 `div.border ul.info`；为空时回退整页扫描（去重、按 DOM 顺序）
  return page.evaluate(
    ({ origin, bookId }) => {
      const re = new RegExp(`^/chapter/${bookId}/\\d+\\.html$`, 'i');
      const pushValid = (arr, a) => {
        let href = a.getAttribute('href') || '';
        if (/^javascript:/i.test(href)) return;
        let abs, p;
        try { abs = new URL(href, origin).href; p = new URL(abs).pathname; }
        catch { return; }
        if (!re.test(p)) return;
        const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (title && !/上一章|下一章|目录|返回/.test(title)) arr.push({ href: abs, title });
      };
      const dedupe = (arr) => {
        const seen = new Set();
        return arr.filter((x) => (seen.has(x.href) ? false : (seen.add(x.href), true)));
      };

      let main = [];
      const listEl = document.querySelector('div.border ul.info');
      if (listEl) {
        for (const a of listEl.querySelectorAll('a[href]')) pushValid(main, a);
      }
      main = dedupe(main);
      if (main.length === 0) {
        const fb = [];
        for (const a of document.querySelectorAll('a[href]')) pushValid(fb, a);
        main = dedupe(fb);
      }
      return main;
    },
    { origin: loc.origin, bookId: loc.bookId }
  );
}

async function discoverChapters(page, entryUrl) {
  const loc = parseEntryUrl(entryUrl);
  console.log(`[xbiquge345] 打开: ${loc.catalogUrl}`);
  await page.goto(loc.catalogUrl, GOTO_OPTS);
  await waitForCatalogReady(page, loc);

  const chapters = await extractChapterLinks(page, loc);
  console.log(`[xbiquge345] 目录共 ${chapters.length} 章`);
  return chapters;
}

// --- Chapter body ---

async function chapterTextReady(page) {
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').trim().length > 40) return { ok: true };
      return { ok: false, reason: 'no_body' };
    }, CONTENT_SEL);
  } catch (e) {
    if (isTransientNavError(e)) return { ok: false, reason: 'navigating' };
    throw e;
  }
}

async function waitForChapterText(page, phase, timeoutMs) {
  const timeout = timeoutMs || 30000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const probe = await chapterTextReady(page);
    if (probe.ok) return;
    if (probe.reason === 'navigating') await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
  }
  throw new Error(`[xbiquge345] ${phase} 正文等待超时（title=${(await page.title().catch(() => '')).slice(0, 80)}）`);
}

async function extractChapterText(page, chapterUrl) {
  await page.goto(chapterUrl, GOTO_OPTS);
  await waitForChapterText(page, `正文 ${chapterUrl}`);
  const raw = await page.$eval(CONTENT_SEL, (el) => el.innerText).catch(() => '');
  const text = cleanBodyText(raw);
  if (text.length < MIN_BODY_CHARS) throw new Error(`正文过短 (${text.length} 字): ${chapterUrl}`);
  return text;
}

// --- Main ---

async function main() {
  const { outputDir, mergeTitle, restArgv } = extractFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');

  const runMerge = restArgv.includes('--merge');
  const forceChapters = restArgv.includes('--force') || process.env.XBIQUGE345_FORCE === '1';
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  const headed = useHeadedLaunch({ envKey: 'XBIQUGE345_HEADED' });
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();

  const failureLogPath = path.join(outputDir, 'xbiquge345_failures.jsonl');

  let chapters;
  if (entryUrl) {
    console.log('[xbiquge345] 从书籍目录页发现章节:', entryUrl);
    chapters = await discoverChapters(page, entryUrl);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);
  } else {
    console.error('请传入书籍目录 URL，例如: node gaode/xbiquge345/scrape-xbiquge345.js https://www.xbiquge345.com/book/80767/');
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
    console.error('未得到任何章节 URL');
    process.exit(1);
  }

  for (let i = 0; i < total; i++) {
    const { href, title } = chapters[i];
    const id = path.basename(new URL(href).pathname).replace(/\.html$/, '');
    const namePart = sanitizeFilePart(title) || id;
    const fileName = `${String(i + 1).padStart(3, '0')}_${namePart}.txt`;
    const outPath = path.join(chaptersDir, fileName);

    if (!forceChapters && fs.existsSync(outPath) && fs.statSync(outPath).size > 100) {
      console.log(`[${i + 1}/${total}] 跳过（已存在） ${fileName}`);
      continue;
    }

    process.stdout.write(`[${i + 1}/${total}] ${id} … `);
    try {
      const text = await extractChapterText(page, href);
      fs.writeFileSync(outPath, `${title}\n\n${text}`, 'utf8');
      console.log(`ok (${text.length} 字)`);
    } catch (e) {
      const errMsg = e?.message || String(e);
      console.log(`失败: ${errMsg}`);
      console.error(`[xbiquge345] 章节抓取失败 index=${i + 1}/${total} title=${title} href=${href} error=${errMsg}`);
      appendFailureLog(failureLogPath, {
        at: new Date().toISOString(), index: i + 1, title, href, error: errMsg,
      });
    }
  }

  await browser.close();
  console.log('完成，输出目录:', path.resolve(outputDir));

  if (runMerge) {
    const { mergeNovel } = require(MERGE_NOVEL);
    mergeNovel({ inputDir: outputDir, ...(mergeTitle ? { bookTitle: mergeTitle } : {}) });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
