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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.keyword) {
    console.error('用法: node search-novel.js <书名> [--site=a,b] [--verify] [--json] [--limit=K] [--timeout-ms=N] [--include-all]');
    process.exit(2);
  }

  const invalid = opts.sites.filter((k) => !SITE_SEARCHERS.some((s) => s.key === k));
  if (invalid.length) {
    console.error(`未知站点: ${invalid.join(', ')}（可用: ${SITE_SEARCHERS.map((s) => s.key).join(', ')}）`);
    process.exit(2);
  }

  if (!opts.json) {
    console.error(`搜索「${opts.keyword}」…（默认跳过封锁/不可达站，加 --include-all 硬试）`);
  }
  const rows = await searchAllSites(opts.keyword, opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  for (const r of rows) {
    const tag = r.status === 'hit' ? `hit:${r.hits.length}` : r.status;
    console.error(`[${r.key}] ${tag}${r.reason ? ` (${r.reason})` : ''}`);
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

main().catch((e) => { console.error(e); process.exit(1); });
