# 跨站书名搜索工具实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一条命令 `node search-novel.js <书名>`，在已集成的 14 个小说站里真实搜索书名并返回各站命中（书名/作者/详情 URL），把每站搜索端点固化为配置，供以后复用。

**Architecture:** 纯文本归一/命中判定抽到无网络依赖的 `gaode/lib/site-search-util.js`（可单测）；`gaode/lib/site-search.js` 持 `SITE_SEARCHERS` 配置表 + Playwright 执行引擎（通用填表单或 GET URL、封锁识别、整页锚点命中扫描）；根目录 `search-novel.js` 为扁平 CLI。复用设计文档：`docs/superpowers/specs/2026-09-05-cross-site-search-design.md`。

**Tech Stack:** Node 22（内置 `node --test`）、Playwright、既有 `gaode/lib/scraper-common.js` 共享工具。

**前置约定：**
- 仓库工作区有未提交改动（README/registry/novel-targets/`gaode/xbiquge345`、`gaode/73shu`）。**每个 commit 只 `git add` 任务列出的具体文件**，绝不 `git add .` / `-A`，以免带入无关 WIP。
- 本工具默认跳过 CF/区域封锁/宕机站，靠配置能力标记 + 运行时检测双保险（见 Task 3）。
- 站点搜索端点为「运行期事实」，Task 2 会先用一次性脚本复确认，Task 3 据实写进配置。

---

### Task 1: 纯文本归一/命中判定模块（TDD）

**Files:**
- Test: `tests/site-search.test.js`
- Create: `gaode/lib/site-search-util.js`

- [ ] **Step 1: 写失败测试**

创建 `tests/site-search.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeQuery,
  foldTradToSimp,
  canonicalName,
  isHitText,
} = require('../gaode/lib/site-search-util.js');

test('normalizeQuery: 全角转半角/去全角空格/小写/去空白', () => {
  assert.strictEqual(normalizeQuery('　ＡＢＣ　d　'), 'abc d');
});

test('foldTradToSimp: 标题常见繁体转简体', () => {
  assert.strictEqual(foldTradToSimp('神女逍遙錄'), '神女逍遥录');
});

test('canonicalName: 组合归一（含繁体书名词条）', () => {
  assert.strictEqual(canonicalName('　神女逍遙錄　'), '神女逍遥录');
});

test('isHitText: 繁体标题可命中简体关键词', () => {
  assert.ok(isHitText('神女逍遙錄', '神女逍遥录'));
});

test('isHitText: 括号/副标后缀不影响命中', () => {
  assert.ok(isHitText('神女逍遥录（绿）', '神女逍遥录'));
});

test('isHitText: 空值安全', () => {
  assert.strictEqual(isHitText('', '神女逍遥录'), false);
  assert.strictEqual(isHitText('神女逍遥录', ''), false);
});

test('isHitText: 不相干书名不误报', () => {
  assert.strictEqual(isHitText('大漠谣', '神女逍遥录'), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/site-search.test.js`
Expected: FAIL（`MODULE_NOT_FOUND` 找不到 `../gaode/lib/site-search-util.js`）。

- [ ] **Step 3: 实现工具模块**

创建 `gaode/lib/site-search-util.js`：

