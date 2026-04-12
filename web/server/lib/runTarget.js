const path = require('path');

/** Mirrors novel-workflow.js SCRAPER_TO_SCRIPT (paths relative to project root). */
const SCRAPER_TO_SCRIPT = {
  book18: path.join('gaode', 'book18', 'scrape-novel.js'),
  shuwen6: path.join('gaode', 'shuwen6', 'scrape-shuwen6.js'),
  diyibanzhu: path.join('gaode', 'diyibanzhu', 'scrape-diyibanzhu.js'),
  nzxs: path.join('gaode', 'nzxs', 'scrape-nzxs.js'),
  bookszw: path.join('gaode', 'bookszw', 'scrape-bookszw.js'),
  '69xku': path.join('gaode', '69xku', 'scrape-69xku.js'),
  '9ksw': path.join('gaode', '9ksw', 'scrape-9ksw.js'),
};

const SCRAPER_KEYS = Object.keys(SCRAPER_TO_SCRIPT);

/**
 * @param {string} projectRoot
 * @param {object} target
 * @param {string|number|undefined|null} limit
 * @returns {{ scriptAbs: string, argv: string[] }}
 */
function buildSpawnArgs(projectRoot, target, limit) {
  const engine = (target.scraper && String(target.scraper).trim()) || 'book18';
  const rel = SCRAPER_TO_SCRIPT[engine];
  if (!rel) {
    const err = new Error(`未知 scraper: ${engine}`);
    err.code = 'UNKNOWN_SCRAPER';
    throw err;
  }
  const scriptAbs = path.join(projectRoot, rel);
  const argv = [scriptAbs];

  if (target.chaptersListUrl && String(target.chaptersListUrl).trim()) {
    argv.push(String(target.chaptersListUrl).trim());
  } else if (target.urlFile && String(target.urlFile).trim()) {
    argv.push('--file', `--url-file=${String(target.urlFile).trim()}`);
  } else {
    const err = new Error('目标需配置 chaptersListUrl 或 urlFile');
    err.code = 'INVALID_TARGET_SOURCE';
    throw err;
  }

  argv.push(`--out-dir=${target.outputDir}`, '--merge');
  if (target.mergeTitle && String(target.mergeTitle).trim()) {
    argv.push(`--merge-title=${String(target.mergeTitle).trim()}`);
  }
  if (limit != null && limit !== '') {
    const s = String(limit).trim();
    if (/^\d+$/.test(s) && parseInt(s, 10) > 0) argv.push(s);
  }

  return { scriptAbs, argv };
}

module.exports = { buildSpawnArgs, SCRAPER_KEYS, SCRAPER_TO_SCRIPT };
