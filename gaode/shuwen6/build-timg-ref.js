/**
 * shuwen6 TImg 人工识别辅助工具
 *
 * 从 failed_chapters.json 读出未映射章节，打开页面提取所有唯一 TImg src，
 * 保存为编号 PNG，再生成 HTML 对照页供一次性批量识别。
 *
 *   node gaode/shuwen6/build-timg-ref.js [outDir] [--screenshot] [--unmapped-only]
 *   node gaode/shuwen6/build-timg-ref.js novel-output/shuwen6-AjMk --screenshot
 *   node gaode/shuwen6/build-timg-ref.js novel-output/shuwen6-AjMk --unmapped-only
 *
 * --screenshot     额外用 Playwright 拍一张完整网格图
 * --unmapped-only   只提取 timg-map.json 中尚不存在的图片（增量识别）
 *
 * 产出：outDir/timg-ref/
 *   img/001.png ...     每个唯一 TImg 的 PNG
 *   mapping.json         编号→文件/频次（供后续脚本读）
 *   reference.html       对照页：网格 + 输入框 + 一键导出合并后的 timg-map.json
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TIMG_MAP_FILE = path.join(__dirname, 'timg-map.json');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function base64ToBuffer(dataUrl) {
  const m = String(dataUrl).match(/^data:image\/\w+;base64,(.+)$/);
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}

function loadTimgMap() {
  try {
    const raw = fs.readFileSync(TIMG_MAP_FILE, 'utf8');
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch { /* ignore */ }
  return {};
}

