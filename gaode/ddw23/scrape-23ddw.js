/**
 * 23ddw.net（顶点小说网）工作流：
 * 1) 传入书籍目录 URL：`https://www.23ddw.net/du/{分类}/{书籍id}/`
 * 2) 目录：`#list` 内 `li > a` 全量章节链接 + 首页「最新章节」区（#chapterlist）
 *    全量在前、仅最新区补尾，按章号排序
 * 3) 正文：`#content`；章内分页 `{id}_2.html`、`{id}_3.html`…（h1 或文末「第M/N页」检测），自动拼接
 *
 * 用法：
 *   node gaode/ddw23/scrape-23ddw.js https://www.23ddw.net/du/51/51866/
 *   node gaode/ddw23/scrape-23ddw.js https://www.23ddw.net/du/51/51866/ 5
 * --out-dir= --merge --merge-title= 同其他 scraper
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { chineseNumeralToInt } = require(path.join(__dirname, '..', 'lib', 'chinese-numeral.js'));

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 90000 };
const GOTO_FALLBACK_OPTS = { waitUntil: 'load', timeout: 90000 };
const CONTENT_SEL = '#content';
const MIN_BODY_CHARS = 40;
const DEFAULT_URL_FILE = 'chapters_urls.txt';

function useHeadedLaunch() {
  return process.env.NOVEL_HEADLESS === '0' || process.env.DDW23_HEADED === '1';
}

function resolveStorageState() {
  const s = process.env.DDW23_STORAGE_STATE?.trim();
  if (!s) return null;
  return path.isAbsolute(s) ? s : path.join(PROJECT_ROOT, s);
}

function isTransientNavError(e) {
  const msg = e?.message || String(e);
  return /Execution context was destroyed/i.test(msg) ||
    /Target page, context or browser has been closed/i.test(msg) ||
    /Navigation failed/i.test(msg) ||
    /net::ERR_ABORTED/i.test(msg) ||
    /most likely because of a navigation/i.test(msg);
}

/** 从 /du/51/51866/ → { origin, category: '51', bookId: '51866' } */
function parseEntryUrl(entryUrl) {
  const u = new URL(entryUrl);
  const m = u.pathname.match(/^\/du\/(\d+)\/(\d+)\/?$/i);
  if (!m) throw new Error(`非 23ddw.net 书籍目录 URL（需 /du/{分类}/{书籍id}/）: ${entryUrl}`);
  return { origin: u.origin, category: m[1], bookId: m[2] };
}

function catalogUrl(loc) {
  return `${loc.origin}/du/${loc.category}/${loc.bookId}/`;
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
  return null;
}

function titleLooksLikeChapterHeading(title) {
  return /第\s*(?:\d+|[零一二三四五六七八九十百千万两廿卅]+)\s*章/.test(String(title || ''));
}

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function mergeChapterLists(mainRows, latestRows) {
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

  // 按章号去重：同一章出现两个不同 URL 时保留正文区的条目
  const byNum = new Map();
  for (const x of byHref.values()) {
    const num = chapterNumberFromTitle(x.title);
    if (num == null || Number.isNaN(num)) continue;
    const existing = byNum.get(num);
    if (!existing) { byNum.set(num, x); continue; }
    // 优先保留 inMain 的；都 inMain 则保留阿拉伯数字标题（更规范）
    if (!existing.inMain && x.inMain) { byNum.set(num, x); }
    else if (existing.inMain === x.inMain) {
      const existingIsArabic = /第\s*\d+\s*章/.test(existing.title);
      const xIsArabic = /第\s*\d+\s*章/.test(x.title);
      if (!existingIsArabic && xIsArabic) byNum.set(num, x);
    }
  }
  const dedupedHrefs = new Set(Array.from(byNum.values(), (v) => v.href));

  const body = [];
  const tail = [];
  for (const x of byHref.values()) {
    // 跳过被按章号去重保留的重复条目
    const num2 = chapterNumberFromTitle(x.title);
    if (num2 != null && !Number.isNaN(num2) && !dedupedHrefs.has(x.href)) continue;
    const sk = num2 != null && !Number.isNaN(num2) ? num2 : 1e6;
    const item = { href: x.href, title: x.title, sk };
    if (x.inMain) body.push(item);
    else tail.push(item);
  }
  const cmp = (a, b) => a.sk - b.sk || a.title.localeCompare(b.title, 'zh-Hans-CN');
  body.sort(cmp);
  tail.sort(cmp);
  return [...body, ...tail].map(({ href, title }) => ({ href, title }));
}

