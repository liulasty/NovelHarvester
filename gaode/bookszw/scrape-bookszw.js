/**
 * bookszw.com（零点看书类笔趣阁模板）工作流：
 * 1) 传入书籍目录 URL：`http(s)://www.bookszw.com/{分类id}/{书籍id}/`（可带 index.html）
 * 2) 目录：`#list` 内按 `<dt>` 分段，**跳过「最新章节」** 区块；正文区与最新区分别合并后按「第N章」排序，正文在前、仅出现在「最新」且未在正文出现的链接排在末尾
 * 3) 正文：`#content` 等；**章内分页** `id.html`、`id_1.html`…（`h1`/title 或正文末「第M/N页」；正文内「本章未完」等也会续拉下一屏），自动拼接
 *
 * 本站常见 Cloudflare / Turnstile：无头模式易被拦。请使用有头浏览器或已登录态：
 *   CMD: set NOVEL_HEADLESS=0
 *   PowerShell: $env:NOVEL_HEADLESS = "0"
 *   或 set BOOKSZW_HEADED=1 / $env:BOOKSZW_HEADED = "1"
 * 可选：BOOKSZW_STORAGE_STATE=绝对或相对路径 指向 playwright storageState JSON（通过一次验证后保存）
 * 可选：BOOKSZW_LATEST_TOP=数字 目录页 #list 内前 N 条视为「最新区」（默认 10）；0=关闭按条数回退
 * 可选：正文抓取加 --force 覆盖已存在且大于 100 字节的章节文件（否则跳过）
 *
 * 用法：
 *   node gaode/bookszw/scrape-bookszw.js http://www.bookszw.com/22/22313/
 *   node gaode/bookszw/scrape-bookszw.js http://www.bookszw.com/22/22313/ 5
 *   仅重写目录 manifest、不抓正文：加 --discover-only（建议配合 NOVEL_HEADLESS=0 过 Cloudflare）
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const DEFAULT_URL_FILE = 'chapters_urls.txt';
const DEFAULT_CHAPTERS_LIST_URL = 'http://www.bookszw.com/22/22313/';

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 120000 };

const CONTENT_SELECTORS = ['#content', '#contents', '#chaptercontent', '.ReadAjax_content', '.showtxt', '#BookText'];

const CN_DIGIT = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 将「九百八十八」「两千零二」「一」等转为整数；无法解析则 NaN */
function chineseNumeralToInt(str) {
  const s = String(str || '')
    .replace(/\s+/g, '')
    .replace(/廿/g, '二十')
    .replace(/卅/g, '三十');
  if (!s) return NaN;
  let total = 0;
  const wanParts = s.split('万');
  const high = wanParts.length > 1 ? wanParts[0] : '';
  const low = wanParts.length > 1 ? wanParts.slice(1).join('万') : s;
  const parseSection = (sec) => {
    if (!sec) return 0;
    let n = 0;
    let tmp = 0;
    for (let i = 0; i < sec.length; i++) {
      const c = sec[i];
      if (CN_DIGIT[c] !== undefined) {
        tmp = CN_DIGIT[c];
        continue;
      }
      if (c === '十') {
        n += (tmp || 1) * 10;
        tmp = 0;
      } else if (c === '百') {
        n += (tmp || 1) * 100;
        tmp = 0;
      } else if (c === '千') {
        n += (tmp || 1) * 1000;
        tmp = 0;
      } else {
        return NaN;
      }
    }
    return n + tmp;
  };
  if (high) {
    const w = parseSection(high);
    if (Number.isNaN(w)) return NaN;
    total = w * 10000;
  }
  const lowVal = parseSection(low);
  if (Number.isNaN(lowVal)) return NaN;
  return total + lowVal;
}

/** 从标题解析「第 n 章」用于排序；无则 null */
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

/**
 * 合并多页目录：正文区（非「最新」dt 下）按章号升序；仅出现在「最新」区且不在正文区的链接排在最后（亦按章号）。
 */
