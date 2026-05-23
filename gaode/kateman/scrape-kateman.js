/**
 * kateman.net（书海阁小说网）适配：
 * 1) 传入书籍页 URL（/shuwu/{bookId}/）→ 从 .panel-body > a[href*="xiaoshuo_"] 提取章节列表
 * 2) 章节正文用 CryptoJS AES-CBC 解密（key="encryptedDatastr", IV=Base64, ZeroPadding）
 *    浏览器加载后：waitForFunction 等待 CryptoJS → 执行内联解密脚本 → 读 #booktxthtml.innerText
 * 3) 章内分页：跟随「下一页」链接（_2.html, _3.html …）拼接全文
 *
 * 用法：
 *   node gaode/kateman/scrape-kateman.js https://www.kateman.net/shuwu/hqqhpm/
 *   node gaode/kateman/scrape-kateman.js https://www.kateman.net/shuwu/hqqhpm/ 5
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MERGE_NOVEL = path.join(__dirname, '..', '..', 'merge-novel.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const GOTO_OPTS = { waitUntil: 'commit', timeout: 120000 };
const CONTENT_DECRYPT_TIMEOUT = 60000;
const MAX_PAGES_PER_CHAPTER = 20;

function sanitizeFilePart(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

async function gotoWithRetry(page, url, label, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
      return;
    } catch (e) {
      const isLast = attempt === maxRetries - 1;
      const msg = e?.message || String(e);
      const retryable = /Timeout|ERR_CONNECTION|ERR_ABORTED|net::ERR|timeout/i.test(msg);
      if (!isLast && retryable) {
        console.warn(`    [kateman] ${label} 重试 ${attempt + 2}/${maxRetries}: ${msg.slice(0, 120)}`);
        await page.waitForTimeout(3000 * (attempt + 1));
        continue;
      }
      if (!isLast) throw e;
      // Last attempt: try with 'commit' and wait manually
      await page.goto(url, { waitUntil: 'commit', timeout: 120000 });
      return;
    }
  }
}

async function discoverChapters(page, entryUrl) {
  console.log(`[kateman] 打开书籍页: ${entryUrl}`);
  await gotoWithRetry(page, entryUrl, '书籍页');
  await page.waitForSelector('.panel-body', { timeout: 60000 });
  await page.waitForTimeout(3000);

  const chapters = await page.evaluate(() => {
    const panels = document.querySelectorAll('.panel.panel-default');
    // Find the panel with the most xiaoshuo_ links (the chapter list)
    let bestPanel = null;
    let bestCount = 0;
    for (const p of panels) {
      const links = p.querySelectorAll('a[href*="xiaoshuo_"]');
      if (links.length > bestCount) {
        bestCount = links.length;
        bestPanel = p;
      }
    }
    if (!bestPanel) return [];

    const seen = new Set();
    const result = [];
    const links = bestPanel.querySelectorAll('a[href*="xiaoshuo_"]');
    for (const a of links) {
      const href = a.href;
      if (seen.has(href)) continue;
      seen.add(href);
      result.push({
        href: href,
        title: (a.textContent || '').replace(/\s+/g, ' ').trim()
      });
    }
    return result;
  });

  console.log(`[kateman] 发现 ${chapters.length} 章`);
  return chapters;
}

async function decryptChapterContent(page) {
  // Wait for CryptoJS and the x() function to be available
  await page.waitForFunction(
    () => typeof CryptoJS !== 'undefined' && typeof x === 'function',
    { timeout: CONTENT_DECRYPT_TIMEOUT }
  );

  // Find and eval the inline decryption script for booktxthtml
  await page.evaluate(() => {
    const scripts = Array.from(document.scripts);
    const script = scripts.find(s => s.textContent.includes('#booktxthtml'));
    if (script) {
      eval(script.textContent);
    }
  });

  // Wait briefly for DOM update
  await page.waitForTimeout(1000);
}

async function getDecryptedText(page) {
  return page.evaluate(() => {
    const el = document.getElementById('booktxthtml');
    if (!el) return '';
    // Get innerText (includes paragraph breaks) or innerHTML as fallback
    return el.innerText || el.textContent || '';
  });
}

async function hasNextPage(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    return links.some(a => a.textContent.trim().includes('下一页'));
  });
}

async function getNextPageUrl(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const next = links.find(a => a.textContent.trim().includes('下一页'));
    return next ? next.href : null;
  });
}

async function loadChapterPage(page, url, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 120000 });
      await page.waitForSelector('#booktxthtml', { timeout: 120000 });
      await decryptChapterContent(page);
      return;
    } catch (e) {
      const isLast = attempt === 2;
      const msg = e?.message || String(e);
      const retryable = /Timeout|ERR_CONNECTION|ERR_ABORTED|net::ERR|timeout/i.test(msg);
      if (!isLast && retryable) {
        console.warn(`    [kateman] ${label} 重试 ${attempt + 2}/3: ${msg.slice(0, 120)}`);
        await page.waitForTimeout(3000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

async function extractChapterFullText(page, chapterUrl) {
  const shortLabel = path.basename(new URL(chapterUrl).pathname);
  console.log(`  [kateman] 打开章节: ${shortLabel}`);

  // Load the first page
  await loadChapterPage(page, chapterUrl, shortLabel);

  let allTextParts = [];
  const text = await getDecryptedText(page);
  allTextParts.push(text);

  // Follow pagination within the chapter
  let pageCount = 1;
  while (pageCount < MAX_PAGES_PER_CHAPTER) {
    const hasNext = await hasNextPage(page);
    if (!hasNext) break;

    const nextUrl = await getNextPageUrl(page);
    if (!nextUrl) break;

    // Avoid infinite loop: make sure the next URL is different
    if (nextUrl === page.url()) break;

    pageCount++;
    const nextLabel = path.basename(new URL(nextUrl).pathname);
    console.log(`    [kateman] 章内第 ${pageCount} 页: ${nextLabel}`);

    await loadChapterPage(page, nextUrl, nextLabel);

    const nextText = await getDecryptedText(page);
    allTextParts.push(nextText);
  }

  if (pageCount > 1) {
    console.log(`    [kateman] 共 ${pageCount} 页`);
  }

  return allTextParts.join('\n\n').trim();
}

function extractScrapeFlags(argv) {
  let outputDir = process.env.NOVEL_OUTPUT_DIR?.trim() || 'novel-output';
  let urlFile = process.env.NOVEL_URL_FILE?.trim() || 'chapters_urls.txt';
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

function resolveUrlFilePath(urlFile) {
  if (path.isAbsolute(urlFile)) return urlFile;
  return path.join(PROJECT_ROOT, urlFile);
}

function readUrlFileSync(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.slice(2).toString('utf16be');
  }
  return buf.toString('utf8');
}

function chaptersFromUrlFileText(raw) {
  const text = String(raw).replace(/^﻿/, '');
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => /^https?:\/\//i.test(l))
    .map((href) => ({ href, title: path.basename(href) }));
}

function adFreeText(raw) {
  // Remove common ad lines that appear in the decrypted content
  return raw
    .split(/\r?\n/)
    .filter(line => {
      const s = line.trim();
      if (!s) return true;
      // Filter out common ad/message lines
      if (/更多内容加载中.*请稍候/.test(s)) return false;
      if (/本站只支持手机浏览器访问/.test(s)) return false;
      if (/章节内容加载失败/.test(s)) return false;
      if (/请关闭浏览器的阅读模式/.test(s)) return false;
      if (/复制网址到其他浏览器/.test(s)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

async function main() {
  const { outputDir, urlFile, mergeTitle, restArgv } = extractScrapeFlags(process.argv.slice(2));
  const manifestFile = path.join(outputDir, 'chapters_manifest.json');
  const chaptersDir = path.join(outputDir, 'chapters');

  const runMerge = restArgv.includes('--merge');
  const useFileOnly = restArgv.includes('--file');
  const posArgs = restArgv.filter(a => !a.startsWith('--')).map(a => a.trim());
  const entryUrl = posArgs[0] && /^https?:\/\//i.test(posArgs[0]) ? posArgs[0] : null;
  const limitArg = posArgs.find((a, i) => i > 0 && /^\d+$/.test(a)) || (entryUrl ? posArgs[1] : posArgs[0]);
  const maxChapters = limitArg ? parseInt(limitArg, 10) : 0;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(chaptersDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });

  let chapters;
  if (useFileOnly) {
    const urlFileAbs = resolveUrlFilePath(urlFile);
    if (!fs.existsSync(urlFileAbs)) {
      console.error(`已指定 --file，但未找到 URL 列表文件: ${urlFileAbs}`);
      process.exit(1);
    }
    chapters = chaptersFromUrlFileText(readUrlFileSync(urlFileAbs));
    console.log(`[kateman] 从 ${urlFileAbs} 读取 ${chapters.length} 个 URL`);
  } else if (entryUrl) {
    chapters = await discoverChapters(page, entryUrl);
    fs.writeFileSync(manifestFile, JSON.stringify(chapters, null, 2), 'utf8');
    console.log(`[kateman] 已写入 ${manifestFile}`);
  } else {
    console.error('请传入书籍页 URL，例如: node gaode/kateman/scrape-kateman.js https://www.kateman.net/shuwu/hqqhpm/');
    await browser.close();
    process.exit(1);
  }

  if (Number.isFinite(maxChapters) && maxChapters > 0) {
    chapters = chapters.slice(0, maxChapters);
    console.log(`[kateman] 限制为前 ${maxChapters} 章`);
  }

  const total = chapters.length;
  if (total === 0) {
    await browser.close();
    console.error('[kateman] 未得到任何章节 URL');
    process.exit(1);
  }

  for (let i = 0; i < total; i++) {
    const { href, title } = chapters[i];
    const id = path.basename(new URL(href).pathname);
    const namePart = sanitizeFilePart(title) || id;
    const fileName = `${String(i + 1).padStart(3, '0')}_${namePart}.txt`;
    const outPath = path.join(chaptersDir, fileName);

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 100) {
      console.log(`[${i + 1}/${total}] 跳过（已存在） ${fileName}`);
      continue;
    }

    process.stdout.write(`[${i + 1}/${total}] ${id} … `);
    try {
      const text = await extractChapterFullText(page, href);
      const cleanText = adFreeText(text);
      fs.writeFileSync(outPath, `${title}\n\n${cleanText}`, 'utf8');
      console.log(`ok (${cleanText.length} 字)`);
    } catch (e) {
      console.log(`失败: ${e.message}`);
      console.error(`[kateman] 章节抓取失败 ${id}: ${href} — ${e.message}`);
    }
  }

  await browser.close();
  console.log('[kateman] 完成，输出目录:', path.resolve(outputDir));

  if (runMerge) {
    const { mergeNovel } = require(MERGE_NOVEL);
    mergeNovel({
      inputDir: outputDir,
      ...(mergeTitle ? { bookTitle: mergeTitle } : {}),
    });
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