// --- Catalog helpers ---

async function catalogReadyProbe(page, loc) {
  try {
    return await page.evaluate(
      ({ origin, category, bookId }) => {
        if (/^Just a moment/i.test(document.title || '')) return { ok: false, reason: 'cf_title' };
        const body = document.body?.innerText || '';
        if (/正在进行安全验证|Enable JavaScript and cookies/i.test(body) && !/最新章节|章节目录/.test(body)) {
          return { ok: false, reason: 'cf_challenge' };
        }
        const re = new RegExp(`^/du/${category}/${bookId}/\\d+\\.html$`, 'i');
        const hit = [...document.querySelectorAll('a[href]')].some((a) => {
          try { return re.test(new URL(a.getAttribute('href') || '', origin).pathname); }
          catch { return false; }
        });
        return hit ? { ok: true } : { ok: false, reason: 'no_chapter_links' };
      },
      { origin: loc.origin, category: loc.category, bookId: loc.bookId }
    );
  } catch (e) {
    if (isTransientNavError(e)) return { ok: false, reason: 'navigating' };
    throw e;
  }
}

async function waitForCatalogReady(page, phase, loc) {
  const timeout = parseInt(process.env.DDW23_CHALLENGE_TIMEOUT_MS || '120000', 10);
  const pollMs = 2000;
  const heartbeatSec = 8;
  const start = Date.now();
  let lastBeat = 0;
  let warnedHeadlessCf = false;

  console.log(`[23ddw] ${phase}: 等待章节链接（最长 ${Math.round(timeout / 1000)}s）`);

  while (Date.now() - start < timeout) {
    const probe = await catalogReadyProbe(page, loc);
    if (probe.ok) return;

    const elapsed = (Date.now() - start) / 1000;
    if (elapsed - lastBeat >= heartbeatSec) {
      lastBeat = elapsed;
      const title = (await page.title().catch(() => '')).slice(0, 70);
      console.log(`[23ddw] … 已等待 ${Math.floor(elapsed)}s | ${title || '(no title)'}`);
    }
    if (!warnedHeadlessCf && !useHeadedLaunch() && elapsed > 20 && probe.reason === 'cf_title') {
      warnedHeadlessCf = true;
      console.warn('[23ddw] 仍停留在 Cloudflare「Just a moment」；可设 NOVEL_HEADLESS=0 再用有头浏览器完成验证。');
    }
    if (probe.reason === 'navigating') {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    await page.waitForTimeout(pollMs);
  }
  const title = await page.title().catch(() => '');
  throw new Error(`[23ddw] ${phase} 等待超时（title=${title.slice(0, 80)}）`);
}

async function extractChapterLinks(page, loc) {
  return page.evaluate(
    ({ origin, category, bookId }) => {
      const chapterPathRe = new RegExp(`^/du/${category}/${bookId}/(\\d+)(?:_\\d+)?\\.html$`, 'i');

      function pushValid(arr, a) {
        let href = a.getAttribute('href') || '';
        if (/^javascript:/i.test(href)) return;
        let abs, p;
        try { abs = new URL(href, origin).href; p = new URL(abs).pathname; }
        catch { return; }
        const m = chapterPathRe.exec(p);
        if (!m) return;
        const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
        arr.push({ href: abs, title, chapterId: m[1] });
      }

      const dedupe = (arr) => {
        const seen = new Set();
        return arr.filter((x) => { if (seen.has(x.href)) return false; seen.add(x.href); return true; });
      };

      // 全量章节目录 #list
      const main = [];
      const list = document.querySelector('#list');
      if (list) {
        for (const a of list.querySelectorAll('li > a[href]')) pushValid(main, a);
      }

      // 最新章节 #chapterlist
      const latest = [];
      const cl = document.querySelector('#chapterlist');
      if (cl) {
        for (const a of cl.querySelectorAll('a[href]')) {
          // 只取 #chapterlist 中不在 #list 内的
          if (list && list.contains(a)) continue;
          pushValid(latest, a);
        }
      }

      // fallback: 所有匹配 a
      let outMain = dedupe(main);
      let outLatest = dedupe(latest);
      if (outMain.length === 0 && outLatest.length === 0) {
        const fb = [];
        for (const a of document.querySelectorAll('a[href]')) pushValid(fb, a);
        outMain = dedupe(fb);
      }

      return { main: outMain, latest: outLatest };
    },
    { origin: loc.origin, category: loc.category, bookId: loc.bookId }
  );
}

async function discoverChapters(page, entryUrl) {
  const loc = parseEntryUrl(entryUrl);
  const listUrl = catalogUrl(loc);

  console.log(`[23ddw] 打开: ${listUrl}`);
  await page.goto(listUrl, GOTO_OPTS);
  await waitForCatalogReady(page, `目录 ${listUrl}`, loc);

  const { main, latest } = await extractChapterLinks(page, loc);
  console.log(`[23ddw] 目录: 全量区 ${main.length} 条, 最新章节区 ${latest.length} 条`);

  const merged = mergeChapterLists(main, latest);
  console.log(`[23ddw] 合并去重后共 ${merged.length} 章`);
  return merged;
}

// --- Chapter body ---

async function chapterBodyProbe(page) {
  try {
    return await page.evaluate((sel) => {
      if (/^Just a moment/i.test(document.title || '')) return { ok: false, reason: 'cf_title' };
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').trim().length > 80) return { ok: true };
      return { ok: false, reason: 'no_body' };
    }, CONTENT_SEL);
  } catch (e) {
    if (isTransientNavError(e)) return { ok: false, reason: 'navigating' };
    throw e;
  }
}

async function waitForChapterBody(page, phase, timeoutMs) {
  const timeout = timeoutMs || parseInt(process.env.DDW23_CHALLENGE_TIMEOUT_MS || '120000', 10);
  const start = Date.now();
  let lastBeat = 0;

  console.log(`[23ddw] ${phase}: 等待正文容器（最长 ${Math.round(timeout / 1000)}s）…`);
  while (Date.now() - start < timeout) {
    const probe = await chapterBodyProbe(page);
    if (probe.ok) return;
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed - lastBeat >= 8) {
      lastBeat = elapsed;
      console.log(`[23ddw] … 已等待 ${Math.floor(elapsed)}s | ${(await page.title().catch(() => '')).slice(0, 70)}`);
    }
    if (probe.reason === 'navigating') await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2000);
  }
  throw new Error(`[23ddw] ${phase} 正文等待超时（title=${(await page.title().catch(() => '')).slice(0, 80)}）`);
}

