/**
 * 兼容入口：转调 gaode/book18/scrape-novel.js
 *   node download.js              → 读取 chapters_urls.txt
 *   node download.js <目录URL> [最多N章]
 */
const { spawnSync } = require('child_process');
const path = require('path');

const r = spawnSync(
  process.execPath,
  [path.join(__dirname, 'gaode', 'book18', 'scrape-novel.js'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: __dirname }
);
process.exit(r.status === null ? 1 : r.status);
