/**
 * 69xku.com（69库）书籍页目录：
 * 1) 传入书籍页：`https://69xku.com/book/{书籍数字}/`
 * 2) 目录：`dl.book.chapterlist > dd > a` 为「最新章节」区块；`#list-chapterAll dd > a` 为「全部章节目录」。
 *    合并规则与 bookszw 类似：正文区按章号排序；仅出现在最新区且不在全书的链接排在 manifest 末尾。
 * 3) 正文：`#rtext` / `.readcontent`（在 `#acontent` 内）
 *
 * 用法：
 *   node gaode/69xku/scrape-69xku.js https://69xku.com/book/49851/
 *   node gaode/69xku/scrape-69xku.js https://69xku.com/book/49851/ 5
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 90000 };
const CONTENT_SELECTORS = ['#rtext', '.readcontent', '#chaptercontent', '#content'];

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

      return { main: dedupe(main), latest: dedupe(latest) };
    },
    { origin: loc.origin, bookId: loc.bookId }
  );
}

async function discoverChapters(page, entryUrl) {
  const u = new URL(entryUrl);
  const loc = parseBookEntryUrl(u.href);
  const listUrl = catalogUrl(loc);

  console.log(`[69xku] 打开: ${listUrl}`);
  await page.goto(listUrl, GOTO_OPTS);
  await page.waitForSelector('dl.book.chapterlist, #list-chapterAll', { timeout: 60000 });

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
  await page.goto(chapterUrl, GOTO_OPTS);
  await page.waitForSelector(CONTENT_SELECTORS.join(','), { timeout: 45000 });
  const sel = await resolveContentSelector(page);
  await page.waitForSelector(sel, { timeout: 20000 });
  const raw = await page.$eval(sel, (el) => el.innerText.trim());
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

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

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
