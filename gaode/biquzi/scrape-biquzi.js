/**
 * biquzi.com（笔趣小说）工作流：
 * 1) 传入书籍目录 URL：`https://www.biquzi.com/{bookPath}/`（如 /336_336278/）
 * 2) 目录：多个 `.block-box`（h3.wrap-title 区分为「最新章节」「章节列表」），
 *    章节链接匹配 `/^{bookPath}/{章节id}.html`，按 ddw23 的 mergeChapterLists 逻辑合并去重
 * 3) 正文：`.content div.txt`；章节内分页由 `#pb_next` 驱动：
 *    第 1 页 = `{id}.html`，第 N 页 = `{id}_{N-1}.html`；`#pb_next` 指向同一章 `{id}_K.html` 时继续翻页，
 *    指向其他章节 id 时即为最后一页。
 * 4) 清洗：剔除「请退出浏览器阅读模式」提示行与行尾 `myJs.bookJs1();` 脚本调用
 *
 * 站点带 JS cookie 校验（ge_js_validator），由 Playwright 自动执行脚本 + reload 通过。
 * 浏览器使用系统 Chrome（channel:'chrome'），兼容无头/有头（NOVEL_HEADLESS=0 有头）。
 *
 * 用法：
 *   node gaode/biquzi/scrape-biquzi.js https://www.biquzi.com/336_336278/
 *   node gaode/biquzi/scrape-biquzi.js https://www.biquzi.com/336_336278/ 5
 * --out-dir= --merge --merge-title= 同其他 scraper
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { chineseNumeralToInt } = require(path.join(__dirname, '..', 'lib', 'chinese-numeral.js'));

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 60000 };
const MIN_BODY_CHARS = 25;
const CONTENT_SEL = '.content div.txt';

function useHeadedLaunch() {
  return process.env.NOVEL_HEADLESS === '0' || process.env.BIQUZI_HEADED === '1';
}

function isTransientNavError(e) {
  const msg = e?.message || String(e);
  return /Execution context was destroyed/i.test(msg) ||
    /Target page, context or browser has been closed/i.test(msg) ||
    /Navigation failed/i.test(msg) ||
    /net::ERR_ABORTED/i.test(msg) ||
    /most likely because of a navigation/i.test(msg);
}

/** 从目录 URL（或章节 URL）→ { origin, bookPath, catalogUrl } */
function parseEntryUrl(entryUrl) {
  const u = new URL(entryUrl);
  const m = u.pathname.match(/^\/(.+?)\/?$/);
  if (!m) throw new Error(`非 biquzi.com 书籍目录 URL: ${entryUrl}`);
  let bookPath = m[1];
  const ch = bookPath.match(/^(.+?)\/\d+(?:_\d+)?\.html$/i);
  if (ch) bookPath = ch[1];
  return { origin: u.origin, bookPath, catalogUrl: `${u.origin}/${bookPath}/` };
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

/** 与 ddw23 相同：全量区在前、最新章节区仅补尾，按章号去重排序 */
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

  const byNum = new Map();
  for (const x of byHref.values()) {
    const num = chapterNumberFromTitle(x.title);
    if (num == null || Number.isNaN(num)) continue;
    const existing = byNum.get(num);
    if (!existing) { byNum.set(num, x); continue; }
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
      ({ origin, bookPath }) => {
        const re = new RegExp(`^/${bookPath}/\\d+\\.html$`, 'i');
        const hit = [...document.querySelectorAll('a[href]')].some((a) => {
          try { return re.test(new URL(a.getAttribute('href') || '', origin).pathname); }
          catch { return false; }
        });
        return hit ? { ok: true } : { ok: false, reason: 'no_chapter_links' };
      },
      { origin: loc.origin, bookPath: loc.bookPath }
    );
  } catch (e) {
    if (isTransientNavError(e)) return { ok: false, reason: 'navigating' };
    throw e;
  }
}

async function waitForCatalogReady(page, phase, loc) {
  const timeout = parseInt(process.env.BIQUZI_CATALOG_TIMEOUT_MS || '45000', 10);
  const start = Date.now();
  let lastBeat = 0;

  console.log(`[biquzi] ${phase}: 等待章节链接（最长 ${Math.round(timeout / 1000)}s）`);
  while (Date.now() - start < timeout) {
    const probe = await catalogReadyProbe(page, loc);
    if (probe.ok) return;
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed - lastBeat >= 8) {
      lastBeat = elapsed;
      console.log(`[biquzi] … 已等待 ${Math.floor(elapsed)}s | ${(await page.title().catch(() => '')).slice(0, 70)}`);
    }
    if (probe.reason === 'navigating') await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
  }
  throw new Error(`[biquzi] ${phase} 等待超时（title=${(await page.title().catch(() => '')).slice(0, 80)}）`);
}

