/**
 * xncwxw.net（新暖才文学网-翠微居手机版）适配：
 * 1) 传入书籍目录 URL：https://m.xncwxw.net/68_68426/
 * 2) 目录：<ul class="p2"> 内 <li><a href="/68_68426/CHAPTER_ID.html">TITLE</a></li>
 *    分页：/68426_page_2/、/68426_page_3/ …（页面底部 select 或「下一页」链接）
 * 3) 正文：#nr1 容器；章内分页 {chapterId}_2.html、{chapterId}_3.html … 自动拼接
 *
 * 用法：
 *   node gaode/xncwxw/scrape-xncwxw.js https://m.xncwxw.net/68_68426/
 *   node gaode/xncwxw/scrape-xncwxw.js https://m.xncwxw.net/68_68426/ 5
 * --out-dir= --merge --merge-title= 同其他 scraper
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 30000 };
const CONTENT_SEL = '#nr1';
const MIN_BODY_CHARS = 40;

function useHeadedLaunch() {
  return process.env.NOVEL_HEADLESS === '0' || process.env.XNCWXW_HEADED === '1';
}

function isTransientNavError(e) {
  const msg = e?.message || String(e);
  return /Execution context was destroyed/i.test(msg) ||
    /Target page, context or browser has been closed/i.test(msg) ||
    /Navigation failed/i.test(msg) ||
    /net::ERR_ABORTED/i.test(msg);
}

async function gotoWithRetry(page, url, label, maxRetries = 2) {
  // Try waitUntil:'domcontentloaded' with fallback to 'commit'
  const strategies = [
    { waitUntil: 'domcontentloaded', timeout: 30000 },
    { waitUntil: 'commit', timeout: 15000 },
  ];
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const opts of strategies) {
      try {
        await page.goto(url, opts);
        return;
      } catch (e) {
        const msg = e?.message || String(e);
        const retryable = /Timeout|ERR_CONNECTION|ERR_ABORTED|net::ERR|timeout|closed|Execution context was destroyed/i.test(msg);
        if (!retryable) break; // non-retryable: skip to next attempt
      }
    }
    const isLast = attempt === maxRetries - 1;
    if (!isLast) {
      console.warn(`  [xncwxw] ${label} 重试 ${attempt + 2}/${maxRetries}`);
      await page.waitForTimeout(3000 * (attempt + 1));
    }
  }
  // Last resort: try commit one more time and wait for content manually
  await page.goto(url, { waitUntil: 'commit', timeout: 20000 });
}

/** 从 /68_68426/ 或 /68_68426/index.html 解析 bookId */
function parseEntryUrl(entryUrl) {
  const u = new URL(entryUrl);
  const m = u.pathname.match(/^\/(\d+_\d+)\/?$/i);
  if (!m) throw new Error(`非 xncwxw.net 书籍目录 URL（需要 /{category_bookId}/）: ${entryUrl}`);
  return { origin: u.origin, bookId: m[1] };
}

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// --- Chapter discovery ---

async function extractPageChapters(page, origin) {
  return page.evaluate((origin) => {
    // 匹配 /68_68426/22013256.html 或 /68_68426/22013256_7.html
    const chapterPathRe = /^\/\d+_\d+\/(\d+)(?:_(\d+))?\.html$/i;
    const result = [];
    const seen = new Map(); // chapterId -> index in result
    for (const a of document.querySelectorAll('ul.p2 a[href]')) {
      let href = a.getAttribute('href') || '';
      if (/^javascript:/i.test(href)) continue;
      let abs, p;
      try { abs = new URL(href, origin).href; p = new URL(abs).pathname; }
      catch { continue; }
      const m = chapterPathRe.exec(p);
      if (!m) continue;
      const chapterId = m[1];
      const pageNum = m[2] ? parseInt(m[2], 10) : 0;
      if (seen.has(chapterId)) {
        // 同一章节可能有多页链接（如 22013256.html 和 22013256_7.html），取最大页数
        const idx = seen.get(chapterId);
        if (pageNum > (result[idx].maxPage || 0)) {
          result[idx].maxPage = pageNum;
          result[idx].href = abs; // 保留带页码的 URL 以便 extractChapterText 知道页数
        }
        continue;
      }
      seen.set(chapterId, result.length);
      const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
      result.push({ href: abs, title, chapterId, maxPage: pageNum });
    }
    return result;
  }, origin);
}

async function getNextCatalogUrl(page, origin, bookId) {
  return page.evaluate(({ origin, bookId }) => {
    const nextLinks = document.querySelectorAll('a.onclick, a[href*="page_"]');
    for (const a of nextLinks) {
      const text = (a.textContent || '').replace(/\s+/g, '');
      if (text === '下一页') {
        try { return new URL(a.getAttribute('href') || '', origin).href; }
        catch { return null; }
      }
    }
    return null;
  }, { origin, bookId });
}