function parsePageFraction(text) {
  const t = String(text || '');
  const patterns = [
    /[（(]第\s*(\d+)\s*页\s*[\/／]\s*共\s*(\d+)\s*页[）)]/u,
    /[（(]第\s*(\d+)\s*页\s*[\/／]\s*(\d+)\s*页[）)]/u,
    /第\s*(\d+)\s*页\s*[\/／]\s*共\s*(\d+)\s*页/u,
    /第\s*(\d+)\s*[\/／]\s*(\d+)\s*页/u,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  }
  return null;
}

function chunkImpliesMorePages(chunk) {
  return /本章未完|未完待续|请点击下一页|下页继续|下一页继续|点击下一页继续阅读/i.test(String(chunk || ''));
}

function stripAdLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (/请记住本书|最新章节.*首发|手机阅读|章节错误|报错欠更|本站永久域名|请加入收藏/i.test(s)) return false;
      if (/本章未完|未完待续|请点击下一页|下页继续|下一页继续阅读|点击下一页继续阅读/i.test(s)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/** 顶点正文前常见行：与 h1 重复的章标题、分页提示 */
function isLeadingNoiseLine(trimmed) {
  const t = String(trimmed || '').trim();
  if (!t) return false;
  if (/^第\s*[\d零一二三四五六七八九十百千万两]+\s*章/u.test(t)) return true;
  if (/^[（(]第\s*\d+\s*\/\s*\d+\s*页[）)]$/.test(t)) return true;
  return false;
}

function stripLeadingNoise(text) {
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') { i++; continue; }
    if (isLeadingNoiseLine(t)) { i++; continue; }
    break;
  }
  return lines.slice(i).join('\n').trim();
}