async function extractChapterLinks(page, loc) {
  return page.evaluate(
    ({ origin, bookPath }) => {
      const chapterRe = new RegExp(`^/${bookPath}/(\\d+)(?:_\\d+)?\\.html$`, 'i');

      function pushValid(arr, a) {
        let href = a.getAttribute('href') || '';
        if (/^javascript:/i.test(href)) return;
        let abs, p;
        try { abs = new URL(href, origin).href; p = new URL(abs).pathname; }
        catch { return; }
        const m = chapterRe.exec(p);
        if (!m) return;
        const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
        arr.push({ href: abs, title, chapterId: m[1] });
      }

      const dedupe = (arr) => {
        const seen = new Set();
        return arr.filter((x) => { if (seen.has(x.href)) return false; seen.add(x.href); return true; });
      };

      const main = [];
      const latest = [];
      // h3.wrap-title 是 .block-box 的前一个兄弟节点，不在 box 内部
      for (const head of document.querySelectorAll('h3.wrap-title')) {
        const box = head.nextElementSibling;
        if (!box || !box.classList.contains('block-box')) continue;
        const headText = (head.textContent || '').replace(/\s+/g, ' ').trim();
        const bucket = /最新章节/.test(headText) ? latest : main;
        for (const a of box.querySelectorAll('ul.chapter-list a[href]')) pushValid(bucket, a);
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
    { origin: loc.origin, bookPath: loc.bookPath }
  );
}

async function discoverChapters(page, entryUrl) {
  const loc = parseEntryUrl(entryUrl);
  console.log(`[biquzi] 打开: ${loc.catalogUrl}`);
  await page.goto(loc.catalogUrl, GOTO_OPTS);
  await waitForCatalogReady(page, `目录 ${loc.catalogUrl}`, loc);

  const { main, latest } = await extractChapterLinks(page, loc);
  console.log(`[biquzi] 目录: 全量区 ${main.length} 条, 最新章节区 ${latest.length} 条`);

  const merged = mergeChapterLists(main, latest);
  console.log(`[biquzi] 合并去重后共 ${merged.length} 章`);
  return merged;
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
  const timeout = timeoutMs || parseInt(process.env.BIQUZI_BODY_TIMEOUT_MS || '30000', 10);
  const start = Date.now();

  console.log(`[biquzi] ${phase}: 等待正文容器（最长 ${Math.round(timeout / 1000)}s）…`);
  while (Date.now() - start < timeout) {
    const probe = await chapterTextReady(page);
    if (probe.ok) return;
    if (probe.reason === 'navigating') await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
  }
  throw new Error(`[biquzi] ${phase} 正文等待超时（title=${(await page.title().catch(() => '')).slice(0, 80)}）`);
}

/** 剔除阅读模式提示行与行尾脚本调用 */
function cleanBodyText(raw) {
  let text = String(raw || '').replace(/\r\n?/g, '\n');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/请退出浏览器阅读模式/.test(l) && !/^myJs\.\w+\(\);?$/.test(l));
  return lines
    .join('\n')
    .replace(/\s*myJs\.\w+\(\);\s*$/g, '')
    .trim();
}

async function extractChapterText(page, chapterUrl) {
  const u = new URL(chapterUrl);
  const m = u.pathname.match(/^\/(.+?)\/(\d+)(?:_\d+)?\.html$/i);
  if (!m) throw new Error(`非 biquzi 章节 URL: ${chapterUrl}`);
  const bookPath = m[1];
  const chapterId = m[2];
  const origin = u.origin;

  const parts = [];
  let currentUrl = `${origin}/${bookPath}/${chapterId}.html`;
  const MAX_PAGES = 40;

  for (let pi = 0; pi < MAX_PAGES; pi++) {
    try {
      await page.goto(currentUrl, GOTO_OPTS);
      await waitForChapterText(page, `正文 ${chapterId}_p${pi + 1}`);
    } catch (e) {
      if (parts.length === 0) throw new Error(`正文首页加载失败: ${chapterUrl} (${e?.message || e})`);
      break;
    }

    const raw = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim()).catch(() => '');
    const chunk = cleanBodyText(raw);
    if (chunk.length < MIN_BODY_CHARS) {
      if (parts.length === 0) throw new Error(`正文首页内容过短 (${chunk.length} 字): ${chapterUrl}`);
      break;
    }

    if (parts.length > 0) {
      const prevPfx = parts[parts.length - 1].replace(/\s+/g, '').slice(0, 120);
      const curPfx = chunk.replace(/\s+/g, '').slice(0, 120);
      if (curPfx && curPfx === prevPfx) break;
    }
    parts.push(chunk);

    const nextHref = await page.$eval('#pb_next', (el) => el.getAttribute('href')).catch(() => '');
    const nextRe = new RegExp(`^/${bookPath}/${chapterId}_(\\d+)\\.html$`, 'i');
    if (!nextRe.test(String(nextHref || ''))) break;
    currentUrl = new URL(nextHref, origin).href;
  }

  if (parts.length === 0) throw new Error(`正文为空: ${chapterUrl}`);
  return parts.join('\n\n').trim();
}

// --- Main ---

function extractFlags(argv) {
  let outputDir = process.env.NOVEL_OUTPUT_DIR?.trim() || 'novel-output';
  let mergeTitle = '';
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--out-dir=')) outputDir = a.slice(10).trim();
    else if (a.startsWith('--merge-title=')) mergeTitle = a.slice(14).trim();
    else rest.push(a);
  }
  return { outputDir, mergeTitle, restArgv: rest };
}

async function main() {
  const { outputDir, mergeTitle, restArgv } = extractFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');

  const runMerge = restArgv.includes('--merge');
  const forceChapters = restArgv.includes('--force') || process.env.BIQUZI_FORCE === '1';
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  if (forceChapters) console.log('[biquzi] --force：将覆盖已存在的章节 txt');

  const headed = useHeadedLaunch();
  if (headed) console.log('[biquzi] 使用有头浏览器（NOVEL_HEADLESS=0 或 BIQUZI_HEADED=1）');

  const browser = await chromium.launch({
    headless: !headed,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const failureLogPath = path.join(outputDir, 'biquzi_failures.jsonl');

  let chapters;
  if (entryUrl) {
    console.log('[biquzi] 从书籍目录页发现章节:', entryUrl);
    chapters = await discoverChapters(page, entryUrl);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);
  } else {
    console.error('请传入书籍目录 URL，例如: node gaode/biquzi/scrape-biquzi.js https://www.biquzi.com/336_336278/');
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
      console.error(`[biquzi] 章节抓取失败 index=${i + 1}/${total} title=${title} href=${href} error=${errMsg}`);
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
