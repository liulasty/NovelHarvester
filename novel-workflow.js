/**
 * 多目标一键流程：按 novel-targets.json 选择目标 → 抓取分章 → 合并全文。
 *
 *   node novel-workflow.js              交互选择（输入序号或 id）
 *   node novel-workflow.js list         仅列出目标
 *   node novel-workflow.js xnl          跑指定 id
 *   node novel-workflow.js local 5      本地列表 + 只抓前 5 章（试跑）
 */

const readline = require('readline');
const { spawnSync } = require('child_process');

const { readConfig, resolveTarget } = require('./lib/orchestrator/targets');
const { buildSpawnArgs } = require('./lib/orchestrator/plan');

function loadConfig() {
  try {
    const j = readConfig(__dirname);
    return j.targets;
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

function printTargets(targets) {
  console.log('可用目标：');
  targets.forEach((t, i) => {
    const src = t.chaptersListUrl ? '目录页' : `文件 ${t.urlFile}`;
    const eng = t.scraper ? ` [${t.scraper}]` : '';
    const dis = t.enabled === false ? ' (disabled)' : '';
    console.log(`  [${i + 1}] ${t.id}  —  ${t.label}${eng}${dis}  (${src} → ${t.outputDir})`);
  });
}

function askTarget(targets) {
  return new Promise((resolve) => {
    printTargets(targets);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('输入序号或 id 后回车: ', (line) => {
      rl.close();
      resolve(resolveTarget(targets, String(line).trim()));
    });
  });
}

function validateTarget(t) {
  if (t.chaptersListUrl) return;
  if (t.urlFile) return;
  console.error('目标需配置 chaptersListUrl 或 urlFile');
  process.exit(1);
}

function runScrapeForTarget(t, limit) {
  validateTarget(t);
  let scriptArgs;
  try {
    scriptArgs = buildSpawnArgs(__dirname, t, limit);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
  const args = scriptArgs.argv;

  const engine = (t.scraper && String(t.scraper).trim()) || 'book18';
  if (engine === 'bookszw' && process.env.NOVEL_HEADLESS !== '0' && process.env.BOOKSZW_HEADED !== '1') {
    console.log(
      '提示: bookszw 易被 Cloudflare 拦截；无头模式会长时间等待。若卡住请先 Ctrl+C，再在 CMD 执行 set NOVEL_HEADLESS=0，或在 PowerShell 执行 $env:NOVEL_HEADLESS = "0"，然后重跑本命令。'
    );
  }

  console.log('执行:', 'node', args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
  const r = spawnSync(process.execPath, args, {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (r.error) throw r.error;
  process.exit(r.status === null ? 1 : r.status);
}

async function main() {
  const targets = loadConfig();
  const a1 = process.argv[2];
  const a2 = process.argv[3];

  if (!a1) {
    const t = await askTarget(targets);
    if (!t) {
      console.error(
        '未识别目标：须输入上方列表中的序号（如 7）或目标的 id（如 bookszw-22313），输入后回车；勿留空行。'
      );
      process.exit(1);
    }
    runScrapeForTarget(t, a2);
    return;
  }

  if (a1 === 'list' || a1 === '--list') {
    printTargets(targets);
    return;
  }

  const t = resolveTarget(targets, a1);
  if (!t) {
    console.error(`未知目标: ${a1}`);
    printTargets(targets);
    process.exit(1);
  }
  runScrapeForTarget(t, a2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
