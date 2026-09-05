# 跨站书名搜索工具（可复用）— 设计文档

日期：2026-09-05
状态：已批准设计，待实现

## 背景与目标

my-pw-project 已集成 14 个小说站的抓取适配器（`gaode/<site>/scrape-<site>.js` + `lib/orchestrator/registry.js`）。此前要判断「某书名在哪些已集成站收录」时，靠临时派研究代理逐站搜一遍，端点知识不落盘、不可复用。

本工具目标：**一条命令在全部已集成站点里搜索书名，返回各站命中（书名/作者/详情页 URL）**；并把「每站搜索端点/表单字段/封锁情况」固化为配置文件，供以后复用与演进。

不在范围内：
- 不把命中自动写入 `novel-targets.json`（找书与加 target 是两步，工具只负责找）。
- 不做站点正文抓取（那已由各站 scraper 承担）。

## 组件与文件

| 文件 | 职责 |
|------|------|
| `gaode/lib/site-search.js` | 可复用库：`SITE_SEARCHERS` 配置表、`searchSite(key, kw, opts)`、`searchAllSites(kw, opts)`、书名归一与命中解析工具 |
| `search-novel.js`（项目根） | CLI 入口：解析参数、逐站进度、汇总命中表、`--json` 输出 |
| `README.md`（项目根） | 新增「跨站书名搜索」小节（用法 + 站点覆盖/封锁清单） |

库函数约定：
- `searchSite(key, keyword, opts)` → `{ site, status: 'hit'|'none'|'skipped'|'error', hits, reason }`；`hits: [{ title, author?, url }]`
- `searchAllSites(keyword, opts)` → 数组，元素为上述对象；`opts.site` 为逗号分隔白名单（缺省全部）

## 站点配置表（`SITE_SEARCHERS`）

键 = 展示名/过滤器（沿用 scraper 键或域名）。每行字段：

| 字段 | 说明 |
|------|------|
| `key` | 过滤器键（如 `69xku`） |
| `name` | 展示名（如 `69xku.com（69库）`） |
| `base` | 搜索/站点基准 URL；**nzxs 用 `http://`（https 当前本机 TLS 不通）**，其余用站点默认协议 |
| `mode` | `form`（打开搜索页/首页，填表单提交）或 `getUrl`（直接构造 GET 搜索 URL） |
| `action` / `method` / `fields` | `mode:'form'` 时：表单 action 与要填的字段（`{ name, hidden?, value? }` 等） |
| `urlBuilder` | `mode:'getUrl'` 时：由 keyword 构造搜索 URL |
| `headless` | 布尔能力标记；`false` 表示默认跳过（封锁/需验证） |
| `blockedReason` | 默认跳过原因（如 `Cloudflare Turnstile` / `区域 403` / `宕机 502` / `https TLS`） |
| `resultParse` | 结果容器选择器；缺省为「整页扫 `<a>` 按书名/href 命中」退化策略 |

已探明的端点（实现时用一次性探测脚本逐站复确认后定稿，不凭记忆写死）：

| 站点 | 已知信息 |
|------|----------|
| 69xku.com `69xku` | 首页/站内搜索直接命中（mode 待定稿） |
| 9ksw.com `9ksw` | GET `/e/search/index.php`，字段 `keyboard`；结果落到 `/e/search/result/?searchid=` |
| diyibanzhu.quest `diyibanzhu` | POST `/wap.php?action=search`，字段 `wd` |
| kateman.net `kateman` | POST `/search`，字段 `searchkey` |
| m.xncwxw.net `xncwxw` | POST `/s.php`，字段 `keyword` + 隐藏 `t` |
| m.shuwen6.cc `shuwen6` | POST `/search/`，字段 `keyword` |
| chengzixs.com `chengzixs` | GET `/search/?keyword=`；CF 回源不稳（520/522/500）需重试 ~4 次 |
| book18.org `book18` | 首页表单 GET action=`/`，字段 `q`；填简体可自动命中繁体书名词条 |
| www.nzxs.cc `nzxs` | POST `/search.html`，字段 `s`；用 `http://` base |
| xbiquge345.com `xbiquge345` | POST `/s.php`，字段 `type=articlename` + `s`；命中前有约 15s 反爬间隔（视为慢站，预算内等） |
| www.bookszw.com `bookszw` | CF Turnstile → `headless:false` |
| www.73shu.cc `73shu` | CF 拦截 → `headless:false` |
| www.biquzi.com `biquzi` | 当前出口 IP 区域 403 → `headless:false` |
| www.23ddw.net `ddw23` | 当前 502 空壳/连接关闭 → `headless:false`（运行时可因网络变化动态处理） |

