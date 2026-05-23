# 项目审查报告：my-pw-project（Playwright 中文小说抓取工具集）

审查时间：2026-05-10
审查范围：全部 40+ 源文件（含 `gaode/` 各站抓取脚本、`lib/orchestrator/` 编排层、`web/` 前端与后端）

---

## 一、总体架构评估

### 1.1 层次结构

```
novel-workflow.js          ← CLI 入口（交互/直接指定）
merge-novel.js             ← 合并模块（可独立调用，也可被各 scraper require）
lib/orchestrator/
  ├── registry.js          ← 站点注册表（站点标识 → 脚本路径）
  ├── targets.js           ← 配置读写、校验、原子写入
  └── plan.js              ← 构建 spawn 参数
gaode/<site>/
  └── scrape-*.js          ← 各站独立抓取脚本（8 个站点）
web/
  ├── server/              ← Express API（targets/tasks/outputs/scrapers CRUD）
  └── client/              ← Vite + React 前端
novel-targets.json         ← 共享配置（CLI + Web 共用）
```

**优点：**
- 层次清晰，各站抓取逻辑与编排层解耦
- 注册表 `registry.js` 作为单一真相来源，新增站点有明确 checklist（README.md 第 64-71 行）
- `merge-novel.js` 设计为可 require + 可 CLI 双模式，复用良好
- Web 控制台与 CLI 共用同一 `novel-targets.json`，`writeAtomic` 通过 tmp + rename 实现原子写入 + `.bak` 备份
- 输出目录约定规范：`chapters/` + `merged/` + `chapters_manifest.json`

### 1.2 整体评价

架构设计合理，对于"多站点小说抓取"这个特定领域做了务实的抽象。编排层、抓取层、合并层分离，新增站点流程文档化。但也存在明显的"早期原型演进"痕迹——各 scraper 间大量复制粘贴，公共 utility 未能提取。

---

## 二、代码质量问题 / 反模式

### 2.1 严重：大段重复代码（DRY 违反）

以下函数在 **全部 8 个 scraper 中一字不差或几乎完全重复**：

| 函数 | 重复次数 | 行数 |
|------|----------|------|
| `extractScrapeFlags()` | 8 次 | ~20 行 × 8 |
| `readUrlFileSync()` | 6 次 | ~15 行 × 6 |
| `chaptersFromUrlFileText()` | 6 次 | ~12 行 × 6 |
| `resolveUrlFilePath()` | 6 次 | ~5 行 × 6 |
| `sanitizeFilePart()` | 8 次 | ~6 行 × 8 |
| `stripAdLines()` / `adFreeText()` | 6 次 | ~15 行 × 6（各站正则不同但结构相同） |

仅这组函数就产生约 **500 行冗余代码**。应提取到 `gaode/lib/` 下共享模块。

**`main()` 函数结构**在 book18、diyibanzhu、nzxs 中近乎相同——CLI 参数解析、目录发现/文件读取二选一、逐章遍历、合并调用，整个 pipeline 是复制粘贴出来的。这是最严重的架构问题：添加新站点时被迫复制数百行样板代码。

### 2.2 BOM 字符处理不一致

`gaode/kateman/scrape-kateman.js:229`：

```js
.replace(/^﻿/, '')  // 字面 BOM 字符 U+FEFF
```

其他文件（book18、diyibanzhu、nzxs 等）统一使用：

```js
.replace(/^﻿/, '')
```

kateman 的写法依赖于源文件保存时实际包含 BOM 字符，如果编辑器或版本控制工具修改了该字符，会静默失效。

### 2.3 `gotoWithRetry` 实现不统一

各 scraper 的 `gotoWithRetry` 使用不同的重试策略：

- **shuwen6、69xku**：attempts 数组（3 种不同 opts），循环调用
- **bookszw**：带指数退避的 for 循环
- **9ksw**：指数退避 + 随机 jitter
- **kateman**：混合策略，最后一次 fallback 到 `waitUntil: 'commit'`

这是站点差异导致的合理分化，但函数签名、错误分类逻辑（`isTransientNavigationError`）在各站重复定义，共性大于差异。

### 2.4 错误处理问题

**静默吞异常：**

```js
// targets.js:132-135
try { fs.copyFileSync(mainPath, bakPath); } catch (_) { /* best-effort backup */ }
// taskManager.js:31-33
try { res.write(`: ping ${Date.now()}\n\n`); } catch (_) {}
// scrape-bookszw.js:215
await page.waitForTimeout(pollMs);
```

**进程退出不清理资源：**

所有 scraper 在 `process.exit(1)` 之前均未确保 `browser.close()` 被调用。例如 book18/scrape-novel.js:182-183：

