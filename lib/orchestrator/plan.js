const { resolveScriptAbs, SCRAPER_TO_SCRIPT_REL, listScraperKeys } = require('./registry');

/**
 * @param {string} projectRoot
 * @param {object} target
 * @param {string|number|undefined|null} limit
 * @returns {{ scriptAbs: string, argv: string[] }}
 */
function buildSpawnArgs(projectRoot, target, limit) {
  const scriptAbs = resolveScriptAbs(projectRoot, target && target.scraper);
  const argv = [scriptAbs];

  if (target && target.chaptersListUrl && String(target.chaptersListUrl).trim()) {
    argv.push(String(target.chaptersListUrl).trim());
  } else if (target && target.urlFile && String(target.urlFile).trim()) {
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

module.exports = {
  buildSpawnArgs,
  SCRAPER_KEYS: listScraperKeys(),
  SCRAPER_TO_SCRIPT: SCRAPER_TO_SCRIPT_REL,
};

