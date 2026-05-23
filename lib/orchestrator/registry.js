const path = require('path');

/**
 * Scraper registry (single source of truth).
 *
 * NOTE:
 * - script paths are relative to project root
 * - keep in sync with gaode/<site>/ entry scripts
 */
const SCRAPER_TO_SCRIPT_REL = Object.freeze({
  book18: path.join('gaode', 'book18', 'scrape-novel.js'),
  shuwen6: path.join('gaode', 'shuwen6', 'scrape-shuwen6.js'),
  diyibanzhu: path.join('gaode', 'diyibanzhu', 'scrape-diyibanzhu.js'),
  nzxs: path.join('gaode', 'nzxs', 'scrape-nzxs.js'),
  bookszw: path.join('gaode', 'bookszw', 'scrape-bookszw.js'),
  '69xku': path.join('gaode', '69xku', 'scrape-69xku.js'),
  '9ksw': path.join('gaode', '9ksw', 'scrape-9ksw.js'),
  kateman: path.join('gaode', 'kateman', 'scrape-kateman.js'),
});

function listScraperKeys() {
  return Object.keys(SCRAPER_TO_SCRIPT_REL);
}

function getScriptRel(scraperKey) {
  const key = (scraperKey && String(scraperKey).trim()) || 'book18';
  const rel = SCRAPER_TO_SCRIPT_REL[key];
  return { key, rel };
}

function resolveScriptAbs(projectRoot, scraperKey) {
  const { key, rel } = getScriptRel(scraperKey);
  if (!rel) {
    const err = new Error(`未知 scraper: ${key}`);
    err.code = 'UNKNOWN_SCRAPER';
    throw err;
  }
  return path.join(projectRoot, rel);
}

module.exports = {
  SCRAPER_TO_SCRIPT_REL,
  listScraperKeys,
  getScriptRel,
  resolveScriptAbs,
};

