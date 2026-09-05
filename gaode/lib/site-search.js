/**
 * 跨站书名搜索引擎。
 * SITE_SEARCHERS 配置表（key = 展示名/过滤器）：见项目根 README「跨站书名搜索」。
 * 站细节（端点/字段/封锁）随时间可变，改配置不动机器。
 * 通用执行：mode:'form' 填表单提交；mode:'getUrl' 直接 goto 搜索 URL。
 */

const { chromium } = require('playwright');
const { isHitText } = require('./site-search-util.js');

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 45000 };

/** 页面求值/导航中常见的瞬时错误（提交后重定向导致 context 被销毁） */
function isTransientError(e) {
  const msg = e && e.message ? e.message : String(e);
  return /Execution context was destroyed|navigation.*interrupted|net::ERR_ABORTED|Target page, context or browser has been closed/i.test(msg);
}

/** 页面阻塞识别：命中返回 reason，否则 null */
async function blockReason(page) {
  return page.evaluate(() => {
    const t = document.title || '';
    if (/Just a moment|Attention Required|安全验证/i.test(t)) return 'cloudflare_title';
    const head = (document.body ? document.body.innerText : '').slice(0, 800);
    if (/region has been denied|区域.*拒绝|Enable JavaScript and cookies/i.test(head)) return 'cloudflare_body';
    return null;
  }).catch(() => null);
}

/** 整页收集候选锚点（文本 2..80 字、非 javascript:） */
async function collectAnchorCandidates(page, origin) {
  return page.evaluate((origin) => {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href') || '';
      if (!raw || /^javascript:/i.test(raw)) continue;
      const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2 || t.length > 80) continue;
      let abs;
      try { abs = new URL(raw, origin).href; } catch { continue; }
      out.push({ url: abs, text: t });
    }
    return out;
  }, origin);
}

const NAV_RE = /^(首页|目录|上一章|下一章|上一页|下一页|返回|报错|登录|注册|搜索|收藏|推荐|加入书架|开始阅读|最新章节|章节列表|全部章节|全文阅读|下载|评论|书评)$/;

/** 在收集到的锚点里筛命中：文本含书名 */
function pickHits(candidates, keyword, max) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (NAV_RE.test(c.text)) continue;
    if (!isHitText(c.text, keyword)) continue;
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push({ title: c.text, url: c.url });
    if (out.length >= (max || 10)) break;
  }
  return out;
}

async function goto(page, url, label) {
  try {
    await page.goto(url, GOTO_OPTS);
  } catch (e) {
    throw new Error(`${label} 导航失败: ${url} (${(e && e.message || '').slice(0, 140)})`);
  }
}

/** 填搜索表单并提交（输入框 name 优先，退回启发式） */
async function fillAndSubmit(page, keyword, inputName) {
  const r = await page.evaluate(
    ({ kw, inputName }) => {
      const forms = [...document.forms];
      const pick = (f) => {
        const ins = [...f.querySelectorAll('input')].filter((i) => i.type !== 'hidden' && i.type !== 'submit');
        if (inputName) {
          const exact = ins.find((i) => i.name === inputName || i.id === inputName);
          if (exact) return exact;
        }
        return ins.find((i) => /key|search|keyword|wd|\bs\b|q\b|bookname/i.test(`${i.name} ${i.id} ${i.placeholder}`));
      };
      for (const f of forms) {
        const inp = pick(f);
        if (!inp) continue;
        inp.value = kw;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        try { f.requestSubmit(); } catch (_) { f.submit(); }
        return { ok: true, action: f.action, method: (f.method || 'GET').toUpperCase() };
      }
      return { ok: false };
    },
    { kw: keyword, inputName: inputName || '' }
  );
  if (!r.ok) throw new Error('找不到可用搜索表单');
}

/** form 模式：在 searcher.searchPage（缺省 base）填表单并提交；页面加载/跳转未稳时短暂重试 */
async function submitSearch(page, searcher, keyword) {
  const startUrl = searcher.searchPage || searcher.base;
  await goto(page, startUrl, '搜索入口');
  await page.waitForTimeout(800); // 部分站（如 shuwen6）入口页加载即跳转，先等稳定再填
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fillAndSubmit(page, keyword, searcher.inputName);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return;
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e)) throw e;
      await page.waitForTimeout(1200);
    }
  }
  throw lastErr;
}