async function discoverChapters(page, entryUrl) {
  const loc = parseEntryUrl(entryUrl);
  const catalogUrl = `${loc.origin}/${loc.bookId}/`;
  const allChapters = [];
  const seenIds = new Set();
  let currentUrl = catalogUrl;

  while (currentUrl) {
    console.log(`[xncwxw] 打开目录: ${currentUrl}`);
    await gotoWithRetry(page, currentUrl, `目录 ${path.basename(currentUrl)}`);
    await page.waitForSelector('ul.p2', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const chapters = await extractPageChapters(page, loc.origin);
    let added = 0;
    for (const ch of chapters) {
      if (!seenIds.has(ch.chapterId)) {
        seenIds.add(ch.chapterId);
        allChapters.push(ch);
        added++;
      }
    }
    console.log(`[xncwxw] 本页 ${chapters.length} 章（新增 ${added} 章，累计 ${allChapters.length} 章）`);

    currentUrl = await getNextCatalogUrl(page, loc.origin, loc.bookId);
  }

  // 目录页会把"最新"（倒序）排前面、"全部章节"排后面，按 chapterId 升序得到正确阅读顺序
  allChapters.sort((a, b) => parseInt(a.chapterId, 10) - parseInt(b.chapterId, 10));

  console.log(`[xncwxw] 目录共 ${allChapters.length} 章`);
  return allChapters;
}

// --- Chapter body ---

async function chapterBodyProbe(page) {
  try {
    return await page.evaluate((sel) => {
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
  const timeout = timeoutMs || 60000;
  const start = Date.now();
  let lastBeat = 0;

  while (Date.now() - start < timeout) {
    const probe = await chapterBodyProbe(page);
    if (probe.ok) return;
    const elapsed = (Date.now() - start) / 1000;

    // 6s 后检查是否进入了错误页面
    if (elapsed > 6 && probe.reason === 'no_body') {
      const title = await page.title().catch(() => '');
      const url = page.url().slice(0, 100);
      if (/404|not found|error|找不到|页面不存在/i.test(title) && elapsed > 10) {
        throw new Error(`进入错误页面（title=${title.slice(0, 50)} url=${url}）`);
      }
      // 30s 后 body 仍然为空，尝试刷新
      if (elapsed > 30) {
        console.warn(`[xncwxw] … 正文仍未出现，尝试刷新页面`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    if (elapsed - lastBeat >= 6) {
      lastBeat = elapsed;
      const title = await page.title().catch(() => '');
      const url = page.url().slice(0, 80);
      console.log(`[xncwxw] … 已等待 ${Math.floor(elapsed)}s | ${title.slice(0, 60)} | ${url}`);
    }
    if (probe.reason === 'navigating') await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2000);
  }
  const title = await page.title().catch(() => '');
  const url = page.url().slice(0, 100);
  throw new Error(`[xncwxw] ${phase} 正文等待超时（title=${title.slice(0, 60)} url=${url}）`);
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
      // 站点公告/广告
      if (/本站域名|新暖才文学网|百度搜索|xncwxw|新暖才/i.test(s) && /\.(com|net|me|org)/i.test(s)) return false;
      if (/即将改版|书架功能已恢复|注册登录账号/i.test(s)) return false;
      if (/本章未完|未完待续|请点击下一页|下页继续|下一页继续阅读/i.test(s)) return false;
      if (/搜索，用户注册|阅读记录|书架等功能/i.test(s)) return false;
      if (/^\(前面加https/i.test(s) || /前面加https.*可能无法访问/i.test(s)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function isLeadingNoiseLine(trimmed) {
  const t = String(trimmed || '').trim();
  if (!t) return false;
  if (/^第\s*[\d零一二三四五六七八九十百千万两]+\s*章/u.test(t)) return true;
  if (/^[（(]第\s*\d+\s*\/\s*\d+\s*页[）)]$/.test(t)) return true;
  if (/^【.*】\s*第\d+\/\d+页$/.test(t)) return true;
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
  // 匹配 /68_68426/22013256.html 或 /68_68426/22013256_7.html（多页章节）
  const m = u.pathname.match(/^\/(\d+_\d+)\/(\d+)(?:_(\d+))?\.html$/i);
  const knownMaxPage = m ? (m[3] ? parseInt(m[3], 10) : 0) : 0;
  if (!m) {
    await gotoWithRetry(page, chapterUrl, `正文 ${path.basename(chapterUrl)}`);
    await waitForChapterBody(page, `正文 ${path.basename(chapterUrl)}`);
    const raw = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim()).catch(() => '');
    if (raw.length < MIN_BODY_CHARS) throw new Error(`正文过短 (${raw.length} 字): ${chapterUrl}`);
    return stripLeadingNoise(stripAdLines(raw));
  }

  const bookId = m[1];
  const chapterId = m[2];
  const base = `${u.origin}/${bookId}/${chapterId}`;
  const parts = [];

  // 第一页
  try {
    await gotoWithRetry(page, `${base}.html`, `正文 ${chapterId}_1`);
    await waitForChapterBody(page, `正文 ${chapterId}_1`);
  } catch {
    throw new Error(`正文首页加载失败: ${chapterUrl}`);
  }

  const firstRaw = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim()).catch(() => '');
  const firstChunk = stripLeadingNoise(stripAdLines(firstRaw));
  if (firstChunk.length < 25) throw new Error(`正文首页内容过短: ${chapterUrl}`);

  const titleEl = (await page.$eval('.nr_title', (el) => el.textContent.trim()).catch(() => '')) + ' ';
  let pageFrac = parsePageFraction(titleEl);
  if (!pageFrac) pageFrac = parsePageFraction(firstChunk.slice(-800));
  // 从标题 (第1/7页) 可知总页数，避免探测 _2.html。仅 pageFrac[1] > 1 才生效
  const effectiveMaxPage = Math.max(knownMaxPage, pageFrac && pageFrac[1] > 1 ? pageFrac[1] : 0);
  parts.push(firstChunk);

  const hasMoreHint = chunkImpliesMorePages(firstRaw);
  if (!hasMoreHint && !effectiveMaxPage) {
    return stripLeadingNoise(parts.join('\n\n').trim());
  }

  // 从 URL 或标题已知页数则跳过探测，否则快速探测 _2.html
  let hasMorePages = effectiveMaxPage > 1;
  if (!hasMorePages) {
    // 快速探测 _2.html 确认是否真有多页
    try {
      await page.goto(`${base}_2.html`, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {
        return page.goto(`${base}_2.html`, { waitUntil: 'commit', timeout: 5000 }).catch(() => {});
      });
      await page.waitForTimeout(800);
      const probeText = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim()).catch(() => '');
      if (probeText.length > 50) hasMorePages = true;
    } catch { /* 单页章节 */ }
  }

  if (!hasMorePages) return stripLeadingNoise(parts.join('\n\n').trim());

  // 后续分页
  const SUB_PAGE_TIMEOUT = 10000;
  let shortStreak = 0;
  let pageFailStreak = 0;
  let startPage = 2;
  const maxLoopPage = effectiveMaxPage || 100;

  for (let pi = startPage; pi <= maxLoopPage; pi++) {
    const pageUrl = `${base}_${pi}.html`;
    try {
      await gotoWithRetry(page, pageUrl, `正文 ${chapterId}_${pi}`);
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

    const t = (await page.$eval('.nr_title', (el) => el.textContent.trim()).catch(() => '')) + ' ';
    let fr = parsePageFraction(t);
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
  const forceChapters = restArgv.includes('--force') || process.env.XNCWXW_FORCE === '1';
  const useFileOnly = restArgv.includes('--file');
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  if (forceChapters) console.log('[xncwxw] --force：将覆盖已存在的章节 txt');

  const headed = useHeadedLaunch();
  if (headed) console.log('[xncwxw] 使用有头浏览器（NOVEL_HEADLESS=0 或 XNCWXW_HEADED=1）');

  const browser = await chromium.launch({
    headless: !headed,
    channel: headed ? 'chrome' : undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(45000);
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });

  let chapters;
  const envListUrl = process.env.XNCWXW_CHAPTERS_URL?.trim();
  const discoverUrl = useFileOnly ? null : entryUrl || envListUrl || null;

  if (useFileOnly) {
    const abs = resolveUrlFilePath(urlFile);
    if (!fs.existsSync(abs)) { console.error(`--file 但未找到: ${abs}`); await browser.close(); process.exit(1); }
    chapters = chaptersFromUrlFileText(readUrlFile(abs));
    console.log(`[xncwxw] 从 ${abs} 读取 ${chapters.length} 个 URL`);
  } else if (discoverUrl) {
    console.log('[xncwxw] 从书籍目录页发现章节:', discoverUrl);
    chapters = await discoverChapters(page, discoverUrl);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`[xncwxw] 已写入 ${manifestFile}，共 ${chapters.length} 章`);
  } else {
    console.error('请传入书籍目录 URL，例如: node gaode/xncwxw/scrape-xncwxw.js https://m.xncwxw.net/68_68426/');
    await browser.close();
    process.exit(1);
  }

  if (Number.isFinite(maxChapters) && maxChapters > 0) {
    chapters = chapters.slice(0, maxChapters);
    console.log(`[xncwxw] 限制为前 ${maxChapters} 章`);
  }

  const total = chapters.length;
  if (total === 0) {
    await browser.close();
    console.error('[xncwxw] 未得到任何章节 URL');
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
      console.error(`[xncwxw] 章节抓取失败 index=${i + 1}/${total} title=${title} href=${href} error=${errMsg}`);
    }
  }

  await browser.close();
  console.log('[xncwxw] 完成，输出目录:', path.resolve(outputDir));

  if (runMerge) {
    const { mergeNovel } = require(MERGE_NOVEL);
    mergeNovel({ inputDir: outputDir, ...(mergeTitle ? { bookTitle: mergeTitle } : {}) });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
