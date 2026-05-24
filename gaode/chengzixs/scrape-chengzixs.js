/**
 * chengzixs.com（橙子小说网）抓取。
 *
 * 目录页：/passage/{bookId}/ 收集全部 /chapter/{bookId}/ 链接
 * 正文：#chapter-content；首页广告行用 stripAdLines 过滤
 * 敏感字：部分小说用 <img src="/asset/fonts/{n}.png"> 替换单个汉字。
 * 同目录 font-map.json 中建立「数字 n → 单字」映射（如 {"14":"你","32":"我"}）。
 * 未映射时用 □ 占位并在控制台提示。
 *
 *   node gaode/chengzixs/scrape-chengzixs.js <目录页URL> [最多N章]
 *   node gaode/chengzixs/scrape-chengzixs.js https://www.chengzixs.com/passage/124877/ --out-dir=novel-output/chengzixs --merge
 *
 * 与 book18 脚本相同约定：--out-dir、--merge、--merge-title=、chapters/、merged/{小说名}.txt
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const FONT_MAP_FILE = path.join(__dirname, 'font-map.json');

const CONTENT_SEL = '#chapter-content';
const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 60000 };

/** 字体图片 URL 模式：/asset/fonts/{数字}.png */
const FONT_IMG_RE = /\/asset\/fonts\/(\d+)\.png/i;

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function loadFontMap() {
  try {
    const raw = fs.readFileSync(FONT_MAP_FILE, 'utf8');
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch {
    // 缺文件或解析失败则视为无映射
  }
  return {};
}

/** 过滤广告行：正文开头的收藏提示、听书广告等 */
function stripAdLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (/如果出现文字缺失|格式混乱|取消转码|退出阅读模式/.test(s)) return false;
      if (/沉浸式.*有声.*体验/.test(s)) return false;
      if (/泡泡听书/.test(s)) return false;
      if (/【收藏橙子小说网/.test(s)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/** 解析 Unicode RTL 覆盖（U+202E…U+202C），将夹在中间的文本反转回正常顺序 */
function fixUnicodeBidi(text) {
  const RLO = '‮';
  const PDF = '‬';
  let result = '';
  let i = 0;
  while (i < text.length) {
    const rloIdx = text.indexOf(RLO, i);
    if (rloIdx === -1) { result += text.slice(i); break; }
    result += text.slice(i, rloIdx);
    const start = rloIdx + 1;
    const pdfIdx = text.indexOf(PDF, start);
    const end = pdfIdx === -1 ? text.length : pdfIdx;
    // 反转被 RLO 覆盖的文本
    const reversed = text.slice(start, end).split('').reverse().join('');
    result += reversed;
    i = pdfIdx === -1 ? text.length : pdfIdx + 1;
  }
  return result;
}

/** 从 /passage/{bookId}/ 发现全部章节链接 */
async function discoverChapters(page, entryUrl) {
  await page.goto(entryUrl, GOTO_OPTS);
  await page.waitForSelector('a[href*="/chapter/"]', { timeout: 20000 });
  return page.evaluate((baseUrl) => {
    const bookId = baseUrl.match(/\/passage\/(\d+)/)?.[1];
    if (!bookId) return [];
    const links = [...document.querySelectorAll('a')];
    const re = new RegExp('/chapter/' + bookId + '/\\d+\\.html');
    const seen = new Set();
    const out = [];
    for (const a of links) {
      if (!re.test(a.pathname)) continue;
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const title = (a.textContent || '').trim();
      out.push({ href: a.href, title: title || path.basename(a.pathname) });
    }
    return out;
  }, entryUrl);
}

/**
 * 提取#chapter-content 中的纯文本：
 * - 文本节点原样输出
 * - img[src*="/asset/fonts/"] 用 fontMap[num] 或 □ 占位
 * - br → 换行
 * 返回 { text, unknownFonts } 其中 unknownFonts 为未映射的字体数字 Set。
 */
async function extractContentWithFontMap(page, fontMap) {
  const sel = CONTENT_SEL;
  return page.evaluate(([sel, map]) => {
    const root = document.querySelector(sel);
    if (!root) return { text: '', unknownFonts: [] };
    const FONT_RE = /\/asset\/fonts\/(\d+)\.png/i;
    const PLACEHOLDER = '□';
    const unknownSet = new Set();

    function walk(node) {
      let s = '';
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          s += child.textContent || '';
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child;
        const tag = el.tagName;
        if (tag === 'BR') {
          s += '\n';
          continue;
        }
        if (tag === 'IMG') {
          const src = el.getAttribute('src') || '';
          const m = src.match(FONT_RE);
          if (m) {
            const num = m[1];
            if (map[num] !== undefined) {
              s += map[num];
            } else {
              unknownSet.add(num);
              s += PLACEHOLDER;
            }
          }
          continue;
        }
        s += walk(el);
      }
      return s;
    }

    return { text: walk(root).trim(), unknownFonts: [...unknownSet] };
  }, [sel, fontMap]);
}

/** 等待正文容器就绪并提取文本（含字体图映射） */
async function extractChapterText(page, chapterUrl, fontMap) {
  await page.goto(chapterUrl, GOTO_OPTS);
  await page.waitForSelector(CONTENT_SEL, { timeout: 25000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('#chapter-content');
      return el && (el.innerText || '').trim().length > 200;
    },
    { timeout: 30000 }
  ).catch(() => {});

  const { text, unknownFonts } = await extractContentWithFontMap(page, fontMap);
  const cleaned = fixUnicodeBidi(stripAdLines(text));
  return { text: cleaned, unknownFonts };
}

function extractScrapeFlags(argv) {
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
  const { outputDir, mergeTitle, restArgv } = extractScrapeFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');

  const runMerge = restArgv.includes('--merge');
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  if (!entryUrl) {
    console.error('请传入橙子小说网目录页 URL，例如: https://www.chengzixs.com/passage/124877/');
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  const fontMap = loadFontMap();
  const fontKeys = Object.keys(fontMap).length;
  if (fontKeys > 0) console.log('已加载字体映射', fontKeys, '条:', FONT_MAP_FILE);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('从目录页发现章节:', entryUrl);
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

  /** 收集全书出现的未知字体数字 */
  const allUnknownFonts = new Set();

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
      const { text, unknownFonts } = await extractChapterText(page, href, fontMap);
      for (const n of unknownFonts) allUnknownFonts.add(n);
      if (unknownFonts.length > 0) {
        process.stdout.write(`(${unknownFonts.length} 个未映射字体) `);
      }
      fs.writeFileSync(outPath, `${title}\n\n${text}`, 'utf8');
      console.log(`ok (${text.length} 字)`);
    } catch (e) {
      console.log(`失败: ${e.message}`);
    }
  }

  await browser.close();
  console.log('完成，输出目录:', path.resolve(outputDir));

  if (allUnknownFonts.size > 0) {
    console.log(`\n全书共 ${allUnknownFonts.size} 个唯一字体未映射:`, [...allUnknownFonts].sort((a, b) => a - b).join(', '));
    console.log(`请在 ${FONT_MAP_FILE} 中补充映射后重新运行`);
  }

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
