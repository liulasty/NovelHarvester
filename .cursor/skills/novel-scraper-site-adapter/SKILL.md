---
name: novel-scraper-site-adapter
description: Adapts new novel-reading sites into the my-pw-project Playwright pipeline (gaode/<site>/, merge-novel, novel-targets). Use when adding a scraper for a new domain, wiring novel-workflow.js, or debugging chapter/catalog extraction, shuwen6 initTxt/.wen decoding, TImg/timg-map, shuwen6 chapter troubleshooting (many □ or TImg unmapped), anomaly-first workflow (console/failed log then CLI), or merge-novel output for this repo.
---

# 小说站抓取适配（my-pw-project）

## 仓库内既定工作流

```
Playwright 打开真实浏览器
  → 目录页发现章节 { href, title }[]，写入 outputDir/chapters_manifest.json
  → 逐章抓取正文 → outputDir/chapters/001_*.txt …
  → 可选 merge-novel.js → outputDir/merged/{书名}.txt（有 --merge-title 时以书名为文件名）
编排：novel-targets.json + novel-workflow.js（按 scraper 键选 gaode 下脚本）
```

各站独有逻辑只放在 **`gaode/<站点标识>/`**；根目录 **`merge-novel.js`** 负责合并，勿在各站脚本里复制合并规则。

## 异常驱动排错（总原则）

1. **爬取时（先）**  
   以脚本**已有输出**当作「异常是否发生」的一手记录，并让用户能感知：控制台 **`console.warn` / 失败摘要**、**`failed_chapters.json`**（若实现）、分章里的 **`□`** 等。实现或改抓取逻辑时，应在关键分支**明确打日志或落盘**，避免静默失败。  
2. **排错时（后）**  
   **先根据异常类型分类**（`.wen` 失败、超时、TImg 未映射、整章缺失等），再选用手段：**`npx playwright-cli` / 浏览器 DevTools** 用于「需要看真实 DOM、数节点、抄完整 `src`」；**Network 面板**用于 `.wen` / XHR；**改 `timg-map` / 脚本**在原因明确之后。  
   **`playwright-cli` 不是每次排错的第一步**；它适合在**已根据日志判断需要核对页面或 selector** 时使用。新站**初次**探页面、定 selector 时仍可直接用 CLI（与「跑批出问题后的排错」阶段不同）。

## 新站适配清单（按顺序做）

1. **用浏览器验证（禁止只靠 HTTP）**  
   许多站对裸请求返回 401/空壳；必须以 Playwright 页面为准。**初次**确认选择器时可用 **`npx playwright-cli`**：`open` → `goto` → `snapshot` / `eval`。**批量抓取已出现异常时**，先对照控制台与失败记录（见上节），再决定是否需要 CLI。

2. **弄清三类 URL**  
   - **章节目录**：从哪一页列出全部章节？是否有多页目录（如书文 m 站 **每页约 90 条**，`ml.html` → `ml_2.html` → …）？**目录页的「下页」** 与 **正文页的「下页」** 可能同文案不同 href：目录应只跟随 **指向 `ml*.html` 的分页链接**；正文只跟随 **与当前章节 pathname 相同** 的「下页」（`?page=2`）。  
   - **章节阅读页**：正文容器 selector？是否 **AJAX 注入**（先出现「加载中」类文案）？→ 需 `networkidle` 或 `waitForFunction` 直到正文出现。  
   - **章内分页**：同一章是否有多屏？区分 **「下页」**（同章路径 + query）与 **「下一章」**。

3. **实现抓取脚本**（可复制 `gaode/book18/scrape-novel.js` 或 `gaode/shuwen6/scrape-shuwen6.js` 改 selector 与分页逻辑）  
   - 输出：`--out-dir` 指向**书籍根目录**；分章文件写入 **`chapters/`**；manifest 在书籍根目录 **`chapters_manifest.json`**。  
   - 合并：`require(path.join(__dirname, '..', '..', 'merge-novel.js'))`，`--merge` 时调用 `mergeNovel({ inputDir: outputDir, bookTitle })`。  
   - 建议 CLI：`--out-dir`、`--merge`、`--merge-title=`、试跑章节数（与现有脚本一致；**位置参数**：`URL`、可选 **`N` 只抓前 N 章**，例如 `… ml.html 3`）。  
   - **若站点把正文藏在脚本里**（见下文书文 `.wen`）：可用 `page.context().request.get` 拉脚本、`vm.runInNewContext` 注入回调拿 payload，再转纯文本；失败则回退 DOM。

