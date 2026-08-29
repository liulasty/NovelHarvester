/**
 * 73书院（73shu.cc）工作流：
 * 1) 传入书籍目录 URL：`http://www.73shu.cc/{分类}/{书籍id}/`
 * 2) 目录：`#maina dl.chapter-list dd a` 单页全量章节（部分书目录只有 15 章）
 * 3) 正文：`#content` 单屏，无章内分页；「下一页」即下一章（顺序数字 ID）
 *
 * 注意：www.73shu.com 已停站（返回「抱歉，站点关闭」桩页）；www.73shu.cc 为同一站点镜像。
 *   传 .com URL 时脚本会自动改写为 .cc。
 *
 * 用法：
 *   node gaode/73shu/scrape-73shu.js http://www.73shu.cc/124/124192/
 *   node gaode/73shu/scrape-73shu.js http://www.73shu.cc/124/124192/ 5
 * --out-dir= --merge --merge-title= 同其他 scraper
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  sanitizeFilePart,
  isTransientNavError,
  stripAdLines,
  stripLeadingNoise,
  extractFlags,
  useHeadedLaunch,
  appendFailureLog,
} = require(path.join(__dirname, '..', 'lib', 'scraper-common.js'));

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 60000 };
const CONTENT_SEL = '#content';
const CHAPTER_LIST_SEL = 'dl.chapter-list dd a';
const MIN_BODY_CHARS = 40;

const STRIP_OPTS = {
  adRe: /请记住本书|最新章节.*首发|手机阅读|章节错误|报错欠更|本站永久域名|请加入收藏/i,
  pageRe: /本章未完|未完待续|请点击下一页|下页继续|下一页继续阅读|点击下一页继续阅读/i,
};

/** 已知停站域名 → 存活镜像（.com 已返回「抱歉，站点关闭」空壳） */
const MIRROR_MAP = {
  'www.73shu.com': 'www.73shu.cc',
  '73shu.com': 'www.73shu.cc',
};

function applyMirrorRewrite(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, '');
    if (MIRROR_MAP[host]) {
      const mapped = new URL(u.href);
      mapped.hostname = MIRROR_MAP[host];
      return { url: mapped.href, rewritten: true };
    }
  } catch {}
  return { url: rawUrl, rewritten: false };
}

/** 从 /124/124192/ → { origin, category: '124', bookId: '124192' } */
function parseEntryUrl(entryUrl) {
  const u = new URL(entryUrl);
  const m = u.pathname.match(/^\/(\d+)\/(\d+)\/?$/);
  if (!m) throw new Error(`非 73shu 书籍目录 URL（需 /{分类}/{书籍id}/）: ${entryUrl}`);
  return { origin: u.origin, category: m[1], bookId: m[2] };
}

function catalogUrl(loc) {
  return `${loc.origin}/${loc.category}/${loc.bookId}/`;
}

// --- Catalog ---

async function waitForCatalogReady(page, phase, loc, timeoutMs) {
  const timeout = timeoutMs || 60000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const hit = await page.evaluate(
        ({ origin, category, bookId }) => {
          const re = new RegExp(`^/${category}/${bookId}/(\\d+)\\.html$`, 'i');
          return [...document.querySelectorAll('dl.chapter-list dd a[href]')].some((a) => {
            try { return re.test(new URL(a.getAttribute('href') || '', origin).pathname); }
            catch { return false; }
          });
        },
        { origin: loc.origin, category: loc.category, bookId: loc.bookId }
      );
      if (hit) return;
    } catch (e) {
      if (isTransientNavError(e)) await page.waitForLoadState('domcontentloaded').catch(() => {});
      else throw e;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(`[73shu] 目录等待超时（title=${(await page.title().catch(() => '')).slice(0, 80)}）`);
}

async function extractChapterLinks(page, loc) {
  return page.evaluate(
    ({ origin, category, bookId }) => {
      const re = new RegExp(`^/${category}/${bookId}/(\\d+)\\.html$`, 'i');
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('dl.chapter-list dd a[href]')) {
        let p;
        try { p = new URL(a.getAttribute('href') || '', origin).pathname; }
        catch { continue; }
        const m = re.exec(p);
        if (!m) continue;
        const abs = new URL(a.getAttribute('href'), origin).href;
        if (seen.has(abs)) continue;
        seen.add(abs);
        out.push({ href: abs, title: (a.textContent || '').replace(/\s+/g, ' ').trim(), chapterId: m[1] });
      }
      return out;
    },
    { origin: loc.origin, category: loc.category, bookId: loc.bookId }
  );
}

async function discoverChapters(page, entryUrl) {
  const { url, rewritten } = applyMirrorRewrite(entryUrl);
  if (rewritten) console.log(`[73shu] 检测到停站域名，改写为镜像: ${url}`);
  const loc = parseEntryUrl(url);
  const listUrl = catalogUrl(loc);

  console.log(`[73shu] 打开: ${listUrl}`);
  await page.goto(listUrl, GOTO_OPTS);
  await waitForCatalogReady(page, `目录 ${listUrl}`, loc);

  const chapters = await extractChapterLinks(page, loc);
  console.log(`[73shu] 目录共 ${chapters.length} 章`);
  return chapters;
}

// --- Chapter body ---

async function extractChapterText(page, chapterUrl) {
  await page.goto(chapterUrl, GOTO_OPTS);
  await page.waitForSelector(CONTENT_SEL, { timeout: 30000 });
  const raw = await page.$eval(CONTENT_SEL, (el) => el.innerText.trim()).catch(() => '');
  if (raw.length < MIN_BODY_CHARS) throw new Error(`正文过短 (${raw.length} 字): ${chapterUrl}`);
  return stripLeadingNoise(stripAdLines(raw, STRIP_OPTS));
}

// --- Main ---

async function main() {
  const { outputDir, urlFile, mergeTitle, restArgv } = extractFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');

  const runMerge = restArgv.includes('--merge');
  const forceChapters = restArgv.includes('--force') || process.env.S73SHU_FORCE === '1';
  const useFileOnly = restArgv.includes('--file');
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  const headed = useHeadedLaunch({ envKey: 'S73SHU_HEADED' });
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();

  const failureLogPath = path.join(outputDir, '73shu_failures.jsonl');

  let chapters;
  const envListUrl = process.env.S73SHU_CHAPTERS_URL?.trim();
  const discoverUrl = useFileOnly ? null : entryUrl || envListUrl || null;

  if (useFileOnly) {
    const { resolveUrlFilePath, readUrlFileSync, chaptersFromUrlFileText } = require(path.join(__dirname, '..', 'lib', 'scraper-common.js'));
    const abs = resolveUrlFilePath(urlFile);
    if (!fs.existsSync(abs)) { console.error(`--file 但未找到: ${abs}`); await browser.close(); process.exit(1); }
    chapters = chaptersFromUrlFileText(readUrlFileSync(abs));
    console.log(`从 ${abs} 读取 ${chapters.length} 个 URL`);
  } else if (discoverUrl) {
    console.log('[73shu] 从书籍目录页发现章节:', discoverUrl);
    chapters = await discoverChapters(page, discoverUrl);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`已写入 ${manifestFile}，共 ${chapters.length} 章`);
  } else {
    console.error('请传入书籍目录 URL，例如: node gaode/73shu/scrape-73shu.js http://www.73shu.cc/124/124192/');
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
      console.error(`[73shu] 章节抓取失败 index=${i + 1}/${total} title=${title} href=${href} error=${errMsg}`);
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
