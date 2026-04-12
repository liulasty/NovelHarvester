/**
 * nzxs.cc（女主小说）工作流：
 *
 * A) 旧版书籍页 /book/{id}/（或 /book/{id}/n/）
 *    在 #novel_info 下解析「章节列表」→ ul.chapter-list；「查看更多章节」→ /book/{id}/1/ 再合并去重。
 *
 * B) 新版 html 详情页 /html/{书数字id}/index.html
 *    首页含「最新章节」短列表 + 「章节列表」约 20 条；点「查看更多章节」进入分页目录
 *    /html/{分类id}/{书数字id}/{页码}/（如 /html/5001/5001591/1/、…/2/…），每页约 20 条正文链接。
 *    脚本会先抓 index，再自动遍历 N=1,2,… 直至连续两页无新增章节链接。
 *
 * 3) 逐章打开阅读页，从 #txt 取正文；章内多页为同 id 的 _1.html、_2.html…（与 h1「（第N页）」递增一致，回卷到第1页则停止）
 *
 * 用法：
 *   node gaode/nzxs/scrape-nzxs.js https://www.nzxs.cc/book/352626/
 *   node gaode/nzxs/scrape-nzxs.js https://www.nzxs.cc/html/5001591/index.html
 *   node gaode/nzxs/scrape-nzxs.js https://www.nzxs.cc/html/5001/5001591/1/
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
  if (!m) throw new Error(`非 nzxs /book/ 目录 URL: ${bookPageUrl}`);
  return `${u.origin}/book/${m[1]}/`;
}

function bookIdFromUrl(bookPageUrl) {
  const m = String(new URL(bookPageUrl).pathname).match(/^\/book\/(\d+)/);
  return m ? m[1] : '';
}

/** /html/5001591/index.html → 书数字 id（用于匹配分页 URL 中段） */
function htmlIndexFolderId(entryUrl) {
  const m = String(new URL(entryUrl).pathname).match(/^\/html\/(\d+)\/index\.html$/i);
  return m ? m[1] : '';
}

/**
 * 在 index 页上找「查看更多章节」等指向 /html/{分类}/{书id}/{页}/ 的链接，返回 { categoryId, bookId }。
 */
async function findHtmlPaginatedCatalogParams(page, folderBookId) {
  return page.evaluate((folderId) => {
    const anchors = [...document.querySelectorAll('a[href]')];
    let best = null;
    for (const a of anchors) {
      const raw = a.getAttribute('href') || '';
      let pathname = '';
      try {
        pathname = new URL(raw, location.origin).pathname;
      } catch {
        continue;
      }
      const m = pathname.match(/^\/html\/(\d+)\/(\d+)\/(\d+)\/?$/);
      if (!m || m[2] !== String(folderId)) continue;
      const categoryId = m[1];
      const bookId = m[2];
      const pageNum = parseInt(m[3], 10);
      const t = (a.textContent || '').replace(/\s+/g, '').trim();
      const preferred =
        /查看更多章节|阅读更多章节|更多章节|章节目录|全部章节/.test(t) || a.classList.contains('btn-mulu');
      const score = (preferred ? 0 : 1000) + pageNum;
      if (!best || score < best.score) {
        best = { categoryId, bookId, pageNum, score };
      }
    }
    return best;
  }, folderBookId);
}

/**
 * 从当前书籍目录页收集「章节列表」区块下的链接（忽略「最新章节」短列表）。
 * 第二页模板可能没有 #novel_info，则退回：取页面中「最长」的 ul.chapter-list（链接最多）。
 */
