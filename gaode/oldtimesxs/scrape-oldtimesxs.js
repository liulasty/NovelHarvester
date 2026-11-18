/**
 * oldtimesxs.com（旧时光文学）工作流：
 * 1) 目录分两部分，脚本按阅读顺序拼接：
 *    - 总览页 `/go/{bookId}/` 的 `#list-chapterAll`：前 100 条（楔子、第1章、…）
 *    - 分页目录 `/go/{bookId}/{n}/` 的 `dl.book.chapterlist > div dd a`：后续章节
 *      （页面头部另有「最新章」「开始阅读」链接，不在该 div 内，天然排除）
 *    每页的「下一页」若不指向更多目录页（回落到总览）则停止。
 * 2) 正文：`#txt`（`<p>` 段落）。
 *    章节可有多屏：`{chapterId}.html` → `{chapterId}_1.html` → …
 *    **注意**：不存在的 `_N.html` 会回落到第 1 屏（不是 404），
 *    因此必须跟随页面「下一章」链接，且仅当其仍指向同一 `chapterId` 的更大页码时才继续。
 *
 * 用法：
 *   node gaode/oldtimesxs/scrape-oldtimesxs.js https://www.oldtimesxs.com/go/185033/
 *   node gaode/oldtimesxs/scrape-oldtimesxs.js https://www.oldtimesxs.com/go/185033/48699300.html 3
 * --out-dir= --merge --merge-title= --force 同其他 scraper
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
const OVERVIEW_LIST_SEL = '#list-chapterAll dd a';
const PAGED_LIST_SEL = 'dl.book.chapterlist > div dd a';
const CONTENT_SEL = '#txt';
const MIN_BODY_CHARS = 40;
const MAX_CATALOG_PAGES = 200;
const MAX_CHAPTER_PAGES = 50;
const NAV_TITLE_RE = /开始阅读|上一章|下一章|上一页|下一页|目录|首页|书架|排行/;
const NOISE_LINE_RE = /旧时光文学|oldtimesxs\.com|记住本站|浏览器阅读模式|本章未完.{0,8}下一页/;

/** `/go/{bookId}/...` → { origin, bookId } */
function parseBookTarget(entryUrl) {
  const u = new URL(entryUrl);
  const m = u.pathname.match(/^\/go\/(\d+)(?:\/|$)/);
  if (!m) throw new Error(`非 oldtimesxs 书籍 URL（需 /go/{bookId}/...）: ${entryUrl}`);
  return { origin: u.origin, bookId: m[1] };
}

/** 章节 URL → { bookId, chapterId, page }；page 为 0 表示首屏（无 `_N` 后缀） */
function parseChapterUrl(url) {
  let p;
  try {
    p = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = p.match(/^\/go\/(\d+)\/(\d+)(?:_(\d+))?\.html$/);
  if (!m) return null;
  return { bookId: m[1], chapterId: m[2], page: m[3] ? parseInt(m[3], 10) : 0 };
}

// --- Catalog ---

async function waitForLinks(page, sel, timeoutMs) {
  const start = Date.now();
  const timeout = timeoutMs || 30000;
  while (Date.now() - start < timeout) {
    try {
      const n = await page.$$eval(sel, (els) => els.length).catch(() => 0);
      if (n > 0) return true;
    } catch (e) {
      if (!isTransientNavError(e)) throw e;
    }
    await page.waitForTimeout(800);
  }
  return false;
}

async function extractCatalogLinks(page, { origin, bookId }, sel) {
  return page.evaluate(
    ({ sel, origin, bookId, navRe }) => {
      const chapterRe = new RegExp(`^/go/${bookId}/\\d+\\.html$`);
      const nav = new RegExp(navRe);
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll(sel)) {
        const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title || nav.test(title)) continue;
        let abs, p;
        try {
          abs = new URL(a.getAttribute('href') || '', origin).href;
          p = new URL(abs).pathname;
        } catch {
          continue;
        }
        if (!chapterRe.test(p) || seen.has(abs)) continue;
        seen.add(abs);
        out.push({ href: abs, title });
      }
      return out;
    },
    { sel, origin, bookId, navRe: NAV_TITLE_RE.source }
  );
}

async function nextCatalogHref(page) {
  return page.evaluate(() => {
    const a = [...document.querySelectorAll('.page_num a[href], a[href]')].find(
      (el) => /下一页/.test((el.textContent || '').trim())
    );
    return a ? a.href : null;
  });
}