```js
await browser.close();  // ← 仅在 chapters.length === 0 时关闭
// ...
process.exit(1);        // ← 但很多地方直接 exit 不关 browser
```

这会导致 Playwright 浏览器进程泄漏。

**无区分度的错误处理：**

所有 scraper 在逐章抓取时 catch 到错误仅仅 `console.log('失败: ' + e.message)`，不区分网络错误、反爬拦截、选择器变更等类型。9ksw 有重试机制，但 book18、diyibanzhu、nzxs 等直接跳过无重试。

### 2.5 不稳定选择器冒险

部分站点（69xku、bookszw）使用 `h1` 文本解析分页信息，如果站点修改 h1 的格式，脚本会沉默地产生不全的正文。缺乏断言/验证机制确认分页确实完整。

### 2.6 CLI 参数解析脆弱

`extractScrapeFlags` 使用手工字符串匹配而非 `yargs`/`commander`/`minimist`：

```js
for (const a of argv) {
  if (a.startsWith('--out-dir=')) outputDir = a.slice(10).trim();
```

- `--out-dir` 和 `--out-dir=` 位置不同行为不同（前者不设置值）
- `--merge` 和 `--file` 使用 `restArgv.includes()` 检测，与其他 flag 风格不统一
- boolean flag 和 value flag 混合在同一个循环中处理

### 2.7 Web 前端小问题

- `TargetEditForm.jsx:66` 中 PUT 请求的 URL 使用 `initial.id` 而非当前 `id` 状态——编辑时如果改了 id（虽然 input 被 disabled），URL 仍用旧 id
- 没有表单 dirty 检测，切换页面不会提示未保存更改
- API 路径硬编码 `/api/targets` 等，没有考虑不同部署路径或反向代理前缀

### 2.8 没有测试

`package.json` 中 `"test": "echo \"Error: no test specified\" && exit 1"`——零测试覆盖。对于这种涉及网络请求和 DOM 解析的项目，至少应有：
- 合并模块（`merge-novel.js`）的单元测试
- `chineseNumeralToInt` 的单元测试
- 配置校验的单元测试

---

## 三、安全问题

### 3.1 🔴 严重：kateman scraper 使用 `eval()` 执行第三方代码

`gaode/kateman/scrape-kateman.js:101-108`：

```js
await page.evaluate(() => {
  const scripts = Array.from(document.scripts);
  const script = scripts.find(s => s.textContent.includes('#booktxthtml'));
  if (script) {
    eval(script.textContent);  // ← 执行目标站点的任意 JS
  }
});
```

虽然这是从 Playwright 浏览器上下文内 `evaluate`，且站点加密算法确实需要运行其解密函数，但在**无沙箱保护**的浏览器进程中执行任意第三方代码仍然存在风险：如果目标站点被攻陷并注入了恶意脚本，该脚本能访问 Playwright `page` 上下文的所有内容（包括 Cookie、localStorage、请求拦截器等）。

**建议：**
- 在 `vm` 沙箱中执行解密（如 shuwen6 做法），而非在真实浏览器上下文中 eval
- 或使用 Playwright 的 `page.addInitScript` 拦截并替换解密函数

### 3.2 🟡 中危：shuwen6 使用 `vm.runInNewContext()` 执行远程代码

`gaode/shuwen6/scrape-shuwen6.js:369`：

```js
vm.runInNewContext(trimmed, sandbox, { timeout: 15000 });
```

虽然比全局 `eval` 安全（sandbox 隔离），但历史上 `vm` 模块存在沙箱逃逸漏洞（如 CVE-2023-XXXX）。该代码执行第三方 `.wen` 文件中的 JS。建议：
- 设置 `vm.Script` 的 `cachedData` 以限制执行内容
- 至少对 `sandbox` 做 `Object.freeze` / `Object.create(null)` 增强隔离

### 3.3 🟢 低危：Web API 无速率限制

`web/server/` 的 Express 路由没有 `express-rate-limit` 等节流中间件。虽然默认仅绑定 `127.0.0.1`，但如果开发中被代理暴露到网络，可能被滥用。

### 3.4 🟢 低危：路径穿越防护依赖于白名单

`web/server/routes/outputs.js` 使用 `resolveUnderRoot` + `realpathSync.native` 做路径穿越防护，实现相对严谨。但该白名单动态从 `novel-targets.json` 的 `outputDir` 字段生成——如果配置中包含 `../../etc` 等路径，理论上可以绕过。好在 `whitelistRelativeDirs` 对此做了过滤（`if (rel.startsWith('..')) continue`）。

### 3.5 其他安全考量

- `package.json` 中 `playwright` 版本为 `1.60.0-alpha`——使用 alpha 版本的浏览器自动化库引入未知风险
- 无 CSP header（Content-Security-Policy）——如果 Web UI 存在 XSS，攻击面较大
- web 前端所有 API 调用通过 `/api/` 代理，没有 CSRF token——但因仅绑定 127.0.0.1 且非跨域，风险可控

