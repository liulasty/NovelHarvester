/**
 * 合并导出的 timg-map.json 到 gaode/shuwen6/timg-map.json
 *
 * 用法：
 *   node gaode/shuwen6/merge-timg.js <下载的timg-map.json路径>
 *   node gaode/shuwen6/merge-timg.js C:/Users/xxx/Downloads/timg-map.json
 *
 * 会自动去重合并，覆盖同名 key，保留原有未冲突的条目。
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, 'timg-map.json');

const srcPath = process.argv[2];
if (!srcPath) {
  console.error('用法: node gaode/shuwen6/merge-timg.js <下载的timg-map.json>');
  process.exit(1);
}

if (!fs.existsSync(srcPath)) {
  console.error('文件不存在:', srcPath);
  process.exit(1);
}

const incoming = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
const existing = (() => {
  try { return JSON.parse(fs.readFileSync(TARGET, 'utf8')); }
  catch { return {}; }
})();

const before = Object.keys(existing).length;
const added = [];
const overwritten = [];

for (const [k, v] of Object.entries(incoming)) {
  if (existing[k] === undefined) {
    added.push(v);
  } else if (existing[k] !== v) {
    overwritten.push(`${existing[k]}→${v}`);
  }
  existing[k] = v;
}

const after = Object.keys(existing).length;

fs.writeFileSync(TARGET, JSON.stringify(existing, null, 2));

console.log(`合并完成: ${TARGET}`);
console.log(`  原有: ${before} 条`);
console.log(`  新增: ${added.length} 条`, added.length > 0 ? added.join(' ') : '');
if (overwritten.length > 0) {
  console.log(`  覆盖: ${overwritten.length} 条`, overwritten.join(', '));
}
console.log(`  结果: ${after} 条`);
