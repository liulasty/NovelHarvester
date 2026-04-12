/**
 * 69xku.com（69库）书籍页目录：
 * 1) 传入书籍页：`https://69xku.com/book/{书籍数字}/`
 * 2) 目录：`dl.book.chapterlist > dd > a` 为「最新章节」区块；`#list-chapterAll dd > a` 为「全部章节目录」。
 *    合并规则与 bookszw 类似：正文区按章号排序；仅出现在最新区且不在全书的链接排在 manifest 末尾。
 * 3) 正文：`#rtext` / `.readcontent`（在 `#acontent` 内）
 *
 * 遇 Cloudflare / 人机验证：无头模式易被拦。请使用有头浏览器或已保存的登录态：
 *   CMD: set NOVEL_HEADLESS=0
 *   PowerShell: $env:NOVEL_HEADLESS = "0"
 *   或 set X69KU_HEADED=1 / $env:X69KU_HEADED = "1"
 * 可选：X69KU_STORAGE_STATE=路径 → playwright storageState JSON
 * 可选：X69KU_CHALLENGE_TIMEOUT_MS（默认 120000）目录/正文等待验证通过的最长时间
 *
 * 用法：
 *   node gaode/69xku/scrape-69xku.js https://69xku.com/book/49851/
 *   node gaode/69xku/scrape-69xku.js https://69xku.com/book/49851/ 5
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { chineseNumeralToInt } = require(path.join(__dirname, '..', 'lib', 'chinese-numeral.js'));

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 120000 };
const GOTO_FALLBACK_OPTS = { waitUntil: 'load', timeout: 120000 };
const CONTENT_SELECTORS = ['#rtext', '.readcontent', '#acontent', '#chaptercontent', '#content'];
const MIN_CHAPTER_BODY_CHARS = 40;

function useHeadedLaunch() {
  return process.env.NOVEL_HEADLESS === '0' || process.env.X69KU_HEADED === '1';
}

function resolveStorageStatePath69() {
  const s = process.env.X69KU_STORAGE_STATE?.trim();
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  return path.join(PROJECT_ROOT, s);
}

/** CF 通过后整页跳转时 evaluate 可能落在导航中途 */
function isTransientNavigationEvaluateError(e) {
  const msg = e?.message || String(e);
  return (
    /Execution context was destroyed/i.test(msg) ||
    /Target page, context or browser has been closed/i.test(msg) ||
    /Navigation failed/i.test(msg) ||
    /net::ERR_ABORTED/i.test(msg) ||
    /most likely because of a navigation/i.test(msg)
  );
}