---

## 四、改进建议

### 4.1 高优先级

| # | 建议 | 文件/模块 | 工作量 |
|---|------|-----------|--------|
| 1 | 提取公用函数到 `gaode/lib/scrape-util.js`：`extractScrapeFlags`、`readUrlFileSync`、`chaptersFromUrlFileText`、`sanitizeFilePart`、`sanitizeFileName`、`resolveUrlFilePath`、`stripAdLines`、`gotoWithRetry`（基础版本） | 全部 scraper | 中（2-4h） |
| 2 | 统一 BOM 处理：kateman 使用 `﻿` 而非字面 BOM 字符 | `kateman/scrape-kateman.js:229` | 小（5min） |
| 3 | 统一 `main()` 流程：提取 CLI 入口样板为共享函数，scraper 仅自定义 discover 和 extract | book18/diyibanzhu/nzxs | 中（2h） |
| 4 | 确保每个 `process.exit()` 前关闭 Playwright browser | 全部 scraper | 小（30min） |
| 5 | kateman：用 `vm.runInNewContext` 替代 browser-context `eval` | `kateman/scrape-kateman.js` | 大（调研+修改） |

### 4.2 中优先级

| # | 建议 | 文件/模块 | 工作量 |
|---|------|-----------|--------|
| 6 | 添加 `merge-novel.js` 和 `chinese-numeral.js` 的单元测试（用 Jest 或 Node 原生 test runner） | 测试 | 小（1h） |
| 7 | 用 `minimist` 或 `commander` 统一 CLI 参数解析并添加 `--help` | 全部 scraper + `novel-workflow.js` | 小（30min） |
| 8 | 9ksw 的章节重试逻辑推广到所有 scraper（可配置） | 全部 scraper | 中（1h） |
| 9 | 添加 `--browser-debug` 参数：失败时保存截图/HTML 到 output-dir | 全部 scraper | 中（1h） |
| 10 | Web 前端添加表单 dirty 检测和离开确认 | `TargetEditForm.jsx` | 小（30min） |

### 4.3 低优先级 / 长期

| # | 建议 | 说明 |
|---|------|------|
| 11 | 迁移到 TypeScript（至少 `lib/orchestrator/` 和 `merge-novel.js`） | 提高类型安全，但成本高 |
| 12 | 给 scraper 添加指数退避 + jitter 的自适应限速（参考 9ksw 的做法） | 减少被网站封禁概率 |
| 13 | 添加 Playwright 浏览器连接池/复用，减少多批任务时的启动开销 | 适合 Web Dashboard 场景 |
| 14 | 持久化 TaskManager 状态到磁盘，支持服务重启后恢复 | web 功能增强 |
| 15 | 添加 CSP header、API rate limiting 等安全中间件 | 安全纵深防御 |
| 16 | 实现 scraper 插拔式架构：每个站点提供一个 export 对象 { discover, extract, name }，而非独立 CLI 脚本 | 架构升级 |

---

## 五、亮点

值得肯定的设计：

1. **`writeAtomic` 安全写入**（`targets.js:123-139`）：tmp 写入 → rename 替换 → `.bak` 备份，流程正确
2. **`merge-novel.js` 双模式设计**：既可作为独立 CLI 使用，也可被 require 调用
3. **`registry.js` 单一真相来源**：新增站点只需要改一处映射表，配合文档化的 checklist
4. **输出目录结构规范**：`chapters/` + `merged/` + `manifest` 分离，兼容旧布局
5. **Web 端路径穿越防护**（`outputs.js`）：使用 `path.resolve` + `realpathSync.native` + 白名单三层防护，实现相对严谨
6. **9ksw 限速设计**：可配置的延迟 + jitter + 失败冷却 + 重试，是各站中抗干扰设计最完善的
7. **shuwen6 的 `.wen` 解码回退机制**：优先 `.wen`，失败回退 DOM + TImg 映射，设计务实
8. **README.md 文档详尽**：目录结构、新增站点流程、环境变量、命令列表、安全提示均到位

---

## 六、总结

本项目在架构上做了合理的分层设计，各站 scraper 针对不同站点的反爬特征做了大量务实的工作。主要问题集中在 **代码复用率低**（各站复制粘贴了大量重复代码）和 **资源生命周期管理**（browser.close 缺失导致泄漏）。最值得优先处理的是：

1. 提取共享 utility 模块——立即减少约 500 行重复代码
2. kateman 的 `eval` 改用 `vm` 沙箱——安全底线
3. 补全 `process.exit` 前的资源清理——防止浏览器进程泄漏

---
*Generated by Claude Code review agent.*
