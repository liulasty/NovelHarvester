/**
 * 将书籍目录下 chapters/ 中的 001_*.txt、002_*.txt … 按序号合并为 merged/全文合并.txt。
 * 若不存在 chapters/ 子目录，则兼容旧版：直接在书籍根目录查找分章文件。
 *
 *   node merge-novel.js
 *   node merge-novel.js --out=D:\path\自定义名.txt
 *   node merge-novel.js --dir=novel-output/xnl --title=性奴训练学园
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = 'novel-output';

const DEFAULT_SEP = '\n\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n\n';

function listChapterFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.txt$/i.test(f))
    .sort((a, b) => parseInt(a.slice(0, 3), 10) - parseInt(b.slice(0, 3), 10));
}

/** 优先使用 书籍根/chapters/，否则使用根目录下的分章文件（旧布局） */
function resolveChaptersLocation(bookRoot) {
  const sub = path.join(bookRoot, 'chapters');
  const subFiles = fs.existsSync(sub) ? listChapterFiles(sub) : [];
  if (subFiles.length > 0) return { chaptersDir: sub, files: subFiles };
  const rootFiles = listChapterFiles(bookRoot);
  return { chaptersDir: bookRoot, files: rootFiles };
}

function guessBookTitle(firstFilePath) {
  const raw = fs.readFileSync(firstFilePath, 'utf8');
  const line = raw.split(/\r?\n/)[0] || '';
  const idx = line.search(/序章|第[一二三四五六七八九十百零〇\d]/);
  if (idx > 1) return line.slice(0, idx).trim();
  return '';
}

function mergeNovel(options = {}) {
  const inputDir = path.resolve(options.inputDir || DEFAULT_DIR);
  const separator = options.separator ?? DEFAULT_SEP;
  const { chaptersDir, files } = resolveChaptersLocation(inputDir);
  if (files.length === 0) {
    console.error(
      `未在 ${inputDir} 找到分章文件（请在 chapters/ 下放 001_标题.txt，或沿用根目录旧布局）`
    );
    return false;
  }

  let bookTitle = options.bookTitle;
  if (!bookTitle) {
    bookTitle = guessBookTitle(path.join(chaptersDir, files[0]));
  }

  const outPath = path.resolve(
    options.outputPath || path.join(inputDir, 'merged', '全文合并.txt')
  );

  const chunks = [];
  if (bookTitle) {
    chunks.push(`${bookTitle}\n\n共 ${files.length} 章\n\n${DEFAULT_SEP.trim()}\n\n`);
  } else {
    chunks.push(`共 ${files.length} 章\n\n${DEFAULT_SEP.trim()}\n\n`);
  }

  for (let i = 0; i < files.length; i++) {
    const p = path.join(chaptersDir, files[i]);
    const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim();
    chunks.push(text);
    if (i < files.length - 1) chunks.push(separator);
  }

  const body = chunks.join('');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${body}\n`, 'utf8');
  console.log(`已合并 ${files.length} 章 → ${outPath}（约 ${body.length} 字符）`);
  return true;
}

function parseCliArgs(argv) {
  const opts = {};
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--out=')) opts.outputPath = a.slice(6);
    else if (a.startsWith('--dir=')) opts.inputDir = a.slice(6);
    else if (a.startsWith('--title=')) opts.bookTitle = a.slice(8);
    else rest.push(a);
  }
  return opts;
}

module.exports = { mergeNovel, listChapterFiles, guessBookTitle, resolveChaptersLocation };

if (require.main === module) {
  const opts = parseCliArgs(process.argv.slice(2));
  const ok = mergeNovel(opts);
  process.exit(ok ? 0 : 1);
}