async function extractChapterText(page, chapterUrl) {
  const u = new URL(chapterUrl);
  const m = u.pathname.match(/^\/du\/\d+\/\d+\/(\d+)(?:_\d+)?\.html$/i);
  if (!m) {
    // 非标准 URL，直接单页抓取
    await page.goto(chapterUrl, GOTO_OPTS);
    await waitForChapterBody(page, `正文 ${path.basename(chapterUrl)}`);
    const raw = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim()).catch(() => '');
    if (raw.length < MIN_BODY_CHARS) throw new Error(`正文过短 (${raw.length} 字): ${chapterUrl}`);
    return stripLeadingNoise(stripAdLines(raw));
  }

  const chapterId = m[1];
  const base = `${u.origin}/du/${u.pathname.match(/\/du\/(\d+\/\d+)/)[1]}/${chapterId}`;
  const parts = [];

  // 第一页
  try {
    await page.goto(`${base}.html`, GOTO_OPTS);
    await waitForChapterBody(page, `正文 ${chapterId}_1`);
  } catch {
    throw new Error(`正文首页加载失败: ${chapterUrl}`);
  }

  const firstRaw = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim()).catch(() => '');
  const firstChunk = stripLeadingNoise(stripAdLines(firstRaw));
  if (firstChunk.length < 25) throw new Error(`正文首页内容过短: ${chapterUrl}`);

  const h1 = (await page.$eval('h1', (el) => el.textContent.trim()).catch(() => '')) + ' ';
  const title = (await page.title().catch(() => '')) + ' ';
  let pageFrac = parsePageFraction(h1 + title);
  if (!pageFrac) pageFrac = parsePageFraction(firstChunk.slice(-800));
  parts.push(firstChunk);

  // 站点底栏常含"本章未完"误导标记 → 快速探测 _2.html 确认是否真有多页
  const hasMoreHint = chunkImpliesMorePages(firstRaw);
  if (!hasMoreHint && (!pageFrac || pageFrac[0] >= pageFrac[1])) {
    return stripLeadingNoise(parts.join('\n\n').trim());
  }

  const PROBE_TIMEOUT = 3000;
  let hasMorePages = false;
  try {
    await page.goto(`${base}_2.html`, { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT });
    const probeText = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim()).catch(() => '');
    if (probeText.length > 50) hasMorePages = true;
  } catch { /* 单页章节 */ }

  if (!hasMorePages) return stripLeadingNoise(parts.join('\n\n').trim());

  // 后续分页
  const SUB_PAGE_TIMEOUT = 10000;
  let shortStreak = 0;
  let pageFailStreak = 0;

  for (let pi = 2; pi <= 100; pi++) {
    const pageUrl = `${base}_${pi}.html`;
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: SUB_PAGE_TIMEOUT });
      await waitForChapterBody(page, `正文 ${chapterId}_${pi}`, SUB_PAGE_TIMEOUT);
    } catch {
      pageFailStreak++;
      if (pageFailStreak >= 3) break;
      continue;
    }
    pageFailStreak = 0;

    const raw = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim()).catch(() => '');
    const chunk = stripLeadingNoise(stripAdLines(raw));
    if (chunk.length < 50) {
      shortStreak++;
      if (shortStreak >= 3) break;
      continue;
    }
    shortStreak = 0;

    const h = (await page.$eval('h1', (el) => el.textContent.trim()).catch(() => '')) + ' ';
    const t = (await page.title().catch(() => '')) + ' ';
    let fr = parsePageFraction(h + t);
    if (!fr) fr = parsePageFraction(chunk.slice(-600));

    // 重复内容检测
    const prevPfx = (parts[parts.length - 1] || '').replace(/\s+/g, '').slice(0, 120);
    const curPfx = chunk.replace(/\s+/g, '').slice(0, 120);
    if (parts.length > 0 && curPfx && curPfx === prevPfx) break;

    parts.push(chunk);
    if (fr && fr[0] >= fr[1]) break;
    if (fr && fr[0] < fr[1]) continue;
    break;
  }

  if (parts.length === 0) throw new Error(`正文为空: ${chapterUrl}`);
  return stripLeadingNoise(parts.join('\n\n').trim());
}

