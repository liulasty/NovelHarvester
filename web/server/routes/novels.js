const express = require('express');
const fs = require('fs');
const path = require('path');

const CHAPTER_FILE_RE = /^(\d+)_(.+)\.txt$/i;

/**
 * @param {string} projectRoot
 */
function discoverNovels(projectRoot) {
  const outputDir = path.join(projectRoot, 'novel-output');
  let dirs;
  try {
    dirs = fs.readdirSync(outputDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const novels = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const novelPath = path.join(outputDir, d.name);
    novels.push(buildNovelMeta(novelPath, d.name));
  }
  novels.sort((a, b) => b.updatedAt - a.updatedAt);
  return novels;
}

/**
 * @param {string} novelPath
 * @param {string} dirName
 */
function buildNovelMeta(novelPath, dirName) {
  // Read manifest for chapter list
  const manifestPath = path.join(novelPath, 'chapters_manifest.json');
  let chapters = [];
  let manifestChapterCount = 0;
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        chapters = parsed;
        manifestChapterCount = parsed.length;
      } else if (parsed && Array.isArray(parsed.chapters)) {
        chapters = parsed.chapters;
        manifestChapterCount = parsed.chapters.length;
      }
    } catch { /* ignore */ }
  }

  // Read merged dir for title
  const mergedDir = path.join(novelPath, 'merged');
  let title = '';
  let mergedFile = '';
  let mergedSize = 0;
  let updatedAt = 0;
  if (fs.existsSync(mergedDir)) {
    try {
      const files = fs.readdirSync(mergedDir, { withFileTypes: true });
      for (const f of files) {
        if (f.isFile() && f.name.endsWith('.txt')) {
          const fp = path.join(mergedDir, f.name);
          const st = fs.statSync(fp);
          if (st.size > mergedSize) {
            mergedSize = st.size;
            mergedFile = f.name;
            title = f.name.replace(/\.txt$/i, '');
            updatedAt = Math.max(updatedAt, st.mtimeMs);
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Count actual chapter files
  const chaptersDir = path.join(novelPath, 'chapters');
  let actualChapterCount = 0;
  if (fs.existsSync(chaptersDir)) {
    try {
      const files = fs.readdirSync(chaptersDir, { withFileTypes: true });
      for (const f of files) {
        if (f.isFile() && CHAPTER_FILE_RE.test(f.name)) actualChapterCount++;
      }
    } catch { /* ignore */ }
  }

  return {
    id: dirName,
    title: title || dirName,
    mergedFile,
    mergedSize,
    chapterCount: manifestChapterCount || actualChapterCount,
    chapters,
    updatedAt,
  };
}

/**
 * @param {string} projectRoot
 */
function createNovelsRouter(projectRoot) {
  const r = express.Router();

  // List all novels
  r.get('/', (_req, res) => {
    try {
      const novels = discoverNovels(projectRoot);
      // Return lightweight list (no chapter detail)
      const list = novels.map(({ id, title, mergedFile, mergedSize, chapterCount, updatedAt }) => ({
        id, title, mergedFile, mergedSize, chapterCount, updatedAt,
      }));
      res.json(list);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get novel detail (with chapters)
  r.get('/:id', (req, res) => {
    try {
      const dir = path.resolve(path.join(projectRoot, 'novel-output', req.params.id));
      if (!dir.startsWith(path.resolve(path.join(projectRoot, 'novel-output')))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return res.status(404).json({ error: '未找到该小说' });
      }
      const meta = buildNovelMeta(dir, req.params.id);
      if (!meta.title) return res.status(404).json({ error: '未找到该小说' });

      // Also list chapters_dir files with seq for linking
      const chaptersDir = path.join(dir, 'chapters');
      const chapterFiles = [];
      if (fs.existsSync(chaptersDir)) {
        const files = fs.readdirSync(chaptersDir, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile()) continue;
          const m = f.name.match(CHAPTER_FILE_RE);
          if (m) {
            chapterFiles.push({
              seq: parseInt(m[1], 10),
              fileName: f.name,
              title: m[2].replace(/\.txt$/i, ''),
            });
          }
        }
      }
      chapterFiles.sort((a, b) => a.seq - b.seq);

      // Merge manifest with actual files
      const mergedChapters = meta.chapters.map((c, i) => ({
        seq: i + 1,
        title: c.title || `第 ${i + 1} 章`,
        href: c.href || '',
      }));

      res.json({
        id: meta.id,
        title: meta.title,
        mergedFile: meta.mergedFile,
        mergedSize: meta.mergedSize,
        chapterCount: meta.chapterCount,
        chapters: mergedChapters,
        hasExistingFile: chapterFiles.length > 0,
        updatedAt: meta.updatedAt,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get chapter content
  r.get('/:id/chapter/:seq', (req, res) => {
    try {
      const seq = parseInt(req.params.seq, 10);
      if (isNaN(seq) || seq < 1) return res.status(400).json({ error: '无效章节序号' });

      const dir = path.resolve(path.join(projectRoot, 'novel-output', req.params.id));
      if (!dir.startsWith(path.resolve(path.join(projectRoot, 'novel-output')))) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const chaptersDir = path.join(dir, 'chapters');
      if (!fs.existsSync(chaptersDir)) return res.status(404).json({ error: '章节目录不存在' });

      const files = fs.readdirSync(chaptersDir, { withFileTypes: true });
      const targetPrefix = String(seq).padStart(3, '0');
      let targetFile = '';
      for (const f of files) {
        if (f.isFile() && f.name.startsWith(targetPrefix + '_')) {
          targetFile = f.name;
          break;
        }
      }
      if (!targetFile) return res.status(404).json({ error: `第 ${seq} 章未找到` });

      const content = fs.readFileSync(path.join(chaptersDir, targetFile), 'utf8');
      // Get prev/next for navigation
      const prevSeq = seq > 1 ? seq - 1 : null;
      const nextSeq = seq < 99999 ? seq + 1 : null; // will be validated

      res.json({
        seq,
        title: targetFile.replace(/^\d+_/, '').replace(/\.txt$/i, ''),
        content,
        prevSeq,
        nextSeq,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get merged file content
  r.get('/:id/merged', (req, res) => {
    try {
      const dir = path.resolve(path.join(projectRoot, 'novel-output', req.params.id));
      if (!dir.startsWith(path.resolve(path.join(projectRoot, 'novel-output')))) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const meta = buildNovelMeta(dir, req.params.id);
      if (!meta.mergedFile) return res.status(404).json({ error: '合并文件未找到' });

      const mergedPath = path.join(dir, 'merged', meta.mergedFile);
      if (!fs.existsSync(mergedPath)) return res.status(404).json({ error: '合并文件未找到' });

      const st = fs.statSync(mergedPath);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Length', st.size);
      res.setHeader('X-Novel-Title', encodeURIComponent(meta.title));
      const stream = fs.createReadStream(mergedPath);
      stream.pipe(res);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = { createNovelsRouter };