```js
/**
 * 跨站书名搜索 —— 纯文本归一 / 命中判定（无网络依赖，可用 node --test 单测）。
 * 只用于“判断命中”，不改变站点原文输出。
 */

/** 书名标题中最常见的繁体字 → 简体（命中判定用；遇生字补此表即可，勿动输出） */
const TRAD_TO_SIMP = {
  '遙': '遥', '錄': '录', '遊': '游', '傳': '传', '劍': '剑', '龍': '龙', '鳳': '凤',
  '陽': '阳', '陰': '阴', '塵': '尘', '靈': '灵', '緣': '缘', '夢': '梦', '戀': '恋',
  '戰': '战', '華': '华', '萬': '万', '門': '门', '書': '书', '長': '长', '東': '东',
  '後': '后', '裡': '里', '為': '为', '與': '与', '無': '无', '時': '时', '個': '个',
  '們': '们', '麼': '么', '師': '师', '軍': '军', '見': '见', '來': '来', '風': '风',
  '雲': '云', '節': '节', '變': '变', '說': '说', '還': '还', '這': '这', '樣': '样',
  '點': '点', '實': '实', '當': '当', '條': '条', '體': '体', '會': '会', '間': '间',
  '雙': '双', '將': '将', '兒': '儿', '種': '种', '總': '总', '聖': '圣', '歷': '历',
  '歸': '归', '曉': '晓', '鄉': '乡', '發': '发', '國': '国', '愛': '爱', '強': '强',
};

/** 全角→半角、全角空格→半角、压缩空白、去首尾、小写（字母部分） */
function normalizeQuery(s) {
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 逐字繁体→简体（未收录字原样返回） */
function foldTradToSimp(s) {
  return String(s == null ? '' : s)
    .split('')
    .map((ch) => TRAD_TO_SIMP[ch] || ch)
    .join('');
}

/** 命中用规范形：先规范化再折简体（结果仅用于比较） */
function canonicalName(s) {
  return normalizeQuery(foldTradToSimp(normalizeQuery(s)));
}

/** title 是否命中书名 keyword（繁/简、全/半角、括号后缀均算命中） */
function isHitText(title, keyword) {
  const t = canonicalName(title);
  const kw = canonicalName(keyword);
  if (!t || !kw) return false;
  return t.includes(kw);
}

module.exports = { normalizeQuery, foldTradToSimp, canonicalName, isHitText };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/site-search.test.js`
Expected: 7 个 test 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add tests/site-search.test.js gaode/lib/site-search-util.js
git commit -m "feat(search): 新增书名归一/命中判定工具模块与单测"
```

---

### Task 2: 复确认各站搜索端点（一次性探测，只读）

**Files:**
- Scratch（用完删除）: `gaode/.scratch-recon.js`

探测目标：把设计文档「站点配置表」里的端点/字段逐一在本机验证，记录每站真实 `method / action / 输入框 name / 结果页 finalUrl / 是否出现书名锚点`。探测只读不改仓库。

- [ ] **Step 1: 写探测脚本**

创建 `gaode/.scratch-recon.js`（列表为候选；`form` 走通用填表，`getUrl` 直造）：

```js
const { chromium } = require('playwright');

// 每项：{ key, mode, url(页), input(可选), buildUrl?(kw) }
const CANDIDATES = [
  { key: '69xku', mode: 'form', url: 'https://69xku.com' },
  { key: 'book18', mode: 'form', url: 'https://www.book18.org/zh-hans', input: 'q' },
  { key: '9ksw', mode: 'form', url: 'https://9ksw.com' }, // GET /e/search/index.php?keyboard=
  { key: 'diyibanzhu', mode: 'form', url: 'https://www.diyibanzhu.quest', input: 'wd' },
  { key: 'kateman', mode: 'form', url: 'https://www.kateman.net', input: 'searchkey' },
  { key: 'xncwxw', mode: 'form', url: 'https://m.xncwxw.net', input: 'keyword' },
  { key: 'shuwen6', mode: 'form', url: 'https://m.shuwen6.cc/search/' , input: 'keyword' },
  { key: 'chengzixs', mode: 'getUrl', buildUrl: (kw) => `https://www.chengzixs.com/search/?keyword=${encodeURIComponent(kw)}` },
  { key: 'nzxs', mode: 'form', url: 'http://www.nzxs.cc', input: 's' }, // https 本机 TLS 不通→http
  { key: 'xbiquge345', mode: 'form', url: 'https://www.xbiquge345.com', input: 's' },
  { key: 'bookszw', mode: 'form', url: 'http://www.bookszw.com', input: 'key' },
  { key: '73shu', mode: 'form', url: 'http://www.73shu.cc', input: 'key' },
  { key: 'biquzi', mode: 'form', url: 'https://www.biquzi.com', input: 'key' },
  { key: '23ddw', mode: 'form', url: 'https://www.23ddw.net', input: 'key' },
];