4. **注册**  
   - 在 **`novel-workflow.js`** 的 **`SCRAPER_TO_SCRIPT`** 增加：`站点标识: path.join(__dirname, 'gaode', '<目录>', '<脚本>.js')`。  
   - 在 **`novel-targets.json`** 增加 target：`scraper` 为该键，`chaptersListUrl` 或 `urlFile`，`outputDir`，`mergeTitle`。

5. **试跑**  
   `node novel-workflow.js <新id> 3` 只拉 3 章，检查 `chapters/` 字数与 `merged/` 合并结果。

6. **文档**  
   在 **`gaode/<站点>/说明文档.md`** 中写明目录、正文、分页、解码与注意事项；根目录 **`README.md`** 中维护通用约定，并在「各站实现细节」表中增加指向该站 `说明文档.md` 的链接。

## 与现有站点对齐的约定

| 约定 | 说明 |
|------|------|
| 分章文件名 | `001_标题.txt`（三位序号 + 清理后的标题） |
| 书籍根目录 | `novel-output/<自定义>/`，含 `chapters/`、`merged/`、`chapters_manifest.json` |
| scraper 键 | 与 `SCRAPER_TO_SCRIPT` 一致；缺省为 `book18` |

## 书文（shuwen6）正文：`.wen` 优先，DOM + TImg 兜底

`gaode/shuwen6/scrape-shuwen6.js` 在移动站正文页上除 **DOM + `timg-map.json`** 外，优先走与前端一致的解码链，减少敏感字用 `img.TImg`（base64 图）插入导致的漏字。

| 步骤 | 说明 |
|------|------|
| 发现 URL | 从页面 HTML 正则匹配 `initTxt("…")` 第一个参数；`//i.shuwen6.cc/...` 规范为 `https://...`。 |
| 拉取 | `page.context().request.get(.wen)`，**`Referer` 为当前章节页**，与浏览器一致。 |
| 执行 | `vm.runInNewContext` 执行响应体，注入 `_txt_call`，得到 `{ content, replace }`。 |
| 替换 | `applyTxtReplace`：`replace[d]` 作为正则源码，`d` 作为替换串（与站点 `_chapter.js` 一致）。 |
| 纯文本 | `wenContentToPlainText`：去 `<p>` / `<br>` 等标签，做常见 HTML 实体解码。 |
| 合并策略 | 解码后纯文本 **≥ 50 字**（`MIN_WEN_PLAIN_LEN`）则视为整章成功，**不再**走该章的 DOM/TImg；否则回退 `extractContentPlain`，并保留章内 **「下页」** 分页循环。 |

控制台：`.wen` 异常或过短时可能 **`wen 解码跳过`**；DOM 路径下未映射的 TImg 会提示数量并用 **`□`** 占位（同原逻辑）。

## 书文：异常记录 → 再选手法（含是否用 CLI）

**不要**在未见爬取日志时就盲开 CLI。先对照**同一次运行**里已出现的信号，再决定下一步。

### A. 爬取时已有的记录与通知（优先阅读）

| 信号 | 含义 |
|------|------|
| **`wen 解码跳过: …`** | `.wen` 链失败（`initTxt`/HTTP/VM 等），已回退 DOM。 |
| **`… N 个 TImg 未在 timg-map.json 中映射`** | 当前屏走了 DOM，且 **N 个** `img.TImg` 无 `alt`、且 `src` 不在映射表。 |
| **`ok (x 字)`** 但正文大量 **`□`** | 与上一行同源：占位已写入文件。 |
| **`失败: …`**（整章抛错） | 写入 **`failed_chapters.json`**（`kind: extraction_error`），便于 **`--retry-failed`**（重试时会**强制重拉**该章，不因本地已有文件而跳过）。 |
| **大量 TImg 未映射**（控制台 N 个 … □ 占位） | 写入同一文件（`kind: timg_unmapped`，含 **`unknownTimg`**）；补 **`timg-map.json`** 后对该文件执行 **`--retry-failed`** 即可只重拉这些章。全量再跑时「已存在跳过」**不会**抹掉既有 `timg_unmapped` 记录（除非该章被重新抓取且已无未映射）。 |

