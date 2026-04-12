/**
 * nzxs.cc（女主小说）工作流：
 * 1) 传入书籍页 URL（/book/{id}/ 或 /book/{id}/n/），在 #novel_info 下解析「章节列表」对应 ul.chapter-list
 * 2) 若存在「阅读更多章节 / 查看更多章节」等入口（常见为 a.btn-mulu，href 如 /book/{id}/1/），再抓第二页目录并顺序拼接（去重 href）
 * 3) 逐章打开阅读页，从 #txt 取正文；章内多页为同 id 的 _1.html、_2.html…（与 h1「（第N页）」递增一致，回卷到第1页则停止）
 *
 * 用法：
 *   node gaode/nzxs/scrape-nzxs.js https://www.nzxs.cc/book/352626/
 *   node gaode/nzxs/scrape-nzxs.js https://www.nzxs.cc/book/352626/ 3
 * --out-dir= --merge --merge-title=  --file --url-file=  与 book18/diyibanzhu 一致
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const CONTENT_SEL = '#txt';
const DEFAULT_URL_FILE = 'chapters_urls.txt';
const DEFAULT_CHAPTERS_LIST_URL = 'https://www.nzxs.cc/book/352626/';

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 60000 };
const GOTO_LIST_OPTS = { waitUntil: 'networkidle', timeout: 90000 };

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** /book/352626/ 或 /book/352626/1/ → https://origin/book/352626/ */
function bookCatalogRootUrl(bookPageUrl) {
  const u = new URL(bookPageUrl);
  const m = u.pathname.match(/^\/book\/(\d+)/);
  if (!m) throw new Error(`非 nzxs 书籍目录 URL: ${bookPageUrl}`);
  return `${u.origin}/book/${m[1]}/`;
}

function bookIdFromUrl(bookPageUrl) {
  const m = String(new URL(bookPageUrl).pathname).match(/^\/book\/(\d+)/);
  return m ? m[1] : '';
}

/**
 * 从当前书籍目录页收集「章节列表」区块下的链接（忽略「最新章节」短列表）。
 * 第二页模板可能没有 #novel_info，则退回：取页面中「最长」的 ul.chapter-list（链接最多）。
 */