async function fillSubmit(page, kw, inputName) {
  return page.evaluate(({ kw, inputName }) => {
    for (const f of document.forms) {
      const ins = [...f.querySelectorAll('input')].filter((i) => i.type !== 'hidden' && i.type !== 'submit');
      const inp = ins.find((i) => i.name === inputName || i.id === inputName)
        || ins.find((i) => /key|search|keyword|wd|\bs\b|q\b|bookname/i.test(`${i.name} ${i.id} ${i.placeholder}`));
      if (!inp) continue;
      inp.value = kw;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      try { f.requestSubmit(); } catch (_) { f.submit(); }
      return { ok: true, action: f.action, method: (f.method || 'GET').toUpperCase() };
    }
    return { ok: false };
  }, { kw, inputName: inputName || '' });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const KW = '神女逍遥录';
  for (const c of CANDIDATES) {
    const page = await browser.newPage();
    try {
      if (c.mode === 'getUrl') {
        await page.goto(c.buildUrl(KW), { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else {
        await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(800);
        const r = await fillSubmit(page, KW, c.input);
        await page.waitForTimeout(2500);
      }
      const info = await page.evaluate((kw) => {
        const isBlocked = /Just a moment|Attention Required|安全验证|region has been denied|区域.*拒绝/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 600));
        const anchors = [...document.querySelectorAll('a[href]')]
          .map((a) => ({ t: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), h: a.getAttribute('href') }))
          .filter((a) => a.t.includes(kw) || a.t.includes('神女逍') || (a.h || '').includes(kw))
          .slice(0, 4);
        return { title: (document.title || '').slice(0, 60), finalUrl: location.href, isBlocked, anchors };
      }, KW);
      console.log(JSON.stringify({ key: c.key, ...info }));
    } catch (e) {
      console.log(JSON.stringify({ key: c.key, error: (e.message || '').slice(0, 120) }));
    } finally {
      await page.close();
    }
  }
  await browser.close();
})();
```

- [ ] **Step 2: 运行并记录结论**

Run: `node gaode/.scratch-recon.js`
逐站确认四件事，记录到本计划 Task 3 要用的结论里：
1. `finalUrl` 是否进入搜索结果/落地页；
2. `isBlocked` 是否为真（CF / 403 / 空壳）；
3. `anchors` 是否有书名命中；
4. 若 `fillSubmit` 返回的 `action`/`method` 与设计表不符，以实测为准。

预期结论（若与下列不符则以实测为准更新 Task 3 配置）：
- 可达且命中：`69xku`、`book18`（落地 `/chapters/` 繁体名页）、`9ksw`、`diyibanzhu`、`kateman`、`xncwxw`、`shuwen6`、`chengzixs`、`xbiquge345`（命中前偶有十几秒反爬空壳，预算内等）、`nzxs`（http）；
- 封锁/不可达：`bookszw`、`73shu`（CF）、`biquzi`（区域 403）、`23ddw`（502）。

- [ ] **Step 3: 删除临时脚本**

Run: `rm gaode/.scratch-recon.js`（确认已删除：`git status` 无新增 gaode 根文件）。

- [ ] **Step 4: Commit**

如无仓库改动则说明「无改动无需 commit」；若有对既有文件意外改动则仅 `git add` 该文件后回滚恢复。

---

### Task 3: `site-search.js` 引擎 + 站点配置表

**Files:**
- Create: `gaode/lib/site-search.js`

依赖 Task 2 的实测端点；每个函数与字段名要与 Task 1/4 保持一致。

- [ ] **Step 1: 实现引擎与配置**

创建 `gaode/lib/site-search.js`：

```js
/**
 * 跨站书名搜索引擎。
 * SITE_SEARCHERS 配置表（key = 展示名/过滤器）：见项目根 README「跨站书名搜索」。
 * 站细节（端点/字段/封锁）随时间可变，改配置不动机器。
 * 通用执行：mode:'form' 填表单提交；mode:'getUrl' 直接 goto 搜索 URL。
 */

const { chromium } = require('playwright');
const { isHitText } = require('./site-search-util.js');

const GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 45000 };

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

/** 在收集到的锚点里筛命中：文本含书名，或等于落地章节页且 href 为详情/目录页形态 */
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

/** form 模式：在 searcher.searchPage（缺省 base）填表单并提交 */
async function submitSearch(page, searcher, keyword) {
  const startUrl = searcher.searchPage || searcher.base;
  await goto(page, startUrl, '搜索入口');
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
    { kw: keyword, inputName: searcher.inputName || '' }
  );
  if (!r.ok) throw new Error('找不到可用搜索表单');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/** book18：落地 /chapters/<书名> 时把整页当 1 条命中 */