// --- Main ---

function extractFlags(argv) {
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

function resolveUrlFilePath(urlFile) {
  return path.isAbsolute(urlFile) ? urlFile : path.join(PROJECT_ROOT, urlFile);
}

function readUrlFile(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.slice(2).toString('utf16be');
  return buf.toString('utf8');
}

function chaptersFromUrlFileText(raw) {
  return String(raw).replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => /^https?:\/\//i.test(l))
    .map((href) => ({ href, title: path.basename(href) }));
}

async function main() {
  const { outputDir, urlFile, mergeTitle, restArgv } = extractFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');

  const runMerge = restArgv.includes('--merge');
  const forceChapters = restArgv.includes('--force') || process.env.DDW23_FORCE === '1';
  const useFileOnly = restArgv.includes('--file');
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  if (forceChapters) console.log('[23ddw] --force：将覆盖已存在的章节 txt');

  const headed = useHeadedLaunch();
  if (headed) console.log('[23ddw] 使用有头浏览器（NOVEL_HEADLESS=0 或 DDW23_HEADED=1）');
  const storageStatePath = resolveStorageState();
  if (storageStatePath && fs.existsSync(storageStatePath)) console.log('[23ddw] 使用 storageState:', storageStatePath);

  const browser = await chromium.launch({
    headless: !headed,
    channel: headed ? 'chrome' : undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext(
    storageStatePath && fs.existsSync(storageStatePath) ? { storageState: storageStatePath } : {}
  );
  const page = await context.newPage();

  const failureLogPath = path.join(outputDir, 'ddw23_failures.jsonl');

  let chapters;
  const envListUrl = process.env.DDW23_CHAPTERS_URL?.trim();
  const discoverUrl = useFileOnly ? null : entryUrl || envListUrl || null;

  if (useFileOnly) {
    const abs = resolveUrlFilePath(urlFile);
    if (!fs.existsSync(abs)) { console.error(`--file 但未找到: ${abs}`); await browser.close(); process.exit(1); }
    chapters = chaptersFromUrlFileText(readUrlFile(abs));
    console.log(`从 ${abs} 读取 ${chapters.length} 个 URL`);
  } else if (discoverUrl) {
    console.log('[23ddw] 从书籍目录页发现章节:', discoverUrl);
    chapters = await discoverChapters(page, discoverUrl);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);
  } else {
    console.error('请传入书籍目录 URL，例如: node gaode/ddw23/scrape-23ddw.js https://www.23ddw.net/du/51/51866/');
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
      console.error(`[23ddw] 章节抓取失败 index=${i + 1}/${total} title=${title} href=${href} error=${errMsg}`);
      try {
        fs.appendFileSync(failureLogPath, JSON.stringify({
          at: new Date().toISOString(), index: i + 1, title, href, error: errMsg,
        }) + '\n', 'utf8');
      } catch (_) {}
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
