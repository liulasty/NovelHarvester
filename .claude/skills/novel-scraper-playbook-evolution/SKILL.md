---
name: novel-scraper-playbook-evolution
description: >-
  Defines how the my-pw-project novel scraping playbook evolves when new sites or
  new extraction techniques are needed. Use when extending gaode scrapers,
  adding fallback chains (DOM, .wen, request, timg-map), improving logging or
  retry, deciding what to document in SKILL vs 根目录 README / gaode 说明文档 vs code only, or
  comparing when to stay on Playwright vs other browser automation stacks.
---

# 小说抓取「手段库」演进（my-pw-project）

## 与既有技能的关系

- **具体适配步骤**（目录、选择器、书文 `.wen`、TImg、`novel-workflow` 注册等）以 **`novel-scraper-site-adapter`** 为准；本技能只描述**如何持续加手段、把经验固化**，不重复其细节。
- 执行任务时：先按 site-adapter 做站点实现；若涉及「又多了一种站点类型／又多了一条解码或兜底路径」，再依本文件的**演进循环**更新仓库与文档。

## 演进循环（不断增加手段时必走）

以**可观测异常**驱动，避免先猜：

1. **观测**：同一轮执行的控制台、`failed_chapters.json`、章节内 `□`、字数突降等（与 site-adapter「异常驱动」一致）。
2. **分类**：属于网络／选择器／动态注入／加密脚本／图字替换／分页混淆等哪一类；一类问题对应一条**清晰手段**，避免堆砌无标题的 if。
3. **选手段**：在**本仓默认栈**内优先（Playwright 真实页面 → `page.request` / 执行脚本解 payload → DOM + 站点专用映射如 `timg-map` → 重试与失败落盘）。只有当需求明确超出 Node + Playwright（例如必须多语言驱动、或强制某 WebDriver 基础设施）时，再单独评估 Selenium 等；**默认不为单站引入第二套自动化框架**。
4. **落地**：手段落在 **`gaode/<site>/`** 的可读函数或注释块中；共用逻辑可抽到同目录模块，**不要**把合并规则复制进各站（仍由根目录 `merge-novel.js` 负责）。例：笔趣阁类 **`#list` 内 `<dt>` 区分「最新」与正文区**、章内 **`id_N.html` 分页** 等，优先在 **Playwright + 选择器/轮询** 内解决，而非换自动化框架。
5. **回写知识**：见下节「写在哪里」— 能让下一次代理／人类**少试错**的才写进 skill 或 **`gaode/<站点>/说明文档.md`**（全项目约定仍写根目录 **`README.md`**）。

### failed_chapters 与书文手段（补充）

- **`kind: timg_unmapped` 且 `unknownTimg` 很大**：先核对同章 **`initTxt`→`.wen`** 是否可拉取、解码后纯文本是否 ≥ `MIN_WEN_PLAIN_LEN`（见 `gaode/shuwen6/scrape-shuwen6.js`）。若 `.wen` 正常，**不必**向 `timg-map.json` 批量填图；用 `--retry-failed` 或排除网络/脚本问题即可。仅当必须走 DOM 且仍有少量未映射 `TImg` 时，再按「完整 `src` → 单字」增量维护 `timg-map.json`。
- **`kind: extraction_error` 且日志含 `networkidle`**：多为历史运行遗留；当前脚本已用 `domcontentloaded` 等策略，**重跑 `--retry-failed`** 即可对照。

## 写在哪里（扩充准则）

| 内容 | 放哪里 |
|------|--------|
| 可执行的选择器、等待、URL 规律、站点专用解码 | **`gaode/<site>/` 代码** |
| 全项目约定（输出目录、manifest、workflow 键） | **`novel-scraper-site-adapter`** + 根目录 **`README.md`** |
| 单站目录／正文／分页／解码／命令示例 | **`gaode/<站点>/说明文档.md`**（书文 `.wen`/TImg 细节亦在此） |
| **可复用的异常类型 → 手段顺序**（例如：先日志再 CLI、先 `.wen` 再 TImg） | **site-adapter** 或本 **playbook-evolution**（择一处维护，避免两份矛盾；以「先出现的那份」为准，另一处只留一句链接） |
| 新出现的「站型」或「新兜底类型」（值得所有适配者知道） | 在 **site-adapter** 增一节或一表；若属于**方法论**（何时加手段、何时不扩张框架）则加在本 skill |

**原则**：Skill 里写**决策与顺序**；程序里写**事实与数值**；根目录 **`README.md`** 写**项目级约定与索引**；**`gaode/<站点>/说明文档.md`** 写**该站人类可读的说明与命令示例**。

## 与其他浏览器自动化工具的关系（选型边界）

本仓流水线已绑定 **Playwright**（真实浏览器、与 `novel-workflow.js` 一致）。下列仅作**边界认知**，不在未经用户要求时改栈：

| 方向 | 说明 |
|------|------|
| 多语言 / 既有 Selenium 资产 | 可能倾向 **Selenium**；与本仓并存需额外编排，非默认。 |
| 仅 Chromium、极简 Node 抓取 | **Puppeteer** 类似场景多；本仓已用 Playwright，除非整体迁移否则不混用。 |
| 应用内 E2E、重交互调试 | **Cypress** 等；与本仓「离线小说输出」目标不同，一般不混进 `gaode/`。 |
| 合约级 WebDriver 抽象 | **WebDriverIO**；同上，非本仓默认。 |
| 视觉／自然语言驱动业务流 | **Skyvern** 等 AI 驱动；与可维护的选择器脚本互补而非替代，引入需单独架构决策。 |

**演进时的默认**：在 Playwright 内增加 **等待策略、请求旁路、VM 执行页内脚本、映射表、重试与观测**，直到确定是「框架边界」问题再讨论换工具。  
书文等广告/长连较多的移动站：若 `page.goto(..., networkidle)` 频繁超时，优先改为 **`domcontentloaded` / `load` + 正文容器显式等待**（见 `gaode/shuwen6/scrape-shuwen6.js` 的 `gotoChapterPage`），避免把「永远达不到的 idle」当成站点不可用。

## 新增手段后的检查清单

- [ ] 新手段是否在**单站目录**内闭合，且未复制合并逻辑？
- [ ] 失败路径是否有 **warn / 落盘**（避免静默劣化）？
- [ ] `novel-workflow.js` / `novel-targets.json` 是否需要更新？
- [ ] 若为新站型：**`gaode/<站点>/说明文档.md`**（及根目录 **`README.md`** 索引表链接）是否补上目录／正文／分页／注意事项？
- [ ] 若手段可复用：**site-adapter** 或本 skill 是否用**一小节或表格行**更新，避免口头知识流失？

## 参考

- [.cursor/skills/novel-scraper-site-adapter/SKILL.md](../novel-scraper-site-adapter/SKILL.md)