`headless:false` 站由 CLI 默认跳过并打印 `skipped(<blockedReason>)`；`--include-all` 时硬试。

## 执行引擎与封锁识别

- 单例 Playwright chromium（headless，支持 `NOVEL_HEADLESS=0` 有头），**逐站串行**、复用同一个 page。
- 每站短预算：默认 `12s`（`--timeout-ms=` 可调），到点 fail-fast 切下一站。
- `mode:'form'` 通用路径：打开 `action` 页 → 定位/填入 `fields` → 提交 → 等导航 + 短轮询结果容器；`mode:'getUrl'`：直接 `goto(urlBuilder(kw))`。
- 封锁识别（命中即 `skipped` + 归类原因，不干等 CF）：
  - `<title>` 含 `Just a moment` / `Attention Required` / `安全验证`；
  - HTTP 403 / 503；
  - body 含「区域已被拒绝」/「denied」；body 为空壳且 `content-length` 0（502 桩页）。
- 单站抛错不中断整跑：记 `error` + reason，继续下一站。

## 命中解析与书名归一

- 结果容器有配置则用配置选择器；缺省退化为整页扫 `<a>`。
- 命中判定：`<a>` 文本含书名（含繁/简 variant，如 `神女逍遙錄`）或 `href` 含 URL 编码后的关键词；按 href 去重，取前 K（`--limit=`，缺省取全部 ≤10）。
- 归一仅用于判定，不吞原文：全/半角转半角、忽略大小写、括号/副标后缀（如「（绿）」「(h)」「（仙侠NTR）」）不影响精确子串命中；输出保留站点原文 `title`。

## CLI（`search-novel.js`）

```
node search-novel.js <书名> [选项]
  --site=a,b        只搜指定站（逗号分隔）
  --include-all     连 headless:false 的封锁/宕机站也硬试
  --verify          命中后再开详情页确认：作者 / 最新章节 / 目录单页或分页（逐个 detail 页，较慢）
  --limit=K         每站返回前 K 个命中（缺省 ≤10）
  --json            机器可读 JSON（stdout 仅一个 JSON 数组）
  --timeout-ms=N    每站预算 ms（缺省 12000）
```

- 默认逐站输出一行：`[key] hit:N / none / skipped(<reason>) / error(<reason>)`。
- 末尾汇总命中表：`[站名] 书名（作者）→ 详情URL`；同书多版本并排显示供挑选。
- 全 none / 全 skipped 也正常退出（退出码 0）；参数错误退出码 2。

## 错误处理

- 单站失败/skip 均以行内 reason 呈现，绝不影响其它站。
- 有头开关、预算、白名单都透传进库的 `opts`。
- 站点可能在运行期临时恢复/宕机：以「本次实测 + 配置能力标记」双来源判定，动态 skip 不因配置过期而硬等。

## 文档与知识演进

- 根 `README.md`：新增「跨站书名搜索」小节——用法、参数、站点覆盖与封锁清单（注明 2026-09-05 实测）。
- `gaode/lib/site-search.js` 头部注释：如何新增/改一站（复制配置行 + 探测端点）。
- 本设计同步到 `docs/superpowers/specs/`。
- 站点搜索结果解析的细化坑（若遇）回填进 `site-search.js` 配置注释或根 README；**不逐站改 `gaode/<site>/说明文档.md`**，也不改 skill（机制进 README、站细节进配置表，按 `novel-scraper-playbook-evolution` 的判断）。

## 测试（无单测框架，与仓库一致用冒烟）

1. `node search-novel.js 神女逍遥录` → 期望多站 `hit`，输出含 69xku `https://69xku.com/book/21428/` 等已知 URL。
2. `node search-novel.js 神女逍遥录 --site=69xku` → 只搜 69xku。
3. `node search-novel.js 一个必然不存在的书名xyz` → 各站 `none`/`skipped`，退出码 0。
4. `node search-novel.js 神女逍遥录 --json` → stdout 是合法 JSON 数组。
5. 验证有头环境变量 `NOVEL_HEADLESS=0` 不影响流程（可选）。
