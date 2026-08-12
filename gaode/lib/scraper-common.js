/**
 * 共享抓取工具（gaode 各站点 scraper 复用）。
 *
 * 每个函数都与原各站本地实现行为一致；站点差异通过 options 表达，
 * 默认值即各站今天的行为。真正站点相关的逻辑（目录/正文选择器、等待循环、
 * parseEntryUrl 等）留在各站 gaode/<site>/ 内，不在此处。
 */

const fs = require('fs');
const path = require('path');
const { chineseNumeralToInt } = require('./chinese-numeral');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

/** 清理文件名：非法字符 → _，压缩空白，截断 120 字 */
function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** 标题是否形如「第 n 章」；opts.extraRe 追加额外匹配（如 9ksw 的「间章」） */
function titleLooksLikeChapterHeading(title, opts) {
  if (/第\s*(?:\d+|[零一二三四五六七八九十百千万两廿卅]+)\s*章/.test(String(title || ''))) return true;
  const extra = opts && opts.extraRe;
  return !!(extra && extra.test(String(title || '')));
}

/** 从标题解析「第 n 章」用于排序；无则 null。opts.zeroRe 命中返回 0（开始阅读类） */
function chapterNumberFromTitle(title, opts) {
  const t = String(title || '').trim();
  const m = t.match(/第\s*(\d+)\s*章/);
  if (m) return parseInt(m[1], 10);
  const mc = t.match(/第\s*([零一二三四五六七八九十百千万两廿卅]+)\s*章/);
  if (mc) {
    const n = chineseNumeralToInt(mc[1]);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  if (/楔子|序章|^序$|前言/.test(t)) return -1;
  if (/番外/.test(t)) return 1e9;
  if (opts && opts.zeroRe && opts.zeroRe.test(t)) return 0;
  return null;
}

/**
 * 合并多页目录：正文区（main）按章号升序，仅出现在 latest 且不在 main 的链接补尾。
 * opts.dedupeByNum 默认 true（按章号去重 + 阿拉伯标题优先，ddw23/biquzi）；
 * bookszw/69xku 传 false（不做章号去重）。
 */
function mergeChapterLists(mainRows, latestRows, opts) {
  const dedupeByNum = !(opts && opts.dedupeByNum === false);
  const byHref = new Map();
  for (const r of mainRows) {
    const ex = byHref.get(r.href);
    if (!ex) byHref.set(r.href, { href: r.href, title: r.title, inMain: true, inLatest: false });
    else {
      ex.inMain = true;
      if (titleLooksLikeChapterHeading(r.title)) ex.title = r.title;
    }
  }
  for (const r of latestRows) {
    const ex = byHref.get(r.href);
    if (!ex) byHref.set(r.href, { href: r.href, title: r.title, inMain: false, inLatest: true });
    else ex.inLatest = true;
  }

  let dedupedHrefs = new Set();
  if (dedupeByNum) {
    const byNum = new Map();
    for (const x of byHref.values()) {
      const num = chapterNumberFromTitle(x.title);
      if (num == null || Number.isNaN(num)) continue;
      const existing = byNum.get(num);
      if (!existing) { byNum.set(num, x); continue; }
      if (!existing.inMain && x.inMain) { byNum.set(num, x); }
      else if (existing.inMain === x.inMain) {
        const existingIsArabic = /第\s*\d+\s*章/.test(existing.title);
        const xIsArabic = /第\s*\d+\s*章/.test(x.title);
        if (!existingIsArabic && xIsArabic) byNum.set(num, x);
      }
    }
    dedupedHrefs = new Set(Array.from(byNum.values(), (v) => v.href));
  }

  const body = [];
  const tail = [];
  for (const x of byHref.values()) {
    const num2 = chapterNumberFromTitle(x.title);
    if (dedupeByNum && num2 != null && !Number.isNaN(num2) && !dedupedHrefs.has(x.href)) continue;
    const sk = num2 != null && !Number.isNaN(num2) ? num2 : 1e6;
    const item = { href: x.href, title: x.title, sk };
    if (x.inMain) body.push(item);
    else tail.push(item);
  }
  const cmp = (a, b) => a.sk - b.sk || a.title.localeCompare(b.title, 'zh-Hans-CN');
  body.sort(cmp);
  tail.sort(cmp);
  return [...body, ...tail].map(({ href, title }) => ({ href, title }));
}

/** 判断是否为可重试的瞬时导航错误（接受 Error 对象或字符串） */
function isTransientNavError(e) {
  const msg = e && e.message ? e.message : String(e);
  return /Execution context was destroyed/i.test(msg) ||
    /Target page, context or browser has been closed/i.test(msg) ||
    /Navigation failed/i.test(msg) ||
    /net::ERR_ABORTED/i.test(msg) ||
    /most likely because of a navigation/i.test(msg);
}

/** 过滤广告/导航行；opts.adRe 与 opts.pageRe 均为正则，命中即剔除 */
function stripAdLines(text, opts) {
  const adRe = opts && opts.adRe;
  const pageRe = opts && opts.pageRe;
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (adRe && adRe.test(s)) return false;
      if (pageRe && pageRe.test(s)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/** 正文前与 h1 重复的章标题、单独的分页行；opts.extraNoiseRe 追加（xncwxw 【】页、bookszw 开始阅读） */
function isLeadingNoiseLine(trimmed, opts) {
  const t = String(trimmed || '').trim();
  if (!t) return false;
  if (/^第\s*[\d零一二三四五六七八九十百千万两]+\s*章/u.test(t)) return true;
  if (/^[（(]第\s*\d+\s*\/\s*\d+\s*页[）)]$/.test(t)) return true;
  const extra = opts && opts.extraNoiseRe;
  return !!(extra && extra.test(t));
}

function stripLeadingNoise(text, opts) {
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') { i++; continue; }
    if (isLeadingNoiseLine(t, opts)) { i++; continue; }
    break;
  }
  return lines.slice(i).join('\n').trim();
}

/** 解析 CLI 标志 --out-dir / --url-file / --merge-title（多数站一致；不用的站忽略 urlFile） */
function extractFlags(argv) {
  let outputDir = process.env.NOVEL_OUTPUT_DIR && process.env.NOVEL_OUTPUT_DIR.trim() || 'novel-output';
  let urlFile = process.env.NOVEL_URL_FILE && process.env.NOVEL_URL_FILE.trim() || 'chapters_urls.txt';
  let mergeTitle = '';
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--out-dir=')) outputDir = a.slice(10).trim();
    else if (a.startsWith('--url-file=')) urlFile = a.slice(11).trim();
    else if (a.startsWith('--merge-title=')) mergeTitle = a.slice(14).trim();
    else rest.push(a);
  }
  return { outputDir, urlFile, mergeTitle, restArgv: rest };
}

/** 有头启动检测：NOVEL_HEADLESS=0 或 <SITE>_HEADED=1（opts.envKey 传站点环境变量名） */
function useHeadedLaunch(opts) {
  const envKey = opts && opts.envKey;
  return process.env.NOVEL_HEADLESS === '0' || !!(envKey && process.env[envKey] === '1');
}

// --- URL 文件三件套 ---

function resolveUrlFilePath(urlFile) {
  return path.isAbsolute(urlFile) ? urlFile : path.join(PROJECT_ROOT, urlFile);
}

function readUrlFileSync(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.slice(2).toString('utf16be');
  return buf.toString('utf8');
}

function chaptersFromUrlFileText(raw) {
  return String(raw).replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => /^https?:\/\//i.test(l))
    .map((href) => ({ href, title: path.basename(href) }));
}

/** 从 h1/title/文末 解析 第M/N页、第M页/共N页 等；返回 [当前页, 总页数] 或 null */
function parsePageFraction(text) {
  const t = String(text || '');
  const patterns = [
    /[（(]第\s*(\d+)\s*页\s*[\/／]\s*共\s*(\d+)\s*页[）)]/u,
    /[（(]第\s*(\d+)\s*页\s*[\/／]\s*(\d+)\s*页[）)]/u,
    /[（(]\s*第\s*(\d+)\s*[\/／]\s*(\d+)\s*页\s*[）)]/u,
    /第\s*(\d+)\s*页\s*[\/／]\s*共\s*(\d+)\s*页/u,
    /第\s*(\d+)\s*[\/／]\s*(\d+)\s*页/u,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  }
  return null;
}

/** 正文块内「尚未结束、还有下一屏」提示 */
function chunkImpliesMorePages(chunk) {
  return /本章未完|未完待续|请点击下一页|下页继续|下一页继续|点击下一页继续阅读/i.test(String(chunk || ''));
}

/** 追加章节失败记录到 JSONL（失败不应中断主流程） */
function appendFailureLog(logPath, entry) {
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
}

module.exports = {
  sanitizeFilePart,
  titleLooksLikeChapterHeading,
  chapterNumberFromTitle,
  mergeChapterLists,
  isTransientNavError,
  stripAdLines,
  isLeadingNoiseLine,
  stripLeadingNoise,
  extractFlags,
  useHeadedLaunch,
  resolveUrlFilePath,
  readUrlFileSync,
  chaptersFromUrlFileText,
  parsePageFraction,
  chunkImpliesMorePages,
  appendFailureLog,
};