function mergeBookszwChapterLists(mainRows, latestRows) {
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

/** 正文页 h1/title/文末 中的 第M/N页、第M页/共N页 等 */
function parsePageFractionFromText(text) {
  const t = String(text || '');
  const patterns = [
    /[（(]第\s*(\d+)\s*页\s*[\/／]\s*共\s*(\d+)\s*页[）)]/u,
    /[（(]第\s*(\d+)\s*页\s*[\/／]\s*(\d+)\s*页[）)]/u,
    /[（(]\s*第\s*(\d+)\s*[\/／]\s*(\d+)\s*页\s*[）)]/u,
    /第\s*(\d+)\s*页\s*[\/／]\s*共\s*(\d+)\s*页/u,
    /第\s*(\d+)\s*[\/／]\s*(\d+)\s*页/u,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  }
  return null;
}

/** 正文块内常见「尚未结束、还有下一屏」提示（站方写在 #content 里，不一定出现在 title） */
function chunkImpliesMorePages(chunk) {
  return /本章未完|未完待续|请点击下一页|下页继续|下一页继续|点击下一页继续阅读/i.test(String(chunk || ''));
}

function parseBookszwChapterStemUrl(chapterUrl) {
  const u = new URL(chapterUrl);
  const m = u.pathname.match(/^\/(\d+)\/(\d+)\/(\d+)(?:_\d+)?\.html$/i);
  if (!m) return null;
  return { origin: u.origin, category: m[1], bookId: m[2], chapterId: m[3] };
}

function normalizeTextPrefix(s, n) {
  return String(s)
    .replace(/\s+/g, '')
    .slice(0, n);
}

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function useHeadedLaunch() {
  return process.env.NOVEL_HEADLESS === '0' || process.env.BOOKSZW_HEADED === '1';
}

function resolveStorageStatePath() {
  const s = process.env.BOOKSZW_STORAGE_STATE?.trim();
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  return path.join(PROJECT_ROOT, s);
}

/** 解析 /22/22313/ 或 /22/22313/index_2.html */
function parseBookIndexUrl(entryUrl) {
  const u = new URL(entryUrl);
  const m = u.pathname.match(/^\/(\d+)\/(\d+)(?:\/(?:index(?:_\d+)?\.html)?)?\/?$/i);
  if (!m) {
    const m2 = u.pathname.match(/^\/(\d+)\/(\d+)/);
    if (!m2) throw new Error(`非 bookszw 书籍目录路径（需 /分类数字/书籍数字/）: ${entryUrl}`);
    return { origin: u.origin, category: m2[1], bookId: m2[2] };
  }
  return { origin: u.origin, category: m[1], bookId: m[2] };
}

function catalogRootUrl(loc) {
  return `${loc.origin}/${loc.category}/${loc.bookId}/`;
}

function normalizeBooksEntryUrl(url) {
  const u = new URL(url);
  if (/bookszw\.com$/i.test(u.hostname)) {
    u.protocol = 'http:';
  }
  if (!/\/$/.test(u.pathname) && !/\.html$/i.test(u.pathname)) {
    u.pathname += '/';
  }
  return u.href;
}

/** CF 通过后整页跳转时，evaluate 可能落在「导航中途」而抛错，应视为尚未就绪并继续轮询 */
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

async function catalogReadyProbe(page, loc) {
  try {
    return await page.evaluate(
      ({ c, b }) => {
        const t = document.title || '';
        if (/^Just a moment/i.test(t)) return { ok: false, reason: 'cf_title' };
        const body = document.body?.innerText || '';
        if (/正在进行安全验证|Enable JavaScript and cookies/i.test(body) && !/最新章节|章节目录/.test(body)) {
          return { ok: false, reason: 'cf_challenge' };
        }
        const re = new RegExp(`^/${c}/${b}/\\d+(?:_\\d+)?\\.html$`, 'i');
        const hit = [...document.querySelectorAll('a[href]')].some((a) => {
          try {
            return re.test(new URL(a.getAttribute('href') || '', location.origin).pathname);
          } catch {
            return false;
          }
        });
        return hit ? { ok: true } : { ok: false, reason: 'no_chapter_links' };
      },
      { c: loc.category, b: loc.bookId }
    );
  } catch (e) {
    if (isTransientNavigationEvaluateError(e)) {
      return { ok: false, reason: 'navigating' };
    }
    throw e;
  }
}

/** 轮询 + 心跳日志，避免长时间无输出被误认为卡死 */
async function waitForCatalogReady(page, phase, loc) {
  const timeout = parseInt(process.env.BOOKSZW_CHALLENGE_TIMEOUT_MS || '120000', 10);
  const pollMs = 2000;
  const heartbeatSec = 8;
  const start = Date.now();
  let lastBeat = 0;
  let warnedHeadlessCf = false;

  console.log(
    `[bookszw] ${phase}: 等待章节链接（最长 ${Math.round(timeout / 1000)}s）。遇验证页请用 NOVEL_HEADLESS=0 打开浏览器完成人机校验。`
  );

  while (Date.now() - start < timeout) {
    const probe = await catalogReadyProbe(page, loc);
    if (probe.ok) return;

    const elapsed = (Date.now() - start) / 1000;
    if (elapsed - lastBeat >= heartbeatSec) {
      lastBeat = elapsed;
      const title = (await page.title().catch(() => '')).slice(0, 70);
      console.log(`[bookszw] … 已等待 ${Math.floor(elapsed)}s | ${title || '(no title)'}`);
    }

    if (!warnedHeadlessCf && !useHeadedLaunch() && elapsed > 20 && probe.reason === 'cf_title') {
      warnedHeadlessCf = true;
      console.warn(
        '[bookszw] 仍停留在 Cloudflare「Just a moment」；无头模式通常无法通过。请 Ctrl+C 后：CMD 执行 set NOVEL_HEADLESS=0，或 PowerShell 执行 $env:NOVEL_HEADLESS = "0"，再运行。'
      );
    }

    if (probe.reason === 'navigating') {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }

    await page.waitForTimeout(pollMs);
  }

  const title = await page.title().catch(() => '');
  const msg = `[bookszw] ${phase} 等待超时（title=${title.slice(0, 80)}）。请 set NOVEL_HEADLESS=0 完成验证，或设置 BOOKSZW_STORAGE_STATE。`;
  console.warn(msg);
  throw new Error(msg);
}

async function chapterBodyProbe(page) {
  try {
    return await page.evaluate((selectors) => {
      if (/^Just a moment/i.test(document.title || '')) return { ok: false, reason: 'cf_title' };
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && (el.innerText || '').trim().length > 80) return { ok: true, sel };
      }
      return { ok: false, reason: 'no_body' };
    }, CONTENT_SELECTORS);
  } catch (e) {
    if (isTransientNavigationEvaluateError(e)) {
      return { ok: false, reason: 'navigating' };
    }
    throw e;
  }
}