async function discoverChapters(page, entryUrl) {
  const loc = parseBookTarget(entryUrl);
  const chapters = [];
  const seen = new Set();
  const push = (rows) => {
    let fresh = 0;
    for (const r of rows) {
      if (seen.has(r.href)) continue;
      seen.add(r.href);
      chapters.push(r);
      fresh++;
    }
    return fresh;
  };

  const overview = `${loc.origin}/go/${loc.bookId}/`;
  await page.goto(overview, GOTO_OPTS);
  if (!(await waitForLinks(page, OVERVIEW_LIST_SEL, 30000))) {
    throw new Error(`[oldtimesxs] 总览目录未出现章节链接: ${overview}`);
  }
  const n0 = push(await extractCatalogLinks(page, loc, OVERVIEW_LIST_SEL));
  console.log(`[oldtimesxs] 总览页: ${n0} 章（累计 ${chapters.length}）`);

  for (let n = 1; n <= MAX_CATALOG_PAGES; n++) {
    const url = `${loc.origin}/go/${loc.bookId}/${n}/`;
    await page.goto(url, GOTO_OPTS);
    if (!(await waitForLinks(page, PAGED_LIST_SEL, 15000))) break;

    const fresh = push(await extractCatalogLinks(page, loc, PAGED_LIST_SEL));
    console.log(`[oldtimesxs] 目录第 ${n} 页: ${fresh} 章（累计 ${chapters.length}）`);
    if (fresh === 0) break;

    const next = await nextCatalogHref(page);
    if (!next) break;
    const nextPath = new URL(next, loc.origin).pathname;
    if (nextPath === `/go/${loc.bookId}/`) break;
  }

  console.log(`[oldtimesxs] 目录共 ${chapters.length} 章`);
  return chapters;
}

// --- Chapter body ---

function cleanBodyText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE_LINE_RE.test(l))
    .join('\n')
    .trim();
}

async function waitForChapterBody(page, timeoutMs) {
  const start = Date.now();
  const timeout = timeoutMs || 30000;
  while (Date.now() - start < timeout) {
    try {
      const ok = await page.$eval(CONTENT_SEL, (el) => (el.innerText || '').trim().length > 20).catch(() => false);
      if (ok) return true;
    } catch (e) {
      if (!isTransientNavError(e)) throw e;
    }
    await page.waitForTimeout(800);
  }
  return false;
}

async function readChapterPage(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const next = [...document.querySelectorAll('a[href]')].find((a) =>
      /^下一章/.test((a.textContent || '').trim())
    );
    return {
      text: el ? el.innerText : '',
      nextHref: next ? next.href : null,
    };
  }, CONTENT_SEL);
}

async function extractChapterText(page, chapterUrl) {
  const startInfo = parseChapterUrl(chapterUrl);
  if (!startInfo) throw new Error(`[oldtimesxs] 非法章节 URL: ${chapterUrl}`);
  const base = startInfo;

  const parts = [];
  const visited = new Set();
  let url = chapterUrl;

  for (let i = 0; i < MAX_CHAPTER_PAGES; i++) {
    const cur = parseChapterUrl(url);
    if (!cur || cur.bookId !== base.bookId || cur.chapterId !== base.chapterId) break;
    if (visited.has(cur.page)) break;
    visited.add(cur.page);

    await page.goto(url, GOTO_OPTS);
    if (!(await waitForChapterBody(page, 30000))) {
      throw new Error(`[oldtimesxs] 正文等待超时: ${url}`);
    }
    const { text, nextHref } = await readChapterPage(page);
    const cleaned = cleanBodyText(text);
    if (cleaned) parts.push(cleaned);

    if (!nextHref) break;
    const nxt = parseChapterUrl(nextHref);
    if (!nxt || nxt.bookId !== base.bookId || nxt.chapterId !== base.chapterId) break;
    if (nxt.page <= cur.page) break;
    url = nextHref;
  }

  const body = parts.join('\n\n').trim();
  if (body.length < MIN_BODY_CHARS) {
    throw new Error(`正文过短 (${body.length} 字): ${chapterUrl}`);
  }
  return body;
}

// --- Main ---

async function main() {
  const { outputDir, mergeTitle, restArgv } = extractFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');

  const runMerge = restArgv.includes('--merge');
  const forceChapters = restArgv.includes('--force') || process.env.OLDTIMESXS_FORCE === '1';
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  if (!entryUrl) {
    console.error('请传入书籍 URL，例如: node gaode/oldtimesxs/scrape-oldtimesxs.js https://www.oldtimesxs.com/go/185033/');
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  const headed = useHeadedLaunch({ envKey: 'OLDTIMESXS_HEADED' });
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();

  const failureLogPath = path.join(outputDir, 'oldtimesxs_failures.jsonl');

  console.log('[oldtimesxs] 从目录页发现章节:', entryUrl);
  let chapters = await discoverChapters(page, entryUrl);
  fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
  console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);

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
      console.error(`[oldtimesxs] 章节抓取失败 index=${i + 1}/${total} title=${title} href=${href} error=${errMsg}`);
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

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { discoverChapters, extractChapterText, parseChapterUrl, cleanBodyText };