### B. 按异常类型决定后续（CLI 仅在其中若干步）

| 你已看到的异常 | 优先动作（不必 CLI） | 何时用上 **CLI / 浏览器** |
|----------------|----------------------|---------------------------|
| 有 **`wen 解码跳过`** | 用 **Network / 页面源码** 查 `initTxt`、`.wen` 是否 200、是否被拦。 | 需在**与脚本相同环境**下复现 DOM 时，再用 CLI `goto` + `eval` 核对 `initTxt` 是否出现在 HTML 中。 |
| **无** `wen 解码跳过`，但 **TImg N 很大** | 推断为 **DOM 回退**（`.wen` 未满足长度等）；对照 `extractChapterText` 是否章内某一屏未走通 `.wen`。 | 需**统计 TImg 个数、唯一 `src` 数**、或从 DOM **复制完整 `src`** 填表时 → 用 **CLI 或浏览器** 打开**该章 URL** 执行 `eval` / Elements。 |
| 必须补 **`timg-map.json`** | — | **几乎总要**打开页面：**完整 `src` 作键**（CLI `eval` 收集或 DevTools 复制）。 |
| 仅 **超时 / 选择器失败** | 对照 `scrape-shuwen6.js` 等待条件；考虑重试、网络。 | 验证 **`#chapter-content` 是否偶发未出现** 时再用 CLI 快照。 |

### C. 落实映射或重跑

- 补 **`timg-map.json`**：键为 **完整 `src`**；优先去重（`new Set(src)`）后再填。  
- 改脚本或网络环境后：**只重跑该章**或 **`--retry-failed`**，再看控制台是否仍有大额 TImg / `wen 解码跳过`。

**原则**：能恢复 **`.wen` 成功路径** 则少依赖 TImg；必须走 DOM 时再补 `timg-map.json`。**CLI 是「已判定要看页面/DOM/src」时的工具**，排在**日志与失败文件**之后。

## 参考文件

- `gaode/book18/scrape-novel.js`：静态 DOM 目录 + `.reader` 正文  
- `gaode/shuwen6/scrape-shuwen6.js`：目录分页 + AJAX 正文 + 章内「下页」+ **`.wen` / `_txt_call` 优先** + `timg-map.json` 兜底  
- `gaode/shuwen6/timg-map.json`：TImg `src` → 单字（可选；`.wen` 成功时本章可不依赖）  
- `merge-novel.js`：`chapters/` 优先，默认 `merged/{bookTitle}.txt`（有 title 时以书名为文件名）  
- `README.md`（项目根）：通用约定与索引；各站细节见 **`gaode/<站点>/说明文档.md`**

## 常见坑

- 正文未加载完就 `innerText` → 字数极少或占位文案。  
- 把「下一章」当成「下页」→ 漏段或乱序。  
- **目录多页**（如书文：第一页就有 90 章、全站共 3 页目录）：若用全局 `a:contains(下页)` 可能点到错误链接；应对 **目录分页 URL 模式**（`ml_*.html`）与 **章内分页**（同 path + query）分别处理，并 **`waitForFunction` 确保每页 `#list ul.chapter-list li a` 已有数据**。  
- **书文 `.wen`**：`initTxt` 缺失、HTTP 非 2xx、VM 执行失败、或解码后过短 → 自动回退 DOM；若仍见大量 `□`，补 `timg-map.json` 或排查 `initTxt`/网络。  
- 忘记在 **`SCRAPER_TO_SCRIPT`** 注册 → workflow 报未知 scraper。

## 相关：手段库演进

若需约定「如何持续新增兜底与记录知识、何时扩充 skill／根目录 README、与其他自动化栈的边界」，见 `.cursor/skills/novel-scraper-playbook-evolution/SKILL.md`。