/** 落地型站点：整页 URL 形如 /chapters/<书名> 时把整页当 1 条命中 */
function landingHit(searcher, pageUrl, keyword) {
  if (searcher.landingPathRe) {
    const m = String(pageUrl).match(searcher.landingPathRe);
    if (m) {
      const title = decodeURIComponent(m[1]);
      if (isHitText(title, keyword)) return { title, url: pageUrl };
    }
  }
  return null;
}

/**
 * 在给定 page 上搜一个站。返回 { key,name,status:'hit'|'none'|'skipped'|'error', reason?, hits }
 */
async function searchSiteWithPage(page, searcher, keyword, opts) {
  const budget = Math.max(searcher.minBudgetMs || 6000, opts.timeoutMs || 12000);
  const deadline = Date.now() + budget;
  const row = { key: searcher.key, name: searcher.name, status: 'none', hits: [] };

  try {
    if (searcher.mode === 'getUrl') {
      const u = typeof searcher.urlBuilder === 'function' ? searcher.urlBuilder(keyword) : searcher.urlBuilder;
      await goto(page, u, '搜索');
    } else {
      await submitSearch(page, searcher, keyword);
    }

    while (Date.now() < deadline) {
      let b, cand;
      try {
        b = await blockReason(page);
        cand = await collectAnchorCandidates(page, new URL(page.url()).origin);
      } catch (e) {
        if (isTransientError(e)) { await page.waitForTimeout(600); continue; } // 提交后重定向未稳
        throw e;
      }
      if (b) return { ...row, status: 'skipped', reason: b };

      let hits = pickHits(cand, keyword, opts.limit);
      const land = landingHit(searcher, page.url(), keyword);
      if (land) hits = [land];
      if (hits.length) {
        row.hits = hits;
        if (opts.verify) row.hits = await verifyHitsOnPage(page, hits);
        return { ...row, status: 'hit' };
      }
      await page.waitForTimeout(900);
    }

    const b = await blockReason(page);
    if (b) return { ...row, status: 'skipped', reason: b };
    return { ...row, status: 'none', reason: '预算内无命中' };
  } catch (e) {
    return { ...row, status: 'error', reason: ((e && e.message) || String(e)).slice(0, 200) };
  }
}

/** --verify：逐个打开详情页做尽力确认（作者/最新章节/目录形态），失败字段留空 */
async function verifyHitsOnPage(page, hits) {
  const out = [];
  for (const h of hits) {
    const v = { title: h.title, url: h.url, author: '', latest: '', catalog: 'unknown' };
    try {
      await goto(page, h.url, '详情');
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        const head = text.slice(0, 4000);
        const mAuthor = head.match(/作者[：:]\s*([^\s|,，\/<>（）()]{2,20})/);
        const mLatest = head.match(/最新章节[：:]?\s*([^\n|,，]{2,40})/);
        const ch = [...text.matchAll(/第\s*(\d{1,4})\s*[章話節节]/g)].map((x) => parseInt(x[1], 10)).filter((n) => n > 0);
        const hasMoreLink = /查看更多章节|查看全部章节|章节目录|全部章节/.test(head);
        return {
          author: mAuthor ? mAuthor[1].trim() : '',
          latest: mLatest ? mLatest[1].trim() : (ch.length ? `第${Math.max(...ch)}章` : ''),
          catalog: hasMoreLink ? 'multi' : 'single',
        };
      });
      Object.assign(v, r);
    } catch (_) { /* 详情尽力而为 */ }
    out.push(v);
  }
  return out;
}

// --- 站点配置表（端点以 2026-09-05 一次性探测为准；改动只在此表） ---