/** 从多个章节中收集 TImg src → { pages: Set } */
async function collectUnique(page, failures) {
  const srcMap = new Map();
  for (const f of failures) {
    console.log(`  打开: ${f.title}  (${f.href})`);
    try {
      await page.goto(f.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('#chapter-content', { timeout: 15000 }).catch(() => {});
    } catch (e) {
      console.warn(`    goto 失败: ${(e.message || String(e)).slice(0, 100)}`);
      continue;
    }

    const srcs = await page.evaluate(() => {
      const imgs = document.querySelectorAll('#chapter-content img.TImg');
      return Array.from(imgs).map((img) => img.getAttribute('src') || '').filter(Boolean);
    });
    for (const src of srcs) {
      const entry = srcMap.get(src);
      if (entry) {
        entry.pages.add(f.title);
      } else {
        srcMap.set(src, { pages: new Set([f.title]) });
      }
    }
  }
  return srcMap;
}

// ---------------------------------------------------------------------------
// HTML 生成
// ---------------------------------------------------------------------------

function generateHTML(refDir, items, existingMap) {
  const existingJSON = JSON.stringify(existingMap);
  const existingKeys = Object.keys(existingMap).length;

  const cells = items
    .map(
      (it) => `\
  <div class="cell">
    <span class="idx">${it.index}</span>
    <img src="${it.file}" width="19" height="19" title="#${it.index} — ${it.count}次/${it.pages.length}页" />
    <input type="text" maxlength="1" class="char-inp" data-idx="${it.index}" size="2" />
  </div>`
    )
    .join('\n');

  const indexSrc = items
    .map((it) => `  ${it.index}: ${JSON.stringify(it.src)}`)
    .join(',\n');

  const html = `\
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>TImg 对照表 — shuwen6</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; margin: 16px; }
  h2 { margin-bottom: 4px; }
  .bar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  #status { color: #090; margin-left: 8px; }
  .tbar { position: sticky; top: 0; background: #fff; padding: 8px 0; border-bottom: 2px solid #999; z-index: 10; }
  .grid { display: flex; flex-wrap: wrap; gap: 2px; }
  .cell { display: flex; flex-direction: column; align-items: center; border: 1px solid #ddd; padding: 2px 4px; width: 52px; }
  .cell .idx { font-size: 9px; color: #888; }
  .cell img { image-rendering: pixelated; }
  .cell input { font-size: 14px; text-align: center; width: 1.6em; border: 1px solid #aaa; }
</style>
</head>
<body>

<div class="tbar">
  <h2>TImg 对照表 (${items.length} 个唯一图片, 已有 ${existingKeys} 条映射)</h2>
  <div class="bar">
    <button onclick="doExport()">导出 timg-map.json</button>
    <button onclick="loadSaved()">恢复已填</button>
    <span id="status"></span>
  </div>
  <p style="color:#666;font-size:13px;">
    每个图片输入对应汉字；<kbd>Tab</kbd> 逐格切换，<kbd>Enter</kbd> 跳到下一格。
    导出时会自动合并已有的 ${existingKeys} 条映射。
  </p>
</div>

<div class="grid">
${cells}
</div>

<script>
var EXISTING = ${existingJSON};
var INDEX_SRC = {
${indexSrc}
};

function doExport() {
  var map = {};
  // 合并已有映射
  for (var k in EXISTING) { map[k] = EXISTING[k]; }
  var filled = 0;
  var empty = 0;
  document.querySelectorAll('.char-inp').forEach(function(inp) {
    var ch = inp.value.trim();
    var src = INDEX_SRC[Number(inp.dataset.idx)];
    if (!src) return;
    if (ch && ch.length === 1) { map[src] = ch; filled++; }
    else { empty++; }
  });

  var blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'timg-map.json';
  a.click();
  URL.revokeObjectURL(a.href);

  document.getElementById('status').textContent =
    '已导出 ' + filled + ' 条新增 (共 ' + Object.keys(map).length + ' 条)';
}

function saveToStorage() {
  var data = {};
  document.querySelectorAll('.char-inp').forEach(function(inp) {
    data[inp.dataset.idx] = inp.value;
  });
  localStorage.setItem('timg-ref-inputs', JSON.stringify(data));
}

function loadSaved() {
  try {
    var data = JSON.parse(localStorage.getItem('timg-ref-inputs') || '{}');
    document.querySelectorAll('.char-inp').forEach(function(inp) {
      if (data[inp.dataset.idx]) inp.value = data[inp.dataset.idx];
    });
    document.getElementById('status').textContent = '已恢复上次填写';
  } catch (e) {
    document.getElementById('status').textContent = '恢复失败';
  }
}

document.addEventListener('input', function(e) {
  if (!e.target.classList.contains('char-inp')) return;
  saveToStorage();
});
document.addEventListener('keydown', function(e) {
  if (!e.target.classList.contains('char-inp')) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    var idx = Number(e.target.dataset.idx);
    var next = document.querySelector('.char-inp[data-idx="' + (idx + 1) + '"]');
    if (next) next.focus();
  }
});

window.addEventListener('load', loadSaved);
</script>
</body>
</html>`;

  const htmlPath = path.join(refDir, 'reference.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('  HTML 对照页:', htmlPath);
}

// ---------------------------------------------------------------------------
// 生成合并大图 (Playwright 截图)
// ---------------------------------------------------------------------------

async function screenshotGrid(refDir) {
  const htmlPath = 'file:///' + path.join(refDir, 'reference.html').replace(/\\/g, '/');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto(htmlPath, { waitUntil: 'networkidle', timeout: 30000 });
  const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewportSize({ width: 1800, height: Math.min(bodyHeight + 20, 16000) });
  const shotPath = path.join(refDir, 'grid.png');
  await page.screenshot({ path: shotPath, fullPage: true });
  await browser.close();
  console.log('  合并大图:', shotPath);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const outDir = args.find((a) => !a.startsWith('--')) || 'novel-output/shuwen6-AjMk';
  const doScreenshot = args.includes('--screenshot');
  const unmappedOnly = args.includes('--unmapped-only');

  const failedLogPath = path.join(outDir, 'failed_chapters.json');
  if (!fs.existsSync(failedLogPath)) {
    console.error('未找到', failedLogPath);
    process.exit(1);
  }

  const existingMap = loadTimgMap();
  if (Object.keys(existingMap).length > 0) {
    console.log('已有映射:', Object.keys(existingMap).length, '条');
  }

  const failed = JSON.parse(fs.readFileSync(failedLogPath, 'utf8'));
  const timgFailures = (failed.failures || []).filter((f) => f.kind === 'timg_unmapped');

  // --unmapped-only 时，若没有失败记录也正常继续（之前可能已全部修复）
  if (timgFailures.length === 0 && !unmappedOnly) {
    console.log('没有 timg_unmapped 章节');
    return;
  }
  if (timgFailures.length === 0 && unmappedOnly) {
    console.log('没有 timg_unmapped 章节，无需提取');
    return;
  }

  console.log('共 ' + timgFailures.length + ' 个章节有未映射 TImg');

  // 输出目录
  const refDir = path.join(outDir, 'timg-ref');
  const imgDir = path.join(refDir, 'img');
  fs.mkdirSync(imgDir, { recursive: true });

  // 1. 收集唯一 TImg
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let srcMap;
  try {
    srcMap = await collectUnique(page, timgFailures);
  } finally {
    await browser.close();
  }

  console.log('章节中出现的唯一 TImg: ' + srcMap.size + ' 个');

  // 2. 过滤 & 保存 PNG
  const items = [];
  let idx = 0;
  let skipped = 0;

  for (const [src, info] of srcMap) {
    // --unmapped-only 时跳过已有映射
    if (unmappedOnly && existingMap[src] !== undefined) {
      skipped++;
      continue;
    }

    idx++;
    const buf = base64ToBuffer(src);
    if (!buf) {
      console.warn('  跳过非 base64: ' + src.slice(0, 60) + '...');
      continue;
    }
    const fileName = String(idx).padStart(3, '0') + '.png';
    fs.writeFileSync(path.join(imgDir, fileName), buf);
    items.push({
      index: idx,
      file: 'img/' + fileName,
      src,
      count: info.pages.size,
      pages: [...info.pages],
    });
    if (idx % 200 === 0) console.log('  ' + idx + '/' + srcMap.size);
  }

  if (unmappedOnly && skipped > 0) {
    console.log('跳过已映射: ' + skipped + ' 个');
  }
  console.log('待识别: ' + items.length + ' 个');

  // 3. mapping.json
  fs.writeFileSync(path.join(refDir, 'mapping.json'), JSON.stringify(items, null, 2));

  // 4. HTML 对照页（嵌入已有映射）
  generateHTML(refDir, items, existingMap);

  // 5. 可选合并大图
  if (doScreenshot) {
    console.log('正在生成合并大图 ...');
    await screenshotGrid(refDir);
  }

  // 6. 提示
  const htmlPath = path.join(refDir, 'reference.html');
  if (items.length === 0) {
    console.log('\n所有 TImg 已映射完毕，无需继续。');
  } else {
    console.log('\n完成。打开 ' + htmlPath);
    console.log('填完字后点"导出 timg-map.json"，下载文件放到 gaode/shuwen6/ 下，然后：');
    console.log('  node gaode/shuwen6/scrape-shuwen6.js --out-dir=' + outDir + ' --retry-failed --merge');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
