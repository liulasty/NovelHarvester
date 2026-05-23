/**
 * 书文小说网 m.shuwen6.cc 抓取（移动站目录页 + 正文分页）
 *
 * 目录：从 #list ul.chapter-list 收集章节链接；目录分页多为 ml_1.html … ml_N.html（#category-page 显示「共 N 页」），
 * 或旧版 a「下页」链到 ml_2.html …；部分书籍入口仍为 ml.html（等同第 1 页）
 * 正文：#chapter-content；一章多屏时页面底部有「下页」链接（同章节 ?page=2），需依次打开拼接
 *
 *   node gaode/shuwen6/scrape-shuwen6.js <目录页URL> [最多N章]
 *   node gaode/shuwen6/scrape-shuwen6.js https://m.shuwen6.cc/xs/AjMk/ml.html --out-dir=novel-output/shuwen6-AjMk --merge
 *
 * 失败与劣化写入 out-dir/failed_chapters.json（v2：kind 区分 extraction_error / timg_unmapped；可用 --failed-log= 改路径）。
 * 仅重跑记录中的章节（不重新扫目录）；会强制覆盖已存在分章（便于补 timg-map 后重拉）：
 *   node gaode/shuwen6/scrape-shuwen6.js --out-dir=novel-output/shuwen6-AjMk --retry-failed [--merge]
 *
 * 与 book18 脚本相同约定：--out-dir、--merge、--merge-title=、chapters/、merged/{小说名}.txt
 *
 * 正文敏感字常以 <img class="TImg" src="data:image/png;base64,..."> 插入，innerText 无法得到汉字。
 * 请在同目录 timg-map.json 中建立「完整 src 字符串 → 单字」映射（同一图片对应同一字，可复制页面里 img 的 src 作键）。
 * 未映射时正文用 □ 占位，并在控制台提示本章未映射数量。
 *
 * 优先：从页面 HTML 中解析 initTxt(".../xx.wen")，请求 i.shuwen6.cc 的 .wen 脚本，
 * 执行 _txt_call({ content, replace }) 与站点相同的 replace 规则，得到解码正文（可避开多数 TImg）。
 * 失败或过短时回退为 #chapter-content DOM 抽取。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');

/** 认为 .wen 解码成功的最小字符数（过短则仍走 DOM） */
const MIN_WEN_PLAIN_LEN = 50;

/** failed_chapters.json 中 failures[].kind */
const FAILURE_KIND = {
  EXTRACTION: 'extraction_error',
  TIMG: 'timg_unmapped',
};

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const TIMG_MAP_FILE = path.join(__dirname, 'timg-map.json');

/** 正文页广告/长连较多时 networkidle 易永不触发 → 用 domcontentloaded，再由 #chapter-content 显式等待 */
const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 90000 };
const GOTO_FALLBACK_OPTS = { waitUntil: 'load', timeout: 90000 };
const LIST_SEL = '#list ul.chapter-list';
const CONTENT_SEL = '#chapter-content';
/** 正文区可见等待（过短易偶发超时，与 waitForFunction 量级一致） */
const CHAPTER_CONTENT_WAIT_MS = 60000;