function landingHit(searcher, pageUrl, keyword, origin) {
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
      const b = await blockReason(page);
      if (b) return { ...row, status: 'skipped', reason: b };

      const cand = await collectAnchorCandidates(page, new URL(page.url()).origin);
      let hits = pickHits(cand, keyword, opts.limit);
      const land = landingHit(searcher, page.url(), keyword, new URL(page.url()).origin);
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

// --- 站点配置表（端点以 Task 2 实测为准） ---

const SITE_SEARCHERS = [
  { key: 'book18', name: 'book18.org', base: 'https://www.book18.org/zh-hans', mode: 'form',
    searchPage: 'https://www.book18.org/zh-hans', inputName: 'q',
    landingPathRe: /^\/zh-hans\/chapters\/([^/]+)$/ },
  { key: 'shuwen6', name: 'm.shuwen6.cc（书文）', base: 'https://m.shuwen6.cc', mode: 'form',
    searchPage: 'https://m.shuwen6.cc/search/', inputName: 'keyword', minBudgetMs: 10000 },
  { key: 'diyibanzhu', name: 'www.diyibanzhu.quest（第一版主）', base: 'https://www.diyibanzhu.quest', mode: 'form',
    searchPage: 'https://www.diyibanzhu.quest/', inputName: 'wd', minBudgetMs: 10000 },
  { key: '9ksw', name: '9ksw.com（九库）', base: 'https://9ksw.com', mode: 'form',
    searchPage: 'https://9ksw.com/e/search/index.php', inputName: 'keyboard', minBudgetMs: 10000 },
  { key: 'kateman', name: 'www.kateman.net（书海阁）', base: 'https://www.kateman.net', mode: 'form',
    searchPage: 'https://www.kateman.net', inputName: 'searchkey' },
  { key: 'xncwxw', name: 'm.xncwxw.net（新暖才）', base: 'https://m.xncwxw.net', mode: 'form',
    searchPage: 'https://m.xncwxw.net', inputName: 'keyword' },
  { key: 'chengzixs', name: 'www.chengzixs.com（橙子）', base: 'https://www.chengzixs.com', mode: 'getUrl',
    urlBuilder: (kw) => `https://www.chengzixs.com/search/?keyword=${encodeURIComponent(kw)}`, minBudgetMs: 15000 },
  { key: '69xku', name: '69xku.com（69库）', base: 'https://69xku.com', mode: 'form',
    searchPage: 'https://69xku.com', minBudgetMs: 10000 },
  { key: 'nzxs', name: 'www.nzxs.cc（女主小说）', base: 'http://www.nzxs.cc', mode: 'form',
    searchPage: 'http://www.nzxs.cc', inputName: 's', blockedReason: 'http base（https 本机 TLS 不通）' },
  { key: 'xbiquge345', name: 'www.xbiquge345.com（笔趣阁）', base: 'https://www.xbiquge345.com', mode: 'form',
    searchPage: 'https://www.xbiquge345.com', inputName: 's', minBudgetMs: 18000 },

  // headless:false → 默认跳过（能力标记）；--include-all 时仍会硬试
  { key: 'bookszw', name: 'www.bookszw.com', base: 'http://www.bookszw.com', mode: 'form',
    headless: false, blockedReason: 'Cloudflare Turnstile' },
  { key: '73shu', name: 'www.73shu.cc（73书院）', base: 'http://www.73shu.cc', mode: 'form',
    headless: false, blockedReason: 'Cloudflare 拦截' },
  { key: 'biquzi', name: 'www.biquzi.com（笔趣）', base: 'https://www.biquzi.com', mode: 'form',
    headless: false, blockedReason: '当前出口 IP 区域 403' },
  { key: 'ddw23', name: 'www.23ddw.net（顶点）', base: 'https://www.23ddw.net', mode: 'form',
    headless: false, blockedReason: '站点当前 502/连接关闭' },
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
  const page = await context.newPage();
  const rows = [];
  try {
    for (const searcher of list) {
      if (!searcher.headless && !opts.includeAll) {
        rows.push({ key: searcher.key, name: searcher.name, status: 'skipped', reason: searcher.blockedReason || 'headless 不支持', hits: [] });
        continue;
      }
      rows.push(await searchSiteWithPage(page, searcher, keyword, opts));
    }
  } finally {
    await browser.close();
  }
  return rows;
}

module.exports = { SITE_SEARCHERS, getSearcher, searchAllSites, searchSiteWithPage };
```

（如 Task 2 实测有出入：改 `inputName`/`urlBuilder`/`searchPage`/`minBudgetMs`，或把某站 `headless` 置 `false`。）

- [ ] **Step 2: 冒烟单站命中**

Run: `node -e "require('./gaode/lib/site-search.js').searchAllSites('神女逍遥录',{sites:['69xku'],timeoutMs:15000}).then(r=>console.log(JSON.stringify(r,null,2)))"`
Expected: 69xku 行 `status:'hit'`，`hits` 内含 `https://69xku.com/book/21428/`。

- [ ] **Step 3: 冒烟默认跳过封锁站**

Run: `node -e "require('./gaode/lib/site-search.js').searchAllSites('神女逍遥录',{timeoutMs:8000}).then(r=>console.log(r.map(x=>x.key+':'+x.status).join('\n')))"`
Expected: `bookszw:skipped` 等 headless:false 站出现；可达站逐个 hit/none/error（本命令不因单站异常中断）。

- [ ] **Step 4: Commit**

```bash
git add gaode/lib/site-search.js
git commit -m "feat(search): 新增跨站搜索引擎与站点配置表"
```

---

### Task 4: `search-novel.js` CLI + 接通 `npm test`

**Files:**
- Create: `search-novel.js`
- Modify: `package.json`（test 脚本）

- [ ] **Step 1: 实现 CLI**

创建 `search-novel.js`：

```js
#!/usr/bin/env node
/**
 * 跨站书名搜索 CLI：在已集成站点真实搜索书名并汇总命中。
 *
 *   node search-novel.js 神女逍遥录
 *   node search-novel.js 神女逍遥录 --site=69xku,xbiquge345
 *   node search-novel.js 神女逍遥录 --verify --limit=5 --timeout-ms=15000
 *   node search-novel.js 神女逍遥录 --include-all --json
 */

const { searchAllSites, SITE_SEARCHERS } = require('./gaode/lib/site-search.js');

function parseArgs(argv) {
  const o = { sites: [], includeAll: false, verify: false, json: false, timeoutMs: 12000, limit: 10 };
  const positional = [];
  for (const a of argv) {
    if (a === '--include-all') o.includeAll = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--site=')) o.sites = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--limit=')) o.limit = parseInt(a.slice(8), 10) || 10;
    else if (a.startsWith('--timeout-ms=')) o.timeoutMs = parseInt(a.slice(13), 10) || 12000;
    else if (a.startsWith('--')) { /* 忽略未知开关 */ }
    else positional.push(a);
  }
  return { ...o, keyword: positional.join(' ') };
}

function log(...args) {
  if (!(global.__JSON_MODE__)) console.log(...args);
}
function errLog(...args) {
  console.error(...args);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  global.__JSON_MODE__ = opts.json;

  if (!opts.keyword) {
    errLog('用法: node search-novel.js <书名> [--site=a,b] [--verify] [--json] [--limit=K] [--timeout-ms=N] [--include-all]');
    process.exit(2);
  }

  const invalid = opts.sites.filter((k) => !SITE_SEARCHERS.some((s) => s.key === k));
  if (invalid.length) {
    errLog(`未知站点: ${invalid.join(', ')}（可用: ${SITE_SEARCHERS.map((s) => s.key).join(', ')}）`);
    process.exit(2);
  }

  errLog(`搜索「${opts.keyword}」…（跳过站点仅打印原因；加 --include-all 硬试）`);
  const rows = await searchAllSites(opts.keyword, opts);

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  for (const r of rows) {
    const tag = r.status === 'hit' ? `hit:${r.hits.length}` : r.status;
    errLog(`[${r.key}] ${tag}${r.reason ? ` (${r.reason})` : ''}`);
  }

  const hitRows = rows.filter((r) => r.status === 'hit');
  if (hitRows.length) {
    console.log('\n=== 命中汇总 ===');
    for (const r of hitRows) {
      for (const h of r.hits) {
        const extra = opts.verify
          ? ` | 作者=${h.author || '?'} | 最新=${h.latest || '?'} | 目录=${h.catalog || '?'}`
          : '';
        console.log(`[${r.key}] ${h.title} → ${h.url}${extra}`);
      }
    }
  } else {
    console.log('无命中（各站均 none/skipped/error）。可加 --verify 或 --include-all 复核。');
  }
}

main().catch((e) => { errLog(e); process.exit(1); });
```

注意：`log`/`errLog` 里 `__JSON_MODE__` 用 global 简单标记，确保 `--json` 时 stdout 只有 JSON、进度走 stderr。

- [ ] **Step 2: 接通 npm test**

修改 `package.json` 的 scripts：

```json
"test": "node --test tests/",
```

- [ ] **Step 3: 冒烟 CLI 各参数**

Run: `node search-novel.js 神女逍遥录 --site=69xku`
Expected: stderr 一行 `[69xku] hit:...`；stdout 命中汇总含 `69xku.com/book/21428`。

Run: `node search-novel.js 一个必然不存在的书名xyz --timeout-ms=5000`
Expected: 退出码 0；各站 none/skipped/error 行，末尾「无命中」。

Run: `node search-novel.js 神女逍遥录 --json --site=69xku | node -e "process.stdin.on('data',d=>{JSON.parse(d);console.log('json ok')})"`
Expected: 输出 `json ok`（stdout 是合法 JSON）。

Run: `npm test`
Expected: Task 1 的 7 个单测 PASS。

- [ ] **Step 4: Commit**

```bash
git add search-novel.js package.json
git commit -m "feat(search): 新增 search-novel.js CLI 并接通 npm test"
```

---

### Task 5: 根 README 文档

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在「常用命令」前加小节**

在 `README.md` 的「常用命令」表格上方插入以下小节（如 README 当前还含未提交的 xbiquge345 行属正常 WIP，随本文件一并提交并在 commit 说明里注明）：

```markdown
## 跨站书名搜索

在**已集成站点**里真实搜索书名（Playwright），用于判断「某书在哪些站收录、URL 长什么样」，再决定加到 `novel-targets.json`。端点/字段固化在 `gaode/lib/site-search.js` 的 `SITE_SEARCHERS`；纯文本归一在 `gaode/lib/site-search-util.js`（`node --test tests/`）。

```bash
node search-novel.js 神女逍遥录                # 全站
node search-novel.js 神女逍遥录 --site=69xku   # 只搜 69xku
node search-novel.js 神女逍遥录 --verify       # 命中再开详情页确认 作者/最新章节/目录单页或分页
node search-novel.js 神女逍遥录 --json         # stdout 仅输出 JSON
# --site=a,b  --limit=K  --timeout-ms=N(每站预算)  --include-all(封锁/宕机站也硬试)
```

**站点覆盖（2026-09-05 实测）：** 无头可搜 `book18`/`shuwen6`/`diyibanzhu`/`9ksw`/`kateman`/`xncwxw`/`chengzixs`/`69xku`/`nzxs`(http)/`xbiquge345`；默认跳过 `bookszw`、`73shu`（Cloudflare）、`biquzi`（区域 403）、`23ddw`（502），加 `--include-all` 硬试。`--verify` 为尽力而为；命中输出保留站点原文标题（同名多版本会并排，需人工挑选）。
```

- [ ] **Step 2: 核对链接一致性**

确认小节里提到的两个文件路径与真实路径一致（`gaode/lib/site-search.js`、`gaode/lib/site-search-util.js`）。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 增补跨站书名搜索小节"
```

---

### Task 6: 端到端冒烟（对应 spec 测试节）

**Files:** 无（只跑命令核验）

- [ ] **Step 1: 命中已知书**

Run: `node search-novel.js 神女逍遥录 --site=69xku,xbiquge345`
Expected: 69xku `hit` 含 `https://69xku.com/book/21428/`；xbiquge345 hit/none/error 均可但不得抛异常中断。

- [ ] **Step 2: 不存在书名全绿退出**

Run: `node search-novel.js qqqqzzzz不存在xxxx --timeout-ms=4000`
Expected: 退出码 0，末尾「无命中」。

- [ ] **Step 3: JSON 合法性**

Run: `node search-novel.js 神女逍遥录 --json --site=69xku > /tmp/s.json && node -e "const r=require('/tmp/s.json'); console.log('rows='+r.length)"`
Expected: `rows=1`。

- [ ] **Step 4: 汇总并核对 git 未混入 WIP**

Run: `git status --short`、`git log --oneline -5`
Expected: 本轮 commit 仅含本工具相关文件；工作区剩余的是用户既有 WIP（73shu、registry/novel-targets/xbiquge345、README 早期未提交内容若仍在）。

- [ ] **Step 5: 更新收尾说明**

在最终总结里列出：新增文件 4 个（含测试）、修改 2 个（package.json、README.md）、用法示例、站点覆盖/封锁清单、`--verify` 尽力而为的边界。