const SITE_SEARCHERS = [
  { key: 'book18', name: 'book18.org', base: 'https://www.book18.org/zh-hans', mode: 'form',
    searchPage: 'https://www.book18.org/zh-hans', inputName: 'q',
    landingPathRe: /^\/zh-hans\/chapters\/([^/]+)$/ },
  { key: 'shuwen6', name: 'm.shuwen6.cc（书文）', base: 'https://m.shuwen6.cc', mode: 'form',
    searchPage: 'https://m.shuwen6.cc/search/', inputName: 'keyword', minBudgetMs: 10000 },
  { key: 'diyibanzhu', name: 'www.diyibanzhu.quest（第一版主）', base: 'https://www.diyibanzhu.quest', mode: 'form',
    searchPage: 'https://www.diyibanzhu.quest/', inputName: 'wd', minBudgetMs: 10000 },
  { key: '9ksw', name: '9ksw.com（九库）', base: 'https://9ksw.com', mode: 'form',
    searchPage: 'https://9ksw.com', inputName: 'keyboard', minBudgetMs: 10000 },
  { key: 'kateman', name: 'www.kateman.net（书海阁）', base: 'https://www.kateman.net', mode: 'form',
    searchPage: 'https://www.kateman.net', inputName: 'searchkey' },
  { key: 'xncwxw', name: 'm.xncwxw.net（新暖才）', base: 'https://m.xncwxw.net', mode: 'form',
    searchPage: 'https://m.xncwxw.net', inputName: 'keyword' },
  { key: 'chengzixs', name: 'www.chengzixs.com（橙子）', base: 'https://www.chengzixs.com', mode: 'getUrl',
    urlBuilder: (kw) => `https://www.chengzixs.com/search/?keyword=${encodeURIComponent(kw)}`, minBudgetMs: 15000 },
  { key: '69xku', name: '69xku.com（69库）', base: 'https://69xku.com', mode: 'form',
    searchPage: 'https://69xku.com', minBudgetMs: 10000 },
  { key: 'xbiquge345', name: 'www.xbiquge345.com（笔趣阁）', base: 'https://www.xbiquge345.com', mode: 'form',
    searchPage: 'https://www.xbiquge345.com', inputName: 's', minBudgetMs: 18000 },

  // headless:false → 默认跳过（能力标记，2026-09-05 实测）；--include-all 时仍会硬试
  { key: 'bookszw', name: 'www.bookszw.com', base: 'http://www.bookszw.com', mode: 'form',
    headless: false, blockedReason: 'Cloudflare Turnstile' },
  { key: '73shu', name: 'www.73shu.cc（73书院）', base: 'http://www.73shu.cc', mode: 'form',
    headless: false, blockedReason: 'Cloudflare 拦截' },
  { key: 'biquzi', name: 'www.biquzi.com（笔趣）', base: 'https://www.biquzi.com', mode: 'form',
    headless: false, blockedReason: '当前出口 IP 区域 403' },
  { key: 'ddw23', name: 'www.23ddw.net（顶点）', base: 'https://www.23ddw.net', mode: 'form',
    headless: false, blockedReason: '站点当前 502/连接关闭' },
  { key: 'nzxs', name: 'www.nzxs.cc（女主小说）', base: 'http://www.nzxs.cc', mode: 'form',
    headless: false, blockedReason: 'chromium 直连超时（https TLS / http 均不通）' },
].map((s) => ({ headless: true, ...s }));

function getSearcher(key) {
  return SITE_SEARCHERS.find((s) => s.key === key) || null;
}

/**
 * 全站搜索：默认跳过 headless:false；opts.sites 白名单、includeAll 硬试。
 * 返回 [{ key,name,status,reason,hits }]，status=hit 时 hits 非空。
 */
async function searchAllSites(keyword, opts) {
  const wanted = (opts.sites || []).map((k) => k.trim()).filter(Boolean);
  const list = SITE_SEARCHERS.filter((s) => !wanted.length || wanted.includes(s.key));
  const browser = await chromium.launch({
    headless: !(process.env.NOVEL_HEADLESS === '0'),
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext();
  const rows = [];
  try {
    for (const searcher of list) {
      if (!searcher.headless && !opts.includeAll) {
        rows.push({ key: searcher.key, name: searcher.name, status: 'skipped', reason: searcher.blockedReason || 'headless 不支持', hits: [] });
        continue;
      }
      // 每站独立 page，避免上一站悬空导航/验证状态串扰本站
      const page = await context.newPage();
      try {
        rows.push(await searchSiteWithPage(page, searcher, keyword, opts));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return rows;
}

module.exports = { SITE_SEARCHERS, getSearcher, searchAllSites, searchSiteWithPage };
