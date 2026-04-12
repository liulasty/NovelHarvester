const fs = require('fs');
const path = require('path');
const { SCRAPER_KEYS } = require('./runTarget');

const CONFIG_NAME = 'novel-targets.json';

const ID_RE = /^[a-zA-Z0-9_-]+$/;

function normalizeEnabled(t) {
  return t.enabled !== false;
}

/**
 * @param {unknown} data
 * @returns {{ targets: object[] }}
 */
function validateConfig(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.targets)) {
    const e = new Error('配置须为 { targets: [] }');
    e.code = 'VALIDATION';
    throw e;
  }
  const ids = new Set();
  for (let i = 0; i < data.targets.length; i++) {
    const t = data.targets[i];
    if (!t || typeof t !== 'object') {
      const e = new Error(`targets[${i}] 须为对象`);
      e.code = 'VALIDATION';
      throw e;
    }
    if (!t.id || typeof t.id !== 'string' || !ID_RE.test(t.id.trim())) {
      const e = new Error(`targets[${i}].id 须为非空字母数字、-、_`);
      e.code = 'VALIDATION';
      throw e;
    }
    const id = t.id.trim();
    if (ids.has(id)) {
      const e = new Error(`重复的 id: ${id}`);
      e.code = 'VALIDATION';
      throw e;
    }
    ids.add(id);
    if (!t.label || typeof t.label !== 'string' || !t.label.trim()) {
      const e = new Error(`targets[${i}].label 必填`);
      e.code = 'VALIDATION';
      throw e;
    }
    if (!t.outputDir || typeof t.outputDir !== 'string' || !t.outputDir.trim()) {
      const e = new Error(`targets[${i}].outputDir 必填`);
      e.code = 'VALIDATION';
      throw e;
    }
    const url = t.chaptersListUrl && String(t.chaptersListUrl).trim();
    const file = t.urlFile && String(t.urlFile).trim();
    if ((url && file) || (!url && !file)) {
      const e = new Error(`targets[${i}] 须且仅能配置 chaptersListUrl 或 urlFile 之一`);
      e.code = 'VALIDATION';
      throw e;
    }
    if (t.scraper != null && t.scraper !== '') {
      const s = String(t.scraper).trim();
      if (!SCRAPER_KEYS.includes(s)) {
        const e = new Error(`targets[${i}].scraper 不在允许列表: ${SCRAPER_KEYS.join(', ')}`);
        e.code = 'VALIDATION';
        throw e;
      }
    }
    if (t.mergeTitle != null && typeof t.mergeTitle !== 'string') {
      const e = new Error(`targets[${i}].mergeTitle 须为字符串`);
      e.code = 'VALIDATION';
      throw e;
    }
    if (t.enabled != null && typeof t.enabled !== 'boolean') {
      const e = new Error(`targets[${i}].enabled 须为布尔`);
      e.code = 'VALIDATION';
      throw e;
    }
  }
  return data;
}

/** Strip unknown keys from targets for a stable on-disk shape (CLI ignores extras anyway). */
function sanitizeForWrite(data) {
  return {
    targets: data.targets.map((t) => {
      const out = {
        id: String(t.id).trim(),
        label: String(t.label).trim(),
        outputDir: String(t.outputDir).trim(),
      };
      const scraper = t.scraper != null && String(t.scraper).trim();
      if (scraper) out.scraper = scraper;
      const url = t.chaptersListUrl && String(t.chaptersListUrl).trim();
      const file = t.urlFile && String(t.urlFile).trim();
      if (url) out.chaptersListUrl = url;
      if (file) out.urlFile = file;
      if (t.mergeTitle != null && String(t.mergeTitle).trim()) out.mergeTitle = String(t.mergeTitle).trim();
      if (t.enabled === false) out.enabled = false;
      return out;
    }),
  };
}

function readConfig(projectRoot) {
  const p = path.join(projectRoot, CONFIG_NAME);
  if (!fs.existsSync(p)) {
    const e = new Error(`缺少配置文件: ${CONFIG_NAME}`);
    e.code = 'ENOENT';
    throw e;
  }
  const raw = fs.readFileSync(p, 'utf8');
  let j;
  try {
    j = JSON.parse(raw);
  } catch (err) {
    const e = new Error('novel-targets.json 不是合法 JSON');
    e.code = 'JSON';
    throw e;
  }
  return validateConfig(j);
}

function writeAtomic(projectRoot, data) {
  const validated = validateConfig(data);
  const sanitized = sanitizeForWrite(validated);
  const mainPath = path.join(projectRoot, CONFIG_NAME);
  const tmpPath = path.join(projectRoot, `${CONFIG_NAME}.tmp`);
  const bakPath = path.join(projectRoot, `${CONFIG_NAME}.bak`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
  if (fs.existsSync(mainPath)) {
    try {
      fs.copyFileSync(mainPath, bakPath);
    } catch (_) {
      // best-effort backup
    }
  }
  fs.renameSync(tmpPath, mainPath);
  return sanitized;
}

function findTargetIndex(targets, id) {
  const low = String(id).toLowerCase();
  return targets.findIndex((t) => String(t.id).toLowerCase() === low);
}

module.exports = {
  CONFIG_NAME,
  readConfig,
  writeAtomic,
  validateConfig,
  sanitizeForWrite,
  findTargetIndex,
  normalizeEnabled,
  ID_RE,
  SCRAPER_KEYS,
};