async function waitForChapterBody(page, phase) {
  const timeout = parseInt(process.env.BOOKSZW_CHALLENGE_TIMEOUT_MS || '120000', 10);
  const pollMs = 2000;
  const heartbeatSec = 8;
  const start = Date.now();
  let lastBeat = 0;

  console.log(`[bookszw] ${phase}: 等待正文容器（最长 ${Math.round(timeout / 1000)}s）…`);

  while (Date.now() - start < timeout) {
    const probe = await chapterBodyProbe(page);
    if (probe.ok) return;

    const elapsed = (Date.now() - start) / 1000;
    if (elapsed - lastBeat >= heartbeatSec) {
      lastBeat = elapsed;
      const title = (await page.title().catch(() => '')).slice(0, 70);
      console.log(`[bookszw] … 已等待 ${Math.floor(elapsed)}s | ${title || '(no title)'}`);
    }

    if (probe.reason === 'navigating') {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }

    await page.waitForTimeout(pollMs);
  }

  const title = await page.title().catch(() => '');
  const msg = `[bookszw] ${phase} 正文等待超时（title=${title.slice(0, 80)}）`;
  console.warn(msg);
  throw new Error(msg);
}

function bookszwLatestTopCount() {
  const raw = process.env.BOOKSZW_LATEST_TOP?.trim();
  if (raw === '' || raw == null) return 10;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

/**
 * 按 #list 内 dt 分段：「最新章节」等进 latest，其余进 main。
 * 新版模板：`h2.layout-tit`（《书名》最新章节 / 《书名》正文）+ 紧随的 `div.section-box ul.section-list`。
 * 本站常见：同一 dd 内先 10 条「最新」再约 20 条本页目录，且无匹配 dt → latest 为空。
 * 此时按 #list 内 a[href] 的文档顺序，前 BOOKSZW_LATEST_TOP 条（默认 10）归入 latest，其余归 main。
 */
async function extractChapterLinkSections(page, loc) {
  const latestTopN = bookszwLatestTopCount();
  return page.evaluate(
    ({ origin, category, bookId, latestTopN: top }) => {
      const chapterPathRe = new RegExp(`^/${category}/${bookId}/\\d+(?:_\\d+)?\\.html$`, 'i');

      function pushValid(arr, a) {
        let href = a.getAttribute('href') || '';
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

      function linkFromAnchor(a) {
        let href = a.getAttribute('href') || '';
        let abs;
        try {
          abs = new URL(href, origin).href;
        } catch {
          return null;
        }
        let p = '';
        try {
          p = new URL(abs).pathname;
        } catch {
          return null;
        }
        if (!chapterPathRe.test(p)) return null;
        const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
        return { href: abs, title: title || p.split('/').pop() };
      }

      const dedupe = (arr) => {
        const seen = new Set();
        return arr.filter((x) => {
          if (seen.has(x.href)) return false;
          seen.add(x.href);
          return true;
        });
      };

      /** 笔趣阁类新版目录：layout-tit + section-box（与 #list 二选一） */
      function extractLayoutTitSections() {
        const main = [];
        const latest = [];
        const h2s = document.querySelectorAll('h2.layout-tit');
        if (!h2s.length) return { main, latest, used: false };

        const isLatestTit = (tit) =>
          /最新章节|最近更新|最新更新|连载章节|最新\s*章|最近章节|章节列表.*最新/i.test(tit);
        const isMainTit = (tit) =>
          /正文|章节目录|章节列表|分卷|全集|正\s*文/i.test(tit);

        let used = false;
        for (const h2 of h2s) {
          const tit = (h2.textContent || '').replace(/\s+/g, ' ').trim();
          let zone = null;
          if (isLatestTit(tit)) zone = 'latest';
          else if (isMainTit(tit)) zone = 'main';
          if (zone === null) continue;

          let el = h2.nextElementSibling;
          while (el && el.tagName !== 'H2') {
            if (el.classList && el.classList.contains('section-box')) {
              const arr = zone === 'latest' ? latest : main;
              for (const a of el.querySelectorAll('ul.section-list a[href], .section-list a[href]')) {
                pushValid(arr, a);
              }
              used = true;
              break;
            }
            el = el.nextElementSibling;
          }
        }
        return { main, latest, used };
      }

      const dl = document.querySelector('#list');
      if (!dl) {
        const layout = extractLayoutTitSections();
        if (layout.used && (layout.main.length > 0 || layout.latest.length > 0)) {
          return { main: dedupe(layout.main), latest: dedupe(layout.latest) };
        }

        const main = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          try {
            if (!chapterPathRe.test(new URL(a.getAttribute('href') || '', origin).pathname)) continue;
          } catch {
            continue;
          }
          const abs = new URL(a.getAttribute('href') || '', origin).href;
          if (seen.has(abs)) continue;
          seen.add(abs);
          pushValid(main, a);
        }
        return { main, latest: [] };
      }

      const ordered = [];
      const ordSeen = new Set();
      for (const a of dl.querySelectorAll('a[href]')) {
        const item = linkFromAnchor(a);
        if (!item || ordSeen.has(item.href)) continue;
        ordSeen.add(item.href);
        ordered.push(item);
      }

      const isLatestDt = (name) =>
        /最新章节|最近更新|最新更新|连载章节|最新\s*章|最近章节|章节列表.*最新/i.test(name);

      const main = [];
      const latest = [];
      let zone = 'main';
      let seenDt = false;

      for (const node of dl.children) {
        const tag = node.tagName;
        if (tag === 'DT') {
          seenDt = true;
          const name = (node.textContent || '').replace(/\s+/g, ' ').trim();
          zone = isLatestDt(name) ? 'latest' : 'main';
        } else if (tag === 'DD') {
          const arr = !seenDt || zone === 'main' ? main : latest;
          for (const a of node.querySelectorAll('a[href]')) pushValid(arr, a);
        }
      }

      let outMain = dedupe(main);
      let outLatest = dedupe(latest);
      if (outLatest.length === 0 && top > 0 && ordered.length > top) {
        outLatest = ordered.slice(0, top);
        outMain = ordered.slice(top);
      }

      return { main: dedupe(outMain), latest: dedupe(outLatest) };
    },
    { origin: loc.origin, category: loc.category, bookId: loc.bookId, latestTopN: latestTopN }
  );
}

async function findCatalogNextPageUrl(page, loc) {
  return page.evaluate(
    ({ origin, category, bookId }) => {
      const bookNeedle = `/${category}/${bookId}/`;
      for (const a of document.querySelectorAll('a[href]')) {
        const raw = (a.textContent || '').replace(/\s+/g, '');
        if (!/下一页/.test(raw)) continue;
        let href = '';
        try {
          href = new URL(a.getAttribute('href') || '', origin).href;
        } catch {
          continue;
        }
        if (!href.includes(bookNeedle)) continue;
        if (/\.(js|css|png|jpg)(\?|$)/i.test(href)) continue;
        return href;
      }
      return null;
    },
    { origin: loc.origin, category: loc.category, bookId: loc.bookId }
  );
}

async function discoverChapters(page, entryUrl) {
  const norm = normalizeBooksEntryUrl(entryUrl);
  const loc = parseBookIndexUrl(norm);
  const seenListUrls = new Set();
  const allMain = [];
  const allLatest = [];

  let listUrl = catalogRootUrl(loc);
  while (listUrl) {
    if (seenListUrls.has(listUrl)) break;
    seenListUrls.add(listUrl);

    console.log(`[bookszw] 打开: ${listUrl}`);
    await page.goto(listUrl, GOTO_OPTS);
    await waitForCatalogReady(page, `目录 ${listUrl}`, loc);

    const chunk = await extractChapterLinkSections(page, loc);
    const nMain = chunk.main.length;
    const nLat = chunk.latest.length;
    if (!nMain && !nLat) {
      console.warn(`目录页未解析到章节链接: ${listUrl}`);
    } else {
      console.log(`[bookszw] 本页目录: 正文区 ${nMain} 条, 最新区 ${nLat} 条`);
    }
    allMain.push(...chunk.main);
    allLatest.push(...chunk.latest);

    const next = await findCatalogNextPageUrl(page, loc);
    if (!next || seenListUrls.has(next)) break;
    listUrl = next;
  }

  const merged = mergeBookszwChapterLists(allMain, allLatest);
  console.log(`[bookszw] 合并排序后共 ${merged.length} 章（正文序 + 仅最新区补尾）`);
  return merged;
}

function stripAdLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (/请记住本书首发域名|最新章节.*首发|手机阅读|章节错误|报错欠更/.test(s)) return false;
      if (/本章未完|未完待续|请点击下一页|下页继续|下一页继续阅读|点击下一页继续阅读/.test(s)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/** #content 顶常见重复：目录文案、与 h1 重复的「第×章」、单独的分页行 */
function isLeadingChapterNoiseLine(trimmed) {
  const t = String(trimmed || '').trim();
  if (!t) return false;
  if (/^(开始阅读|点我阅读|请先阅读|立即阅读)$/.test(t)) return true;
  if (/^第\s*[\d零一二三四五六七八九十百千万两]+\s*章/u.test(t)) return true;
  if (/^[（(]第\s*\d+\s*\/\s*\d+\s*页[）)]$/.test(t)) return true;
  return false;
}

function stripLeadingChapterHeadNoise(text) {
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === '') {
      i++;
      continue;
    }
    if (isLeadingChapterNoiseLine(t)) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n').trim();
}

async function resolveContentSelector(page) {
  for (const sel of CONTENT_SELECTORS) {
    const h = await page.$(sel);
    if (!h) continue;
    const n = await h.evaluate((el) => (el.innerText || '').trim().length);
    if (n > 80) return sel;
  }
  return CONTENT_SELECTORS[0];
}

async function extractChapterPlainText(page, chapterUrl) {
  const stem = parseBookszwChapterStemUrl(chapterUrl);
  if (!stem) {
    await page.goto(chapterUrl, GOTO_OPTS);
    await waitForChapterBody(page, `正文 ${chapterUrl}`);
    const sel = await resolveContentSelector(page);
    await page.waitForSelector(sel, { timeout: 25000 });
    const raw = await page.$eval(sel, (el) => el.innerText.trim());
    return stripLeadingChapterHeadNoise(stripAdLines(raw));
  }

  const { origin, category, bookId, chapterId } = stem;
  const base = `${origin}/${category}/${bookId}/${chapterId}`;
  const urls = [`${base}.html`];
  for (let k = 1; k <= 250; k++) urls.push(`${base}_${k}.html`);

  const parts = [];
  let shortStreak = 0;
  let dupStreak = 0;

  for (const url of urls) {
    try {
      await page.goto(url, GOTO_OPTS);
      await waitForChapterBody(page, `正文 ${path.basename(new URL(url).pathname)}`);
    } catch {
      if (parts.length > 0) break;
      continue;
    }

    const sel = await resolveContentSelector(page);
    const raw = await page.$eval(sel, (el) => el.innerText.trim()).catch(() => '');
    /** 须在 stripAdLines 之前判断：stripAdLines 会去掉「本章未完」等行，否则永远误判为单页 */
    const rawImpliesMorePages = chunkImpliesMorePages(raw);
    const chunk = stripLeadingChapterHeadNoise(stripAdLines(raw));
    if (chunk.length < 25) {
      shortStreak++;
      if (parts.length > 0 && shortStreak >= 3) break;
      continue;
    }
    shortStreak = 0;

    const head = (await page.$eval('h1', (el) => el.textContent.trim()).catch(() => '')) + ' ';
    const bar = (await page.title().catch(() => '')) + ' ';
    let fr = parsePageFractionFromText(head + bar);
    if (!fr) fr = parsePageFractionFromText(chunk.slice(-800));

    const pfx = normalizeTextPrefix(chunk, 240);
    if (parts.length > 0 && pfx === normalizeTextPrefix(parts[parts.length - 1], 240)) {
      dupStreak++;
      if (dupStreak >= 6) break;
      continue;
    }
    dupStreak = 0;

    parts.push(chunk);
    if (fr && fr[0] >= fr[1]) break;
    if (rawImpliesMorePages) continue;
    if (fr && fr[0] < fr[1]) continue;
    break;
  }

  if (parts.length === 0) {
    throw new Error(`正文为空: ${chapterUrl}`);
  }
  return stripLeadingChapterHeadNoise(parts.join('\n\n').trim());
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
  const discoverOnly = restArgv.includes('--discover-only');
  const forceChapters = restArgv.includes('--force') || process.env.BOOKSZW_FORCE === '1';
  const useFileOnly = restArgv.includes('--file');
  if (discoverOnly && useFileOnly) {
    console.error('[bookszw] --discover-only 仅用于从书籍目录 URL 发现章节，不能与 --file 同时使用。');
    process.exit(1);
  }
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  const headed = useHeadedLaunch();
  if (headed) {
    console.log('[bookszw] 使用有头浏览器（NOVEL_HEADLESS=0 或 BOOKSZW_HEADED=1）');
  }
  if (forceChapters) {
    console.log('[bookszw] --force：将覆盖已存在的章节 txt（不再因体积>100 字节而跳过）');
  }

  const storageStatePath = resolveStorageStatePath();
  if (storageStatePath) {
    console.log('[bookszw] 使用 storageState:', storageStatePath);
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

  let chapters;
  const envListUrl = process.env.BOOKSZW_CHAPTERS_URL?.trim();
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
    const norm = normalizeBooksEntryUrl(discoverUrl);
    console.log('从书籍目录页发现章节:', norm);
    chapters = await discoverChapters(page, norm);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);
  } else if (fs.existsSync(resolveUrlFilePath(urlFile))) {
    const urlFileAbs = resolveUrlFilePath(urlFile);
    chapters = chaptersFromUrlFileText(readUrlFileSync(urlFileAbs));
    console.log(`从 ${urlFileAbs} 读取 ${chapters.length} 个 URL`);
  } else {
    console.log('未传 URL、未设置 BOOKSZW_CHAPTERS_URL，且缺少 URL 列表文件，使用默认目录页');
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
      '未得到任何章节 URL。若目录在 Cloudflare 验证后，请用有头模式重试或配置 BOOKSZW_STORAGE_STATE。'
    );
    process.exit(1);
  }

  if (discoverOnly) {
    await browser.close();
    console.log('[bookszw] --discover-only：已写入目录 manifest，跳过正文抓取与合并。');
    process.exit(0);
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