/** 去掉 Playwright 消息里的 ANSI，便于 failed_chapters.json 可读、稳定 diff */
function stripAnsi(s) {
  return String(s || '').replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * 书文站 goto：优先 domcontentloaded；失败或 ERR_ABORTED 时重试 load / 二次 goto。
 */
async function gotoChapterPage(page, url, label = 'chapter') {
  const attempts = [
    () => page.goto(url, GOTO_OPTS),
    () => page.goto(url, GOTO_FALLBACK_OPTS),
    () => page.goto(url, GOTO_OPTS),
  ];
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      await attempts[i]();
      return;
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : String(e);
      const abort = /ERR_ABORTED|detached/i.test(msg);
      const timeout = /Timeout/i.test(msg);
      if (i < attempts.length - 1 && (abort || timeout)) {
        console.warn(`  goto ${label} 重试 (${i + 2}/${attempts.length}): ${stripAnsi(msg).slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function normalizeCatalogUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    x.search = '';
    if (x.pathname.endsWith('/') && x.pathname.length > 1) x.pathname = x.pathname.slice(0, -1);
    return x.href;
  } catch {
    return u;
  }
}

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** seq 为目录顺序 1-based，与 chapters/001_*.txt 序号一致 */
function chapterFileName(seq, title) {
  const namePart = sanitizeFilePart(title) || String(seq);
  return `${String(seq).padStart(3, '0')}_${namePart}.txt`;
}

function loadTimgMap() {
  try {
    const raw = fs.readFileSync(TIMG_MAP_FILE, 'utf8');
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch {
    // 缺文件或解析失败则视为无映射
  }
  return {};
}

function extractScrapeFlags(argv) {
  let outputDir = process.env.NOVEL_OUTPUT_DIR?.trim() || 'novel-output';
  let mergeTitle = '';
  let failedLog = 'failed_chapters.json';
  let retryFailed = false;
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--out-dir=')) outputDir = a.slice(10).trim();
    else if (a.startsWith('--merge-title=')) mergeTitle = a.slice(14).trim();
    else if (a.startsWith('--failed-log=')) failedLog = a.slice(13).trim();
    else if (a === '--retry-failed') retryFailed = true;
    else rest.push(a);
  }
  return { outputDir, mergeTitle, failedLog, retryFailed, restArgv: rest };
}

function resolveFailedLogPath(outputDir, failedLog) {
  if (path.isAbsolute(failedLog)) return failedLog;
  return path.join(outputDir, failedLog);
}

function writeFailedChaptersLog(failedLogPath, { catalogUrl, outputDir, failures }) {
  // v2：failures[].kind 为 extraction_error | timg_unmapped；v1 无 kind 视为整章抓取失败
  const payload = {
    version: 2,
    catalogUrl: catalogUrl || '',
    outputDir: path.resolve(outputDir),
    failedLog: path.basename(failedLogPath),
    updatedAt: new Date().toISOString(),
    failures,
  };
  fs.writeFileSync(failedLogPath, JSON.stringify(payload, null, 2), 'utf8');
  const errN = failures.filter((f) => (f.kind || FAILURE_KIND.EXTRACTION) === FAILURE_KIND.EXTRACTION).length;
  const timgN = failures.filter((f) => f.kind === FAILURE_KIND.TIMG).length;
  console.log('已写入失败记录', failedLogPath, `共 ${failures.length} 条（抓取异常 ${errN}，TImg 未映射 ${timgN}）`);
}

/** 从已有 failed_chapters.json 恢复按 seq 索引的状态（跳过时不应抹掉既有 timg 记录） */
function readFailureState(failedLogPath) {
  const map = new Map();
  if (!fs.existsSync(failedLogPath)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(failedLogPath, 'utf8'));
    const arr = Array.isArray(raw.failures) ? raw.failures : [];
    for (const f of arr) {
      const seq = typeof f.seq === 'number' ? f.seq : parseInt(f.seq, 10);
      if (Number.isFinite(seq) && seq > 0) {
        map.set(seq, { ...f, seq, kind: f.kind || FAILURE_KIND.EXTRACTION });
      }
    }
  } catch {
    // 忽略损坏的旧文件
  }
  return map;
}

/**
 * 从目录页 DOM 解析总页数：`(第 1 页/共 3 页)` 或 `#jump option` 数量
 */
async function readCatalogTotalPages(page) {
  return page.evaluate(() => {
    const b = document.querySelector('#category-page b, .CGsectionTwo-right-bottom-page b, pages.gray b');
    const t = (b && b.textContent) || '';
    const m = t.match(/共\s*(\d+)\s*页/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const jump = document.querySelector('select#jump');
    if (jump) {
      const n = jump.querySelectorAll('option').length;
      if (n > 0) return n;
    }
    return 0;
  });
}

/**
 * 收集全部目录页 URL。优先：解析「共 N 页」→ ml_1 … ml_N；否则沿 a「下页」（href 为 ml*.html）遍历。
 */
async function collectCatalogPageUrls(page, startUrl) {
  const first = normalizeCatalogUrl(startUrl);
  await gotoChapterPage(page, first, 'catalog');
  await page.waitForFunction(
    () => document.querySelectorAll('#list ul.chapter-list li a').length > 0,
    { timeout: 30000 }
  );

  let totalPages = await readCatalogTotalPages(page);
  try {
    const u = new URL(first);
    const dirMatch = u.pathname.match(/^(.+\/)ml(?:_\d+)?\.html$/i);
    if (totalPages > 1 && dirMatch) {
      const bookDir = dirMatch[1];
      const out = [];
      for (let i = 1; i <= totalPages; i++) {
        out.push(normalizeCatalogUrl(`${u.origin}${bookDir}ml_${i}.html`));
      }
      return out;
    }
  } catch {
    // 走下方下页回退
  }

  if (totalPages === 1) {
    return [first];
  }

  const urls = [];
  let current = first;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    urls.push(current);
    await gotoChapterPage(page, current, 'catalog');
    await page.waitForFunction(
      () => document.querySelectorAll('#list ul.chapter-list li a').length > 0,
      { timeout: 30000 }
    );
    const nextRaw = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a')].filter((x) => (x.textContent || '').trim() === '下页');
      const catalog = links.find((a) => {
        try {
          return /\/ml(?:_\d+)?\.html$/i.test(new URL(a.href).pathname);
        } catch {
          return false;
        }
      });
      return catalog ? catalog.href : null;
    });
    const next = nextRaw ? normalizeCatalogUrl(nextRaw) : null;
    current = next && !seen.has(next) ? next : null;
  }
  return urls.length ? urls : [first];
}

/** 从所有目录页合并章节列表，按 URL 中的章节序号去重、排序（每页约 90 条，末页约 25 条，合计需遍历全部目录分页） */
async function discoverChapters(page, catalogUrls) {
  const byNum = new Map();
  for (let pi = 0; pi < catalogUrls.length; pi++) {
    const catalogUrl = catalogUrls[pi];
    await gotoChapterPage(page, catalogUrl, 'catalog');
    await page.waitForFunction(
      () => document.querySelectorAll('#list ul.chapter-list li a').length > 0,
      { timeout: 30000 }
    );
    const items = await page.evaluate((listSel) => {
      const out = [];
      const root = document.querySelector(listSel);
      if (!root) return out;
      for (const a of root.querySelectorAll('li a')) {
        const href = a.href;
        const title = (a.textContent || '').trim();
        if (href && title) out.push({ href, title });
      }
      return out;
    }, LIST_SEL);
    console.log(`  目录页 [${pi + 1}/${catalogUrls.length}] ${catalogUrl} → ${items.length} 条章节链接`);
    for (const it of items) {
      let pathname;
      try {
        pathname = new URL(it.href).pathname;
      } catch {
        continue;
      }
      const m = pathname.match(/\/(\d+)\.html$/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (!byNum.has(n)) byNum.set(n, { href: it.href, title: it.title });
    }
  }
  return [...byNum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

/**
 * 遍历 #chapter-content：文本节点原样输出；img.TImg 用 timgMap[src] 或 alt；br 换行。
 */
async function extractContentPlain(page, timgMap) {
  return page.evaluate(
    ([sel, map]) => {
      const root = document.querySelector(sel);
      if (!root) return '';
      const PLACEHOLDER = '□';
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
          if (tag === 'IMG' && el.classList && el.classList.contains('TImg')) {
            const alt = (el.getAttribute('alt') || '').trim();
            if (alt) {
              s += alt;
              continue;
            }
            const src = el.getAttribute('src') || '';
            const ch = map[src];
            s += ch !== undefined ? ch : PLACEHOLDER;
            continue;
          }
          s += walk(el);
        }
        return s;
      }
      return walk(root).trim();
    },
    [CONTENT_SEL, timgMap]
  );
}

/** 从当前文档中提取 initTxt 第一个参数（.wen 地址），并规范为绝对 URL */
async function extractWenUrlFromPage(page, pageUrl) {
  return page.evaluate((baseHref) => {
    const html = document.documentElement.innerHTML;
    const m = html.match(/initTxt\s*\(\s*["']([^"']+)["']/);
    if (!m) return null;
    let u = m[1].trim();
    if (u.startsWith('//')) return 'https:' + u;
    try {
      return new URL(u, baseHref).href;
    } catch {
      return null;
    }
  }, pageUrl);
}

/** 解析 .wen 响应体，执行 _txt_call({ content, replace }) */
function parseWenBody(body) {
  const trimmed = String(body || '').replace(/^\uFEFF/, '');
  let payload = null;
  const sandbox = {
    _txt_call(obj) {
      payload = obj;
    },
  };
  try {
    vm.runInNewContext(trimmed, sandbox, { timeout: 15000 });
  } catch (e) {
    throw new Error(`wen vm: ${e.message}`);
  }
  if (!payload || typeof payload.content !== 'string') return null;
  return payload;
}

/** 与 _chapter.js 一致：replace[d] 为正则源码，替换为键 d */
function applyTxtReplace(content, replace) {
  if (!replace || typeof replace !== 'object') return content;
  let s = content;
  for (const d of Object.keys(replace)) {
    const pat = replace[d];
    if (pat == null || pat === '') continue;
    try {
      s = s.replace(new RegExp(pat, 'gi'), d);
    } catch {
      // 非法正则时跳过该条
    }
  }
  return s;
}

/** 将解码后的 HTML/片段转为纯文本（章节多为 <p class="chapter-line">） */
function wenContentToPlainText(raw) {
  let s = String(raw);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
    const cp = parseInt(h, 16);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
  });
  s = s.replace(/&#(\d+);/g, (full, d) => {
    const cp = parseInt(d, 10);
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
  });
  s = s.replace(/&nbsp;/gi, ' ');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  s = s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n');
  return s
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** 用 Playwright 带 Cookie 的请求拉取 .wen（需与阅读页同源策略一致） */
async function fetchWenText(page, wenUrl, referer) {
  const res = await page.context().request.get(wenUrl, {
    headers: {
      Referer: referer,
      Accept: '*/*',
    },
    timeout: 60000,
  });
  if (!res.ok()) return { ok: false, status: res.status(), text: '' };
  const text = await res.text();
  return { ok: true, status: res.status(), text };
}

/**
 * 抓取一章正文（含站内分页「下页」）。
 * 优先 .wen → _txt_call；失败则用 DOM + timgMap。
 */
async function extractChapterText(page, chapterUrl, timgMap) {
  const base = chapterUrl.split(/[?#]/)[0];
  const chunks = [];
  let url = base;
  const seen = new Set();
  let usedWenFull = false;
  let unknownTimgTotal = 0;

  while (url && !seen.has(url)) {
    seen.add(url);
    await gotoChapterPage(page, url);
    let contentWaitErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        console.warn(`  #chapter-content 等待超时，${CHAPTER_CONTENT_WAIT_MS}ms 内未可见，重试导航 (${attempt + 1}/2) …`);
        await new Promise((r) => setTimeout(r, 2500));
        await gotoChapterPage(page, url);
      }
      try {
        await page.waitForSelector(CONTENT_SEL, { timeout: CHAPTER_CONTENT_WAIT_MS });
        contentWaitErr = null;
        break;
      } catch (e) {
        contentWaitErr = e;
      }
    }
    if (contentWaitErr) throw contentWaitErr;
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('#chapter-content');
          const t = el ? el.innerText : '';
          return t && !t.includes('章节内容加载中');
        },
        { timeout: 45000 }
      )
      .catch(() => {});

    if (!usedWenFull) {
      try {
        const wenUrl = await extractWenUrlFromPage(page, url);
        if (wenUrl && /\.wen(\?|$)/i.test(wenUrl)) {
          const fr = await fetchWenText(page, wenUrl, url);
          if (fr.ok && fr.text) {
            const payload = parseWenBody(fr.text);
            if (payload) {
              let plain = applyTxtReplace(payload.content, payload.replace);
              plain = wenContentToPlainText(plain);
              if (plain.length >= MIN_WEN_PLAIN_LEN) {
                chunks.push(plain);
                usedWenFull = true;
                break;
              }
            }
          }
        }
      } catch (e) {
        console.warn(`  wen 解码跳过: ${e.message}`);
      }
    }

    if (usedWenFull) break;

    const text = await extractContentPlain(page, timgMap);
    const unknownTimg = await page.evaluate((map) => {
      const root = document.querySelector('#chapter-content');
      if (!root) return 0;
      let n = 0;
      for (const img of root.querySelectorAll('img.TImg')) {
        const src = img.getAttribute('src') || '';
        const alt = (img.getAttribute('alt') || '').trim();
        if (alt) continue;
        if (map[src] === undefined) n += 1;
      }
      return n;
    }, timgMap);
    if (unknownTimg > 0) {
      unknownTimgTotal += unknownTimg;
      console.warn(`  … ${unknownTimg} 个 TImg 未在 timg-map.json 中映射（正文用 □ 占位）`);
    }
    chunks.push(text);

    const chapterPath = new URL(base).pathname;
    const nextPageUrl = await page.evaluate((pathOnly) => {
      const links = [...document.querySelectorAll('a')].filter((x) => (x.textContent || '').trim() === '下页');
      const same = links.find((a) => {
        try {
          return new URL(a.href).pathname === pathOnly;
        } catch {
          return false;
        }
      });
      return same ? same.href : null;
    }, chapterPath);
    if (!nextPageUrl) break;
    url = nextPageUrl;
  }
  return { text: chunks.join('\n\n'), unknownTimg: unknownTimgTotal };
}

