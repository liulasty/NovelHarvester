const express = require('express');
const {
  readConfig,
  writeAtomic,
  findTargetIndex,
  validateConfig,
} = require('../lib/targetsStore');
const { SCRAPER_KEYS } = require('../lib/runTarget');

/**
 * @param {string} projectRoot
 */
function createTargetsRouter(projectRoot) {
  const r = express.Router();

  r.get('/', (_req, res) => {
    try {
      const cfg = readConfig(projectRoot);
      res.json(cfg);
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/', (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object') return res.status(400).json({ error: '须为 JSON 对象' });
      const cfg = readConfig(projectRoot);
      if (findTargetIndex(cfg.targets, body.id) >= 0) {
        return res.status(409).json({ error: 'id 已存在' });
      }
      cfg.targets.push(body);
      validateConfig(cfg);
      const saved = writeAtomic(projectRoot, cfg);
      res.status(201).json(saved.targets.find((t) => t.id === String(body.id).trim()));
    } catch (e) {
      if (e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/:id', (req, res) => {
    try {
      const { id } = req.params;
      const body = req.body;
      if (!body || typeof body !== 'object') return res.status(400).json({ error: '须为 JSON 对象' });
      const cfg = readConfig(projectRoot);
      const idx = findTargetIndex(cfg.targets, id);
      if (idx < 0) return res.status(404).json({ error: '未知 id' });
      if (String(body.id || '').trim().toLowerCase() !== String(cfg.targets[idx].id).toLowerCase()) {
        return res.status(400).json({ error: 'body.id 必须与路径 id 一致' });
      }
      cfg.targets[idx] = body;
      validateConfig(cfg);
      const saved = writeAtomic(projectRoot, cfg);
      res.json(saved.targets[idx]);
    } catch (e) {
      if (e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  r.patch('/:id', (req, res) => {
    try {
      const { id } = req.params;
      const body = req.body;
      if (!body || typeof body !== 'object') return res.status(400).json({ error: '须为 JSON 对象' });
      const cfg = readConfig(projectRoot);
      const idx = findTargetIndex(cfg.targets, id);
      if (idx < 0) return res.status(404).json({ error: '未知 id' });
      const t = { ...cfg.targets[idx] };
      if ('enabled' in body) {
        if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 须为布尔' });
        t.enabled = body.enabled;
      }
      if ('scraper' in body && body.scraper != null) {
        const s = String(body.scraper).trim();
        if (s && !SCRAPER_KEYS.includes(s)) {
          return res.status(400).json({ error: `scraper 不在允许列表: ${SCRAPER_KEYS.join(', ')}` });
        }
        if (s) t.scraper = s;
        else delete t.scraper;
      }
      cfg.targets[idx] = t;
      validateConfig(cfg);
      const saved = writeAtomic(projectRoot, cfg);
      res.json(saved.targets[idx]);
    } catch (e) {
      if (e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  r.delete('/:id', (req, res) => {
    try {
      const { id } = req.params;
      const cfg = readConfig(projectRoot);
      const idx = findTargetIndex(cfg.targets, id);
      if (idx < 0) return res.status(404).json({ error: '未知 id' });
      cfg.targets.splice(idx, 1);
      validateConfig(cfg);
      writeAtomic(projectRoot, cfg);
      res.status(204).end();
    } catch (e) {
      if (e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = { createTargetsRouter };