async function gotoWithRetry(page, url, label, primaryOpts) {
  const attempts = [
    () => page.goto(url, primaryOpts),
    () => page.goto(url, GOTO_FALLBACK_OPTS),
    () => page.goto(url, primaryOpts),
  ];
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      await attempts[i]();
      return;
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : String(e);
      const retryable = /ERR_ABORTED|Timeout|timeout|detached|Navigation/i.test(msg);
      if (i < attempts.length - 1 && retryable) {
        console.warn(`[69xku] goto ${label} 重试 (${i + 2}/${attempts.length}): ${msg.slice(0, 140)}`);
        await page.waitForTimeout(1500 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function catalogReadyProbe69(page, loc) {
  try {
    return await page.evaluate(
      ({ origin, bookId }) => {
        const t = document.title || '';
        if (/^Just a moment/i.test(t)) return { ok: false, reason: 'cf_title' };
        const body = document.body?.innerText || '';
        if (/正在进行安全验证|Enable JavaScript and cookies/i.test(body) && !/最新章节|章节目录|全部章节/.test(body)) {
          return { ok: false, reason: 'cf_challenge' };
        }
        const re = new RegExp(`^/book/${bookId}/\\d+\\.html$`, 'i');
        const hit = [...document.querySelectorAll('a[href]')].some((a) => {
          try {
            return re.test(new URL(a.getAttribute('href') || '', origin).pathname);
          } catch {
            return false;
          }
        });
        return hit ? { ok: true } : { ok: false, reason: 'no_chapter_links' };
      },
      { origin: loc.origin, bookId: loc.bookId }
    );
  } catch (e) {
    if (isTransientNavigationEvaluateError(e)) {
      return { ok: false, reason: 'navigating' };
    }
    throw e;
  }
}

async function waitForCatalogReady69(page, phase, loc) {
  const timeout = parseInt(process.env.X69KU_CHALLENGE_TIMEOUT_MS || '120000', 10);
  const pollMs = 2000;
  const heartbeatSec = 8;
  const start = Date.now();
  let lastBeat = 0;
  let warnedHeadlessCf = false;

  console.log(
    `[69xku] ${phase}: 等待章节链接（最长 ${Math.round(timeout / 1000)}s）。遇验证页请用 NOVEL_HEADLESS=0 完成人机校验。`
  );

  while (Date.now() - start < timeout) {
    const probe = await catalogReadyProbe69(page, loc);
    if (probe.ok) return;

    const elapsed = (Date.now() - start) / 1000;
    if (elapsed - lastBeat >= heartbeatSec) {
      lastBeat = elapsed;
      const title = (await page.title().catch(() => '')).slice(0, 70);
      console.log(`[69xku] … 已等待 ${Math.floor(elapsed)}s | ${title || '(no title)'}`);
    }

    if (!warnedHeadlessCf && !useHeadedLaunch() && elapsed > 20 && probe.reason === 'cf_title') {
      warnedHeadlessCf = true;
      console.warn(
        '[69xku] 仍停留在 Cloudflare「Just a moment」；无头模式通常无法通过。请 Ctrl+C 后设置 NOVEL_HEADLESS=0 再运行，或配置 X69KU_STORAGE_STATE。'
      );
    }

    if (probe.reason === 'navigating') {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }

    await page.waitForTimeout(pollMs);
  }

  const title = await page.title().catch(() => '');
  const msg = `[69xku] ${phase} 等待超时（title=${title.slice(0, 80)}）。请 NOVEL_HEADLESS=0 完成验证，或设置 X69KU_STORAGE_STATE。`;
  console.warn(msg);
  throw new Error(msg);
}

async function chapterBodyProbe69(page) {
  try {
    return await page.evaluate(
      ({ selectors, minLen }) => {
        if (/^Just a moment/i.test(document.title || '')) return { ok: false, reason: 'cf_title' };
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && (el.innerText || '').trim().length > minLen) return { ok: true, sel };
        }
        const ac = document.querySelector('#acontent');
        if (ac && (ac.innerText || '').trim().length > minLen) return { ok: true, sel: '#acontent' };
        return { ok: false, reason: 'no_body' };
      },
      { selectors: CONTENT_SELECTORS, minLen: MIN_CHAPTER_BODY_CHARS }
    );
  } catch (e) {
    if (isTransientNavigationEvaluateError(e)) {
      return { ok: false, reason: 'navigating' };
    }
    throw e;
  }
}

async function waitForChapterBody69(page, phase) {
  const timeout = parseInt(process.env.X69KU_CHALLENGE_TIMEOUT_MS || '120000', 10);
  const pollMs = 2000;
  const heartbeatSec = 8;
  const start = Date.now();
  let lastBeat = 0;

  console.log(`[69xku] ${phase}: 等待正文容器（最长 ${Math.round(timeout / 1000)}s）…`);

  while (Date.now() - start < timeout) {
    const probe = await chapterBodyProbe69(page);
    if (probe.ok) return;

    const elapsed = (Date.now() - start) / 1000;
    if (elapsed - lastBeat >= heartbeatSec) {
      lastBeat = elapsed;
      const title = (await page.title().catch(() => '')).slice(0, 70);
      console.log(`[69xku] … 已等待 ${Math.floor(elapsed)}s | ${title || '(no title)'}`);
    }

    if (probe.reason === 'navigating') {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }

    await page.waitForTimeout(pollMs);
  }

  const title = await page.title().catch(() => '');
  const msg = `[69xku] ${phase} 正文等待超时（title=${title.slice(0, 80)}）`;
  console.warn(msg);
  throw new Error(msg);
}

function chapterNumberFromTitle(title) {
  const t = String(title || '').trim();
  const m = t.match(/第\s*(\d+)\s*章/);
  if (m) return parseInt(m[1], 10);
  const mc = t.match(/第\s*([零一二三四五六七八九十百千万两廿卅]+)\s*章/);
  if (mc) {
    const n = chineseNumeralToInt(mc[1]);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  if (/楔子|序章|^序$|前言/.test(t)) return -1;
  if (/番外/.test(t)) return 1e9;
  if (/开始阅读|点我阅读|请先阅读|立即阅读/.test(t)) return 0;
  return null;
}

function titleLooksLikeChapterHeading(title) {
  return /第\s*(?:\d+|[零一二三四五六七八九十百千万两廿卅]+)\s*章/.test(String(title || ''));
}

function merge69xkuChapterLists(mainRows, latestRows) {
  const byHref = new Map();
  for (const r of mainRows) {
    const ex = byHref.get(r.href);
    if (!ex) byHref.set(r.href, { href: r.href, title: r.title, inMain: true, inLatest: false });
    else {
      ex.inMain = true;
      if (titleLooksLikeChapterHeading(r.title)) ex.title = r.title;
    }
  }
  for (const r of latestRows) {
    const ex = byHref.get(r.href);
    if (!ex) byHref.set(r.href, { href: r.href, title: r.title, inMain: false, inLatest: true });
    else ex.inLatest = true;
  }

  const body = [];
  const tail = [];
  for (const x of byHref.values()) {
    const num = chapterNumberFromTitle(x.title);
    const sk = num != null && !Number.isNaN(num) ? num : 1e6;
    const item = { href: x.href, title: x.title, sk };
    if (x.inMain) body.push(item);
    else tail.push(item);
  }
  const cmp = (a, b) => a.sk - b.sk || a.title.localeCompare(b.title, 'zh-Hans-CN');
  body.sort(cmp);
  tail.sort(cmp);
  return [...body, ...tail].map(({ href, title }) => ({ href, title }));
}

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function parseBookEntryUrl(entryUrl) {
  const u = new URL(entryUrl);
  const m = u.pathname.match(/^\/book\/(\d+)\/?$/i);
  if (!m) throw new Error(`非 69xku 书籍页路径（需 /book/数字/）: ${entryUrl}`);
  return { origin: u.origin, bookId: m[1] };
}

function catalogUrl(loc) {
  return `${loc.origin}/book/${loc.bookId}/`;
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

async function extractChapterLinkSections(page, loc) {
  return page.evaluate(
    ({ origin, bookId }) => {
      const chapterPathRe = new RegExp(`^/book/${bookId}/\\d+\\.html$`, 'i');

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
        const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
        arr.push({ href: abs, title: title || p.split('/').pop() });
      }

      const dedupe = (arr) => {
        const seen = new Set();
        return arr.filter((x) => {
          if (seen.has(x.href)) return false;
          seen.add(x.href);
          return true;
        });
      };

      const dl = document.querySelector('dl.book.chapterlist');
      const main = [];
      const latest = [];

      const allBox = document.querySelector('#list-chapterAll');
      if (allBox) {
        for (const a of allBox.querySelectorAll('dd > a[href]')) pushValid(main, a);
      }

      if (dl) {
        for (const dd of dl.querySelectorAll(':scope > dd')) {
          if (dd.classList.contains('visible-xs')) continue;
          for (const a of dd.querySelectorAll('a[href]')) pushValid(latest, a);
        }
      }

      if (main.length === 0 && dl) {
        for (const a of dl.querySelectorAll('dd > a[href]')) {
          if (allBox && allBox.contains(a)) continue;
          pushValid(main, a);
        }
      }

      let outMain = dedupe(main);
      let outLatest = dedupe(latest);
      if (outMain.length === 0 && outLatest.length === 0) {
        const fb = [];
        for (const a of document.querySelectorAll('a[href]')) pushValid(fb, a);
        outMain = dedupe(fb);
      }

      return { main: outMain, latest: outLatest };
    },
    { origin: loc.origin, bookId: loc.bookId }
  );
}

async function discoverChapters(page, entryUrl) {
  const u = new URL(entryUrl);
  const loc = parseBookEntryUrl(u.href);
  const listUrl = catalogUrl(loc);

  console.log(`[69xku] 打开: ${listUrl}`);
  await gotoWithRetry(page, listUrl, '目录', GOTO_OPTS);
  await waitForCatalogReady69(page, `目录 ${listUrl}`, loc);

  const chunk = await extractChapterLinkSections(page, loc);
  const nMain = chunk.main.length;
  const nLat = chunk.latest.length;
  console.log(`[69xku] 本页目录: 全书区 ${nMain} 条, 最新区 ${nLat} 条`);

  const merged = merge69xkuChapterLists(chunk.main, chunk.latest);
  console.log(`[69xku] 合并排序后共 ${merged.length} 章（全书序 + 仅最新区补尾）`);
  return merged;
}

async function resolveContentSelector(page) {
  for (const sel of CONTENT_SELECTORS) {
    const h = await page.$(sel);
    if (!h) continue;
    const n = await h.evaluate((el) => (el.innerText || '').trim().length);
    if (n > 40) return sel;
  }
  return CONTENT_SELECTORS[0];
}

async function extractChapterPlainText(page, chapterUrl) {
  const shortLabel = path.basename(new URL(chapterUrl).pathname);
  await gotoWithRetry(page, chapterUrl, `正文 ${shortLabel}`, GOTO_OPTS);
  await waitForChapterBody69(page, `正文 ${shortLabel}`);

  const preferred = await resolveContentSelector(page);
  const tryOrder = [...new Set([preferred, ...CONTENT_SELECTORS])];
  let raw = '';
  for (const sel of tryOrder) {
    const h = await page.$(sel);
    if (!h) continue;
    raw = await h.evaluate((el) => el.innerText.trim()).catch(() => '');
    if (raw.length >= MIN_CHAPTER_BODY_CHARS) break;
  }
  if (raw.length < MIN_CHAPTER_BODY_CHARS) {
    throw new Error(`正文过短（${raw.length} 字），选择器可能已失效: ${chapterUrl}`);
  }
  return stripAdLines(raw);
}

async function main() {
  const { outputDir, urlFile, mergeTitle, restArgv } = extractScrapeFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');

  const runMerge = restArgv.includes('--merge');
  const forceChapters = restArgv.includes('--force') || process.env.X69KU_FORCE === '1';
  const useFileOnly = restArgv.includes('--file');
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  if (forceChapters) {
    console.log('[69xku] --force：将覆盖已存在且大于 100 字节的章节 txt');
  }

  const headed = useHeadedLaunch();
  if (headed) {
    console.log('[69xku] 使用有头浏览器（NOVEL_HEADLESS=0 或 X69KU_HEADED=1）');
  }
  const storageStatePath = resolveStorageStatePath69();
  if (storageStatePath && fs.existsSync(storageStatePath)) {
    console.log('[69xku] 使用 storageState:', storageStatePath);
  }

  const browser = await chromium.launch({
    headless: !headed,
    channel: headed ? 'chrome' : undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext(
    storageStatePath && fs.existsSync(storageStatePath) ? { storageState: storageStatePath } : {}
  );
  const page = await context.newPage();

  const failureLogPath = path.join(outputDir, '69xku_scrape_failures.jsonl');

  let chapters;
  const envListUrl = process.env.X69KU_CHAPTERS_URL?.trim();
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
    console.log('从书籍页发现章节:', discoverUrl);
    chapters = await discoverChapters(page, discoverUrl);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);
  } else if (fs.existsSync(resolveUrlFilePath(urlFile))) {
    const urlFileAbs = resolveUrlFilePath(urlFile);
    chapters = chaptersFromUrlFileText(readUrlFileSync(urlFileAbs));
    console.log(`从 ${urlFileAbs} 读取 ${chapters.length} 个 URL`);
  } else {
    console.error('请传入书籍页 URL，例如: node gaode/69xku/scrape-69xku.js https://69xku.com/book/49851/');
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
    console.error('未得到任何章节 URL。若遇 Cloudflare，请使用 NOVEL_HEADLESS=0 或 X69KU_STORAGE_STATE。');
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
      const errMsg = e && e.message ? e.message : String(e);
      console.log(`失败: ${errMsg}`);
      console.error(`[69xku] 章节抓取失败 index=${i + 1}/${total} title=${title} href=${href} error=${errMsg}`);
      try {
        fs.appendFileSync(
          failureLogPath,
          `${JSON.stringify({
            at: new Date().toISOString(),
            index: i + 1,
            title,
            href,
            error: errMsg,
          })}\n`,
          'utf8'
        );
      } catch (_) {
        /* ignore log IO errors */
      }
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