async function extractCatalogChapterLinks(page) {
  return page.evaluate(() => {
    const readRe = /^\/read\/\d+\/\d+(?:_\d+)?\.html$/i;

    function titleFromAnchor(a) {
      return (a.textContent || '')
        .replace(/[\s\u00a0]+/g, ' ')
        .replace(/<[^>]+>/g, '')
        .trim();
    }

    function linksFromUl(ul) {
      const out = [];
      const seen = new Set();
      for (const a of ul.querySelectorAll('a[href]')) {
        let href = a.getAttribute('href') || '';
        try {
          href = new URL(href, location.origin).href;
        } catch {
          continue;
        }
        if (!readRe.test(new URL(href).pathname)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        let title = titleFromAnchor(a);
        if (!title || title === '开始阅读') {
          const m = href.match(/\/read\/\d+\/(\d+)\.html$/i);
          title = m ? `章节_${m[1]}` : href;
        }
        out.push({ href, title });
      }
      return out;
    }

    const novel = document.querySelector('#novel_info');
    if (novel) {
      const heads = [...novel.querySelectorAll('h3.wrap-title')];
      const idx = heads.findIndex((h) => (h.textContent || '').trim() === '章节列表');
      if (idx >= 0) {
        let el = heads[idx].nextElementSibling;
        while (el) {
          const ul = el.querySelector?.('ul.chapter-list') || (el.matches?.('ul.chapter-list') ? el : null);
          if (ul) {
            const links = linksFromUl(ul);
            if (links.length) return { ok: true, links };
          }
          el = el.nextElementSibling;
        }
      }
    }

    const lists = [...document.querySelectorAll('ul.chapter-list')];
    if (!lists.length) return { ok: false, reason: 'no_chapter_list', links: [] };
    lists.sort((a, b) => b.querySelectorAll('a[href]').length - a.querySelectorAll('a[href]').length);
    const links = linksFromUl(lists[0]);
    return links.length ? { ok: true, links } : { ok: false, reason: 'empty_chapter_list', links: [] };
  });
}

async function findMoreCatalogHref(page, bookId) {
  if (!bookId) return null;
  return page.evaluate((bid) => {
    const want = new RegExp(`^/book/${bid}/\\d+/\\/?$`);
    const anchors = [...document.querySelectorAll('a[href]')];
    for (const a of anchors) {
      const raw = a.getAttribute('href') || '';
      let abs = '';
      try {
        abs = new URL(raw, location.origin).href;
      } catch {
        continue;
      }
      let p = '';
      try {
        p = new URL(abs).pathname;
      } catch {
        continue;
      }
      if (!want.test(p)) continue;
      const t = (a.textContent || '').replace(/\s+/g, '').trim();
      if (/阅读更多章节|查看更多章节|更多章节|章节目录/.test(t) || a.classList.contains('btn-mulu')) {
        return abs;
      }
    }
    return null;
  }, bookId);
}

async function discoverChapters(page, entryUrl) {
  const root = bookCatalogRootUrl(entryUrl);
  const bookId = bookIdFromUrl(entryUrl);
  const seenListUrls = new Set();
  const byHref = new Map();
  const ordered = [];

  const visitList = async (listUrl) => {
    if (seenListUrls.has(listUrl)) return;
    seenListUrls.add(listUrl);
    await page.goto(listUrl, GOTO_LIST_OPTS);
    await page.waitForSelector('ul.chapter-list', { timeout: 25000 }).catch(() => {});

    const chunk = await extractCatalogChapterLinks(page);
    if (!chunk.ok) {
      console.warn(`目录页解析: ${listUrl} → ${chunk.reason}，本页 0 条`);
    }
    for (const { href, title } of chunk.links) {
      if (byHref.has(href)) continue;
      byHref.set(href, title);
      ordered.push({ href, title });
    }
  };

  await visitList(root);

  const moreHref = await findMoreCatalogHref(page, bookId);
  if (moreHref && moreHref !== root) {
    await visitList(moreHref);
  }

  return ordered;
}

function parseChapterFileStem(chapterUrl) {
  const u = new URL(chapterUrl);
  const m = u.pathname.match(/\/read\/(\d+)\/(\d+)(?:_(\d+))?\.html$/i);
  if (!m) return null;
  return { bookNum: m[1], baseId: m[2], origin: u.origin, suffix: m[3] };
}

function stripAdLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (/一秒记住新域名/.test(s)) return false;
      if (/请勿开启浏览器阅读模式/.test(s)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

async function extractOneTxtScreen(page, url) {
  await page.goto(url, GOTO_OPTS);
  await page.waitForSelector(CONTENT_SEL, { timeout: 25000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('#txt');
      if (!el) return false;
      const t = (el.innerText || '').trim();
      return t.length > 80;
    },
    { timeout: 20000 }
  );
  const raw = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim());
  return stripAdLines(raw);
}

/**
 * 章内分页：…/84692256.html 为第1页，84692256_1.html 为第2页…
 * 超出末页时站点会回到「（第1页）」，或页码不再递增，据此停止。
 */
async function extractChapterPlainText(page, chapterUrl) {
  const stem = parseChapterFileStem(chapterUrl);
  if (!stem) {
    return extractOneTxtScreen(page, chapterUrl);
  }
  const { origin, bookNum, baseId } = stem;
  const parts = [];
  let prevPageNum = 0;

  for (let i = 0; ; i++) {
    const url =
      i === 0
        ? `${origin}/read/${bookNum}/${baseId}.html`
        : `${origin}/read/${bookNum}/${baseId}_${i}.html`;

    await page.goto(url, GOTO_OPTS);
    await page.waitForSelector(CONTENT_SEL, { timeout: 25000 }).catch(() => null);
    const h1 = await page.$eval('h1', (el) => (el.textContent || '').trim()).catch(() => '');
    const m = h1.match(/（第(\d+)页）/);
    const pageNum = m ? parseInt(m[1], 10) : 0;
    if (i >= 1 && pageNum === 1) break;
    if (i >= 1 && pageNum !== prevPageNum + 1) break;

    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('#txt');
          return el && (el.innerText || '').trim().length > 50;
        },
        { timeout: 20000 }
      )
      .catch(() => {});

    const raw = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim()).catch(() => '');
    const chunk = stripAdLines(raw);
    if (!chunk) break;
    parts.push(chunk);
    prevPageNum = pageNum || i + 1;
    if (!m && i > 0) break;
  }

  return parts.join('\n\n').trim();
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
  const envListUrl = process.env.NZXS_CHAPTERS_URL?.trim();
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
    console.log('从书籍目录页发现章节:', discoverUrl);
    chapters = await discoverChapters(page, discoverUrl);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);
  } else if (fs.existsSync(resolveUrlFilePath(urlFile))) {
    const urlFileAbs = resolveUrlFilePath(urlFile);
    chapters = chaptersFromUrlFileText(readUrlFileSync(urlFileAbs));
    console.log(`从 ${urlFileAbs} 读取 ${chapters.length} 个 URL`);
  } else {
    console.log('未传 URL、未设置 NZXS_CHAPTERS_URL，且缺少 URL 列表文件，使用默认书籍页');
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
    console.error('未得到任何章节 URL。请确认 nzxs 书籍页或 ul.chapter-list。');
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
