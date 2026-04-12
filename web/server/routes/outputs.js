const express = require('express');
const fs = require('fs');
const path = require('path');
const { readConfig } = require('../lib/targetsStore');

const PREVIEW_MAX = 512 * 1024;

function forbidden() {
  const e = new Error('路径不在允许的白名单内');
  e.code = 'FORBIDDEN';
  return e;
}

/**
 * @param {string} projectRoot
 * @returns {Set<string>}
 */
function whitelistRelativeDirs(projectRoot) {
  const { targets } = readConfig(projectRoot);
  const set = new Set();
  for (const t of targets) {
    const rel = path.normalize(String(t.outputDir).trim());
    if (rel.startsWith('..')) continue;
    set.add(rel.split(path.sep).join('/'));
  }
  return set;
}

/**
 * Resolve user path under whitelist root; blocks .. escape.
 * @param {string} projectRoot
 * @param {string} whitelistRel normalized relative from project root
 * @param {string} relPath relative path inside whitelist (posix or native)
 */
function resolveUnderRoot(projectRoot, whitelistRel, relPath) {
  const rootAbs = path.resolve(projectRoot, whitelistRel);
  const rel = String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.');
  const candidate = path.resolve(rootAbs, ...rel);
  const rootResolved = path.resolve(projectRoot, whitelistRel);
  const relFromRoot = path.relative(rootResolved, candidate);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw forbidden();
  }
  if (fs.existsSync(candidate)) {
    let realC;
    let realR;
    try {
      realC = fs.realpathSync.native(candidate);
      realR = fs.realpathSync.native(rootResolved);
    } catch (err) {
      throw forbidden();
    }
    const sep = path.sep;
    if (realC !== realR && !realC.startsWith(realR + sep)) {
      throw forbidden();
    }
  }
  return candidate;
}

/**
 * @param {string} projectRoot
 */
function createOutputsRouter(projectRoot) {
  const r = express.Router();

  r.get('/roots', (_req, res) => {
    try {
      const { targets } = readConfig(projectRoot);
      const seen = new Set();
      const roots = [];
      for (const t of targets) {
        const outputDir = path.normalize(String(t.outputDir).trim()).split(path.sep).join('/');
        if (seen.has(outputDir)) continue;
        seen.add(outputDir);
        roots.push({
          outputDir,
          label: t.label,
          targetId: t.id,
        });
      }
      res.json({ roots });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/list', (req, res) => {
    try {
      const root = String(req.query.root || '').trim();
      const inner = String(req.query.path || '').trim();
      const whitelist = whitelistRelativeDirs(projectRoot);
      const rootNorm = path.normalize(root).split(path.sep).join('/');
      if (!whitelist.has(rootNorm)) return res.status(403).json({ error: 'root 不在白名单' });
      const abs = resolveUnderRoot(projectRoot, rootNorm, inner);
      if (!fs.existsSync(abs)) return res.status(404).json({ error: '路径不存在' });
      const st = fs.statSync(abs);
      if (!st.isDirectory()) return res.status(400).json({ error: '不是目录' });
      const names = fs.readdirSync(abs, { withFileTypes: true });
      const entries = names
        .map((d) => {
          const p = path.join(abs, d.name);
          let st2;
          try {
            st2 = fs.statSync(p);
          } catch {
            return null;
          }
          return {
            name: d.name,
            path: inner ? `${inner.replace(/\\/g, '/')}/${d.name}` : d.name,
            isDirectory: d.isDirectory(),
            size: st2.isFile() ? st2.size : null,
            mtimeMs: st2.mtimeMs,
          };
        })
        .filter(Boolean);
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({ root: rootNorm, path: inner, entries });
    } catch (e) {
      if (e.code === 'FORBIDDEN') return res.status(403).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/preview', (req, res) => {
    try {
      const root = String(req.query.root || '').trim();
      const inner = String(req.query.path || '').trim();
      const whitelist = whitelistRelativeDirs(projectRoot);
      const rootNorm = path.normalize(root).split(path.sep).join('/');
      if (!whitelist.has(rootNorm)) return res.status(403).json({ error: 'root 不在白名单' });
      if (!inner) return res.status(400).json({ error: '须指定 path' });
      const abs = resolveUnderRoot(projectRoot, rootNorm, inner);
      if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件不存在' });
      const st = fs.statSync(abs);
      if (!st.isFile()) return res.status(400).json({ error: '不是文件' });
      if (st.size > PREVIEW_MAX) return res.status(413).json({ error: '文件过大，无法预览' });
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(Math.min(st.size, PREVIEW_MAX));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const sample = buf.toString('utf8');
      const looksBinary = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(sample.slice(0, Math.min(4096, sample.length)));
      if (looksBinary) return res.status(415).json({ error: '二进制文件不可预览' });
      res.type('text/plain; charset=utf-8').send(sample);
    } catch (e) {
      if (e.code === 'FORBIDDEN') return res.status(403).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/download', (req, res) => {
    try {
      const root = String(req.query.root || '').trim();
      const inner = String(req.query.path || '').trim();
      const whitelist = whitelistRelativeDirs(projectRoot);
      const rootNorm = path.normalize(root).split(path.sep).join('/');
      if (!whitelist.has(rootNorm)) return res.status(403).json({ error: 'root 不在白名单' });
      if (!inner) return res.status(400).json({ error: '须指定 path' });
      const abs = resolveUnderRoot(projectRoot, rootNorm, inner);
      if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件不存在' });
      const st = fs.statSync(abs);
      if (!st.isFile()) return res.status(400).json({ error: '不是文件' });
      const name = path.basename(abs);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
      res.sendFile(abs);
    } catch (e) {
      if (e.code === 'FORBIDDEN') return res.status(403).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = { createOutputsRouter };