async function extractCatalogChapterLinks(page) {
  return page.evaluate(() => {
    /** 旧版 /read/a/b.html；新版 html 目录站 /reads/分类/书id/章节id.html */
    function isChapterReadPath(pathname) {
      if (/^\/read\/\d+\/\d+(?:_\d+)?\.html$/i.test(pathname)) return true;
      if (/^\/reads\/\d+\/\d+\/\d+(?:_\d+)?\.html$/i.test(pathname)) return true;
      return false;
    }

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
        if (!isChapterReadPath(new URL(href).pathname)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        let title = titleFromAnchor(a);
        if (!title || title === '开始阅读') {
          const m = href.match(/\/(?:read|reads)\/(?:\d+\/)?\d+\/(\d+)(?:_\d+)?\.html$/i);
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

const MAX_HTML_CATALOG_PAGES = 5000;
/** 分页目录常夹带与首页重复的「最新」链接，易出现多页 added=0；阈值过小会提前截断 */
const HTML_CATALOG_EMPTY_STREAK = 5;

function createCatalogVisitor(page) {
  const seenListUrls = new Set();
  const byHref = new Map();
  const ordered = [];

  const visitList = async (listUrl) => {
    if (seenListUrls.has(listUrl)) return 0;
    seenListUrls.add(listUrl);
    try {
      await page.goto(listUrl, GOTO_LIST_OPTS);
    } catch (e) {
      const msg = e?.message || String(e);
      console.warn(`[nzxs] 目录 networkidle 失败，改用 domcontentloaded: ${listUrl} (${msg.slice(0, 100)})`);
      try {
        await page.goto(listUrl, GOTO_OPTS);
      } catch (e2) {
        console.warn(`[nzxs] 目录页跳过: ${listUrl} — ${e2?.message || e2}`);
        return 0;
      }
    }
    await page.waitForSelector('ul.chapter-list', { timeout: 25000 }).catch(() => {});

    const chunk = await extractCatalogChapterLinks(page);
    if (!chunk.ok) {
      console.warn(`目录页解析: ${listUrl} → ${chunk.reason}，本页 0 条`);
    }
    let added = 0;
    for (const { href, title } of chunk.links) {
      if (byHref.has(href)) continue;
      byHref.set(href, title);
      ordered.push({ href, title });
      added++;
    }
    return added;
  };

  return { visitList, ordered };
}

async function discoverChaptersBookTemplate(page, entryUrl) {
  const root = bookCatalogRootUrl(entryUrl);
  const bookId = bookIdFromUrl(entryUrl);
  const { visitList, ordered } = createCatalogVisitor(page);

  await visitList(root);

  const moreHref = await findMoreCatalogHref(page, bookId);
  if (moreHref && moreHref !== root) {
    await visitList(moreHref);
  }

  return ordered;
}

/**
 * 从 /html/{分类}/{书id}/{页}/ 只跑分页（也可直接传此类 URL 作为入口）。
 */
async function discoverChaptersHtmlPaginatedOnly(page, origin, categoryId, bookId) {
  const { visitList, ordered } = createCatalogVisitor(page);
  let stagnant = 0;
  for (let pageNum = 1; pageNum <= MAX_HTML_CATALOG_PAGES; pageNum++) {
    const listUrl = `${origin}/html/${categoryId}/${bookId}/${pageNum}/`;
    const added = await visitList(listUrl);
    if (added === 0) {
      stagnant++;
      if (stagnant >= HTML_CATALOG_EMPTY_STREAK) {
        console.log(`[nzxs] html 目录连续 ${stagnant} 页无新章节链接，停止于页 ${pageNum}`);
        break;
      }
    } else {
      stagnant = 0;
    }
  }
  return ordered;
}

async function discoverChaptersHtmlIndex(page, entryUrl) {
  const u = new URL(entryUrl);
  const folderId = htmlIndexFolderId(entryUrl);
  if (!folderId) throw new Error(`非 nzxs html index URL: ${entryUrl}`);

  const { visitList, ordered } = createCatalogVisitor(page);
  await visitList(u.href.split('#')[0]);

  const params = await findHtmlPaginatedCatalogParams(page, folderId);
  if (!params) {
    console.warn('[nzxs] 未找到 html 分页目录（查看更多章节），仅使用 index 页已采集链接');
    return ordered;
  }

  const { categoryId, bookId } = params;
  console.log(`[nzxs] html 分页目录: /html/${categoryId}/${bookId}/1/ …`);

  let stagnant = 0;
  for (let pageNum = 1; pageNum <= MAX_HTML_CATALOG_PAGES; pageNum++) {
    const listUrl = `${u.origin}/html/${categoryId}/${bookId}/${pageNum}/`;
    const added = await visitList(listUrl);
    if (added === 0) {
      stagnant++;
      if (stagnant >= HTML_CATALOG_EMPTY_STREAK) {
        console.log(`[nzxs] html 目录连续 ${stagnant} 页无新章节链接，停止于页 ${pageNum}`);
        break;
      }
    } else {
      stagnant = 0;
    }
  }

  return ordered;
}

async function discoverChapters(page, entryUrl) {
  const u = new URL(entryUrl);
  const pathname = u.pathname;

  if (/^\/book\/\d+/i.test(pathname)) {
    return discoverChaptersBookTemplate(page, entryUrl);
  }

  if (/^\/html\/\d+\/index\.html$/i.test(pathname)) {
    return discoverChaptersHtmlIndex(page, entryUrl);
  }

  const htmlCat = pathname.match(/^\/html\/(\d+)\/(\d+)\/(\d+)\/?$/i);
  if (htmlCat) {
    const categoryId = htmlCat[1];
    const bookId = htmlCat[2];
    console.log(`[nzxs] 入口为分页目录，将自第 1 页遍历 /html/${categoryId}/${bookId}/N/`);
    return discoverChaptersHtmlPaginatedOnly(page, u.origin, categoryId, bookId);
  }

  throw new Error(
    `非 nzxs 支持的目录 URL（需 /book/{id}/ 、 /html/{id}/index.html 或 /html/{分类}/{书id}/{页}/）: ${entryUrl}`
  );
}

function parseChapterFileStem(chapterUrl) {
  const u = new URL(chapterUrl);
  let m = u.pathname.match(/^\/read\/(\d+)\/(\d+)(?:_(\d+))?\.html$/i);
  if (m) {
    return { mode: 'read', origin: u.origin, bookNum: m[1], baseId: m[2], suffix: m[3] };
  }
  m = u.pathname.match(/^\/reads\/(\d+)\/(\d+)\/(\d+)(?:_(\d+))?\.html$/i);
  if (m) {
    return { mode: 'reads', origin: u.origin, categoryId: m[1], bookNum: m[2], baseId: m[3], suffix: m[4] };
  }
  return null;
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
  const { origin, mode, baseId } = stem;
  const parts = [];
  let prevPageNum = 0;

  const chapterPageUrl = (i) => {
    if (mode === 'read') {
      const { bookNum } = stem;
      return i === 0
        ? `${origin}/read/${bookNum}/${baseId}.html`
        : `${origin}/read/${bookNum}/${baseId}_${i}.html`;
    }
    const { categoryId, bookNum } = stem;
    return i === 0
      ? `${origin}/reads/${categoryId}/${bookNum}/${baseId}.html`
      : `${origin}/reads/${categoryId}/${bookNum}/${baseId}_${i}.html`;
  };

  for (let i = 0; ; i++) {
    const url = chapterPageUrl(i);

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