async function main() {
  const { outputDir, mergeTitle, failedLog, retryFailed, restArgv } = extractScrapeFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');
  const failedLogPath = resolveFailedLogPath(outputDir, failedLog);

  const runMerge = restArgv.includes('--merge');
  const posArgs = restArgv.filter((a) => !a.startsWith('--')).map((a) => a.trim());

  let entryUrl =
    posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : process.env.SHUWEN6_ML_URL?.trim() || null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (posArgs.length > 1 ? posArgs[1] : null);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  let chapters;
  let catalogUrlForLog = entryUrl || '';

  if (retryFailed) {
    if (!fs.existsSync(failedLogPath)) {
      console.error('找不到失败记录:', failedLogPath);
      process.exit(1);
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(failedLogPath, 'utf8'));
    } catch (e) {
      console.error('解析失败记录失败:', e.message);
      process.exit(1);
    }
    const failuresIn = Array.isArray(raw.failures) ? raw.failures : [];
    if (failuresIn.length === 0) {
      console.log('失败记录中无条目，退出。');
      process.exit(0);
    }
    if (!entryUrl && raw.catalogUrl) entryUrl = raw.catalogUrl;
    catalogUrlForLog = raw.catalogUrl || entryUrl || '';
    chapters = failuresIn.map((f) => ({
      href: f.href,
      title: f.title,
      seq: typeof f.seq === 'number' ? f.seq : parseInt(f.seq, 10) || 0,
      fileName: typeof f.fileName === 'string' && f.fileName ? f.fileName : null,
    }));
    const bad = chapters.filter((c) => !c.href || !c.title || !c.seq);
    if (bad.length) {
      console.error('失败记录中有无效项（需 href、title、seq）:', bad.length, '条');
      process.exit(1);
    }
    console.log('重试模式：自', failedLogPath, '读取', chapters.length, '个失败章节（不重新扫目录）');
  } else {
    if (!entryUrl) {
      console.error('请传入书文目录页 URL，例如: https://m.shuwen6.cc/xs/AjMk/ml.html');
      process.exit(1);
    }
    catalogUrlForLog = entryUrl;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  const timgMap = loadTimgMap();
  const timgKeys = Object.keys(timgMap).length;
  if (timgKeys > 0) console.log('已加载 TImg 映射', timgKeys, '条:', TIMG_MAP_FILE);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'zh-CN,zh;q=0.9',
  });

  /** 合并持久化：全量跑时「已存在跳过」的章保留既有 timg_unmapped 等记录 */
  const failureState = readFailureState(failedLogPath);

  if (!retryFailed) {
    console.log('收集目录分页:', entryUrl);
    const catalogPages = await collectCatalogPageUrls(page, entryUrl);
    console.log('  共', catalogPages.length, '页目录');

    chapters = await discoverChapters(page, catalogPages);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log('已写入', manifestFile, '共', chapters.length, '章');

    if (Number.isFinite(maxChapters) && maxChapters > 0) {
      chapters = chapters.slice(0, maxChapters);
      console.log('限制为前', maxChapters, '章');
    }

    for (let i = 0; i < chapters.length; i++) {
      chapters[i].seq = i + 1;
      chapters[i].fileName = chapterFileName(i + 1, chapters[i].title);
    }
  }

  const total = chapters.length;
  for (let i = 0; i < total; i++) {
    const ch = chapters[i];
    const { href, title } = ch;
    const seq = ch.seq || i + 1;
    const fileName = ch.fileName || chapterFileName(seq, title);
    const outPath = path.join(chaptersDir, fileName);

    const skipIfExists = !retryFailed;
    if (skipIfExists && fs.existsSync(outPath) && fs.statSync(outPath).size > 100) {
      console.log(`[${seq}/${total}] 跳过（已存在） ${fileName}`);
      continue;
    }

    process.stdout.write(`[${seq}/${total}] ${href} … `);
    try {
      const { text, unknownTimg } = await extractChapterText(page, href, timgMap);
      fs.writeFileSync(outPath, `${title}\n\n${text}`, 'utf8');
      console.log(`ok (${text.length} 字)`);
      if (unknownTimg > 0) {
        failureState.set(seq, {
          seq,
          href,
          title,
          fileName,
          kind: FAILURE_KIND.TIMG,
          unknownTimg,
          error: `${unknownTimg} 个 TImg 未在 timg-map.json 中映射（正文用 □ 占位）`,
          at: new Date().toISOString(),
        });
      } else {
        failureState.delete(seq);
      }
    } catch (e) {
      const errMsg = stripAnsi(e && e.message ? e.message : String(e));
      console.log(`失败: ${errMsg}`);
      failureState.set(seq, {
        seq,
        href,
        title,
        fileName,
        kind: FAILURE_KIND.EXTRACTION,
        error: errMsg,
        at: new Date().toISOString(),
      });
    }
  }

  await browser.close();
  console.log('完成，输出目录:', path.resolve(outputDir));

  const failures = [...failureState.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row);
  writeFailedChaptersLog(failedLogPath, {
    catalogUrl: catalogUrlForLog,
    outputDir,
    failures,
  });

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
