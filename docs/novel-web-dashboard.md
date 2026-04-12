# 小说抓取 Web Dashboard — 设计与执行方案

本文档为 **my-pw-project** 本机 Web 控制台的定稿说明：目标、架构、API、安全约束、**界面与信息架构**（对齐根目录原型 **`novel_dashboard_all_pages.html`**）、数据模型与实现顺序。实现时以本文为准；与根目录 `README.md` 中 CLI 说明互补。

---

## 1. 目标与边界

### 1.1 目标

- 在本机通过 **现代 Dashboard**（**React + Vite**）完成：
  - 对 **`novel-targets.json`** 的增删改查（Web 表单写回）；
  - **多目标并发任务**（每目标独立子进程、独立日志流）；
  - **各 `outputDir` 白名单下**产物的列表、文本预览与下载。
- 开发与生产两种运行方式清晰分离（见第 2 节）。
- **视觉与布局**遵循第 8 节，整体接近 **claude.ai** 式扁平控制台，而非「外嵌工具」质感。

### 1.2 边界与非目标

| 项 | 约定 |
|----|------|
| 监听地址 | 默认仅 **`127.0.0.1`**，不对外网暴露控制面 |
| 服务重启 | **不恢复**运行中或排队任务；任务状态仅内存维护 |
| 配置冲突 | **最后写入者覆盖**；UI **常驻提示**：与 CLI 同时编辑同一文件时以后写为准 |
| 配置单一事实源 | 根目录 **`novel-targets.json`**，**CLI 与 Web 共用** |

### 1.3 原型参考

- 静态原型与布局示意：**仓库根目录 [`novel_dashboard_all_pages.html`](../novel_dashboard_all_pages.html)**（四页：Targets / Tasks / Outputs / Edit）。
- 实现时以**本文业务字段与 API**为准；原型中的站点名、示例 URL 等替换为本文第 5、7 节的真实 **`scraper` 集合**与 **`chaptersListUrl` / `urlFile`** 模型。

---

## 2. 运行时架构

### 2.1 开发模式

- **Vite**（前端 dev server，例如 `5173`）：HMR、静态资源。
- **Express**（例如 **`3001`**）：仅提供 **`/api`**。
- **`vite.config.js` 的 `proxy`**：将浏览器对 **`/api`** 的请求代理到 **`http://127.0.0.1:3001`**，避免 CORS，与生产「同域」行为一致。

### 2.2 生产模式

- 执行 **`npm run build`**（Vite），产物输出到固定目录（例如 `web/client/dist`）。
- **Express 同一进程**：`express.static` 挂载构建产物；**API 路径仍为 `/api`**。
- 若使用前端路由且需刷新深链：对非 `/api` 请求 **fallback 到 `index.html`**（按实际路由需求配置）。

### 2.3 子进程模型

- 每个任务：在项目根目录 `cwd` 下 **`spawn(node, [抓取脚本路径, ...argv], { env: process.env })`**。
- 脚本路径与参数规则须与现有 **`novel-workflow.js`** 一致（见第 5 节），避免 Web 与 CLI 行为分叉。

---

## 3. 并发与队列

| 项 | 约定 |
|----|------|
| 并发上限 | 同时处于 **`running`** 的子进程最多 **3** 个 |
| 超额行为 | **FIFO 排队**；有进程结束（正常退出或被停止）后，再启动队列下一任务 |
| API 响应 | `POST /api/tasks/start` 返回 `taskId`、`status: running \| queued`；queued 时可返回队列序号（与 UI「队列等待」区块一致） |

---

## 4. 数据完整性：`novel-targets.json` 写回

### 4.1 流程（原子写）

1. 服务端 **校验** JSON 结构（见第 7 节）。
2. 校验失败 → **400**，**不写盘**。
3. 校验通过 → 写入临时文件（例如 **`novel-targets.json.tmp`**）。
4. 将当前正式文件备份为 **`novel-targets.json.bak`**（写前备份）。
5. **`rename`** 临时文件覆盖正式文件名（同一文件系统上原子替换）。

### 4.2 与 CLI 的关系

- 无乐观锁；**最后写入者覆盖**。
- UI 必须 **固定展示**上述冲突提示。
- Web 新增字段须 **向后兼容**：CLI 与 Node 对 JSON 应 **忽略未知键**；缺省行为与下表一致。

---

## 5. 配置模型（与业务对齐）

### 5.1 单条 `target` 字段（写入 `novel-targets.json`）

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 唯一标识；日志与任务关联；仅建议使用字母数字与 `-` `_` |
| `label` | 是 | 展示名称（Targets 列表主标题） |
| `scraper` | 否 | 站点引擎键，与 **`novel-workflow.js` → `SCRAPER_TO_SCRIPT`** 一致；**缺省为 `book18`** |
| `chaptersListUrl` | 与 `urlFile` 二选一 | 站内涵盖章节目录页 URL |
| `urlFile` | 与 `chaptersListUrl` 二选一 | 项目根下相对路径，如 `chapters_urls.txt`（供 `--file --url-file=`） |
| `outputDir` | 是 | 书籍根目录，如 `novel-output/xnl`（其下含 `chapters/`、`merged/` 等，由各站脚本约定） |
| `mergeTitle` | 否 | 合并抬头；可空字符串 |
| `enabled` | 否 | **Web 与后续 CLI 扩展用**；`false` 时 Dashboard **不展示运行按钮 / 或灰显且不可启动**；**缺省视为 `true`**，保证与现有无该字段的 JSON 文件兼容 |

**不在 JSON 中持久化**：单次运行的 **`limit`（章节上限）**——与当前 `novel-workflow.js` 一致，仅在 **`POST /api/tasks/start`** 的 body 中传入；UI 在 Targets 行「运行」或弹层中填写，留空表示不限制。

### 5.2 `scraper` 下拉选项（替换原型中的虚构站点）

与代码保持一致，至少包含：

`book18`、`shuwen6`、`diyibanzhu`、`nzxs`、`bookszw`、`69xku`、`9ksw`

（若仓库日后增加引擎，同步更新 `SCRAPER_TO_SCRIPT` 与本列表。）

### 5.3 Targets 列表副文案（`target-sub`）

- 展示为：**`{scraper 或 book18} · {id}`**（与原型「bookszw · bz_001」同结构，数据为真实字段）。

### 5.4 编辑表单（Edit）字段分组（结合实际）

- **基础信息**：`label` + `id`（两列网格）；`scraper`（`select`）；**目录来源**：`chaptersListUrl` **或** `urlFile`（二选一：单选切换 + 对应输入框，避免同时填冲突）。
- **运行参数**：`outputDir` + `mergeTitle`（`mergeTitle` 独占一行或置于第二组首行）；**不将章节上限写入 JSON**；可在该组下放 **hint**：试跑章节在启动任务时填写。
- **启用**：`enabled` 开关，与 Targets 列表 toggle 同一语义，文案可与原型一致：「在 Targets 列表中显示并可运行」（`enabled === false` 时仍可在编辑页保存，由产品决定是否完全隐藏行；**推荐**：列表仍显示但不可运行并灰显，以免用户找不到「关掉的」目标）。

---

## 6. 与现有工作流对齐（参数构造）

须与根目录 **`novel-workflow.js`** 中逻辑一致：

- 按 `target.scraper`（缺省 `book18`）映射到 **`SCRAPER_TO_SCRIPT`** 对应脚本；
- 若有 `chaptersListUrl`：作为参数传入；否则 **`--file`** 与 **`--url-file=<target.urlFile>`**；
- 固定追加 **`--out-dir=<target.outputDir>`**、**`--merge`**；
- 若有 **`mergeTitle`** 且非空：追加 **`--merge-title=...`**；
- 试跑章节：body 中 **`limit`** 为正整数时，作为脚本**末尾数字参数**传入，否则不传。

建议将「根据 target + limit 拼 argv」抽为 **`web/server/lib/runTarget.js`**，供 `tasks` 路由引用；长期可再抽到根 `lib/` 与 `novel-workflow.js` 共用。

---

## 7. API 设计概要

### 7.1 Targets（`routes/targets.js`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/targets` | 读取当前 `novel-targets.json` |
| POST | `/api/targets` | 新增一条 target |
| PUT | `/api/targets/:id` | 按 `id` 更新一条 |
| PATCH | `/api/targets/:id` | **可选**：仅更新 `enabled` 等单字段，减少竞态（仍走原子写整文件） |
| DELETE | `/api/targets/:id` | 按 `id` 删除一条 |

写操作均走第 4 节原子写与第 5 节校验。

### 7.2 Tasks（`routes/tasks.js`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tasks/start` | Body：`targetId`、可选 `limit`；若 `enabled === false` 则 **409** 或 **400**；返回 `taskId`、`status` |
| GET | `/api/tasks` | 列出内存任务：`id、targetId、status、startedAt、exitCode、limit` 等，供 Targets / Tasks 页徽章与分区 |
| POST | `/api/tasks/:id/stop` | 停止子进程；SSE 推送 **`killed`** 后结束日志流 |
| GET | `/api/tasks/:id/log` | **SSE**：该任务独立日志流 |

**任务 ID**：**`crypto.randomUUID()`**。

**SSE 约定**：

- `Content-Type: text/event-stream`，`Cache-Control: no-cache`，`Connection: keep-alive`；
- 日志：`data: JSON`（例如 `{ "type": "line", "text": "..." }`）；
- 正常结束：`type: exit`，带退出码；
- 被停止：`type: killed`；
- **心跳**：周期性 **SSE 注释行**（`:` 开头）；
- **客户端断开**：服务端 **移除订阅**，防止泄漏。

### 7.3 Outputs（`routes/outputs.js`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/outputs/...` | 按白名单列目录、预览文本片段、下载文件（路径设计在实现中定稿，须满足第 9 节） |

**Outputs 页 UX**：先选择 **`outputDir`（白名单之一）** 再列该目录下文件（或顶层展示各 `outputDir` 入口再下钻），以支持多本书输出树；原型中单列表可用「当前选中目录」状态补齐。

---

## 8. 界面与视觉规范（定稿）

### 8.1 整体风格

- **扁平化**：无渐变、无阴影、无装饰性模糊或玻璃拟态。
- **颜色**：全部使用 **语义化 CSS 变量**（如 `--color-background-primary`、`--color-text-secondary`、`--color-border-tertiary` 等），**自动适配亮色 / 暗色**（`prefers-color-scheme` 或根类名切换）。
- **层级**：靠 **边框粗细（主要为 0.5px）**、**背景色阶**（primary / secondary / tertiary）、**字重 400 / 500** 区分；不用阴影或色块堆叠制造层次。
- **气质**：克制、偏「原生控制台」，与 **claude.ai** 式界面接近。

### 8.2 布局结构

- **两栏固定布局**：左侧 **`200px`** 侧边栏，右侧主内容区 **flex 填充**。
- **分隔**：侧栏与主区之间 **`0.5px`** 细线；整体外围 **`0.5px` 边框 + 圆角** 包裹，形成独立 **dashboard 容器**（对应原型 `.layout`）。

### 8.3 侧边栏

- 背景使用 **`background-secondary`**（比主区深一级）。
- 顶部品牌：**小号、全大写** **`NOVEL SCRAPER`**（与原型 `Novel Scraper` 一致即可）。
- **三个导航项**，各配 **`8×8px` 色块**（小圆角方块即可）：
  - **Targets**：紫色（配置）；
  - **Tasks**：青绿色（运行）；
  - **Outputs**：珊瑚橙（产物）。
- **激活项**：背景切回主表面色、字重 **500**；右侧 **`2px` 紫色竖线** 为激活指示——**全界面唯一允许使用 `2px` 边框的一处**（与原型一致）。

### 8.4 Topbar（每页）

- **固定高度**顶栏：左侧 **页面标题**（15px / 500）；右侧 **操作按钮 + 状态徽章**。
- **Edit 页**：左侧为 **「← 返回 Targets」** 链接样式；右侧 **取消**（默认轮廓按钮）+ **保存**（**绿色边框** `btn-save`，与原型一致）。
- **Tasks 页**：右侧可展示 **running / queued 数量徽章** 与文案 **「并发上限 3」**（弱提示色）。

### 8.5 按钮系统

- 统一：**透明底 + `0.5px` 边框**；**hover** 时填充浅背景。
- 语义变体：
  - **默认灰轮廓**：编辑、取消等中性操作；
  - **紫边框**：新增目标等主要操作（`btn-primary`）；
  - **绿边框**：运行、下载、保存等正向操作（`btn-run` / `btn-save`）；
  - **红边框**：停止等危险操作（`btn-danger`）。
- **不使用实心填充按钮**，保持轻盈。

### 8.6 状态徽章

- 小号 **圆角胶囊**：用于全局或卡片头状态。
- **语义**（浅底深字、同色系边框，保证对比度）：
  - **running**：绿底绿字；
  - **queued**：黄底橙字；
  - **done**：灰底灰字；
  - **error / killed**：红底红字。

### 8.7 字体层级

| 用途 | 规格 |
|------|------|
| 页面标题（Topbar） | **15px / 500** |
| Section 标签 | **11px / 500**、全大写 |
| 正文与列表主文 | **13px / 400** |
| 副文案、hint | **11px / 400** |
| 表单 Label | **14px / 500**（两行结构中第一行） |
| 日志与预览 | **等宽 11px / 400** |
| 字重 | **仅用 400 与 500**，不用 600/700 |

### 8.8 各页与组件映射（React）

在原型结构基础上按业务拆分，建议组件：

| 组件 | 职责 |
|------|------|
| `Layout.jsx` | 外层圆角容器、双栏、`Sidebar` |
| `Sidebar.jsx` | 品牌、导航、激活态、`8×8` 色块 |
| `TopBar.jsx` | 标题 / 返回 / 右侧槽位 |
| `Badge.jsx` | running / queued / done / error |
| `Button.jsx` | default / primary / run / danger / save |
| `TargetList.jsx` | 目标卡片行：名称+副文案、**enabled** toggle、编辑、运行（`limit` 弹层或二级确认） |
| `TargetAddRow.jsx` | 底部虚线 **「+ 添加目标」** |
| `RunningLogsSection.jsx` | Targets 页下部：紧凑日志卡、**状态色点**、截断、停止 |
| `TasksPage.jsx` | 三区：**运行中**（高日志区）、**队列等待**（序号圆）、**历史**（仅头部 + 徽章） |
| `OutputList.jsx` | 选择 `outputDir`、文件卡片行、预览展开区 |
| `TargetEditForm.jsx` | 最大宽 **560px**、分组与 **`0.5px` 分隔线**、enabled 与列表 toggle 一致 |
| `LogViewer.jsx` | 封装 SSE 与行渲染（Tasks 高卡 + Targets 矮卡复用） |

**Targets 页**：上半 **目标列表**；下半 **运行中任务日志**（与原型一致；数据来自 `GET /api/tasks` 中 `running` + 各任务 SSE 末行摘要或完整订阅按性能定稿）。

**Tasks 页**：运行中卡片 **更高**（更多日志行）；队列行 **序号圆圈**；历史 **不展开日志**。

**Outputs 页**：每行文件名、大小、时间；**预览** 在列表下方 **展开** 预览框，背景 **secondary**，等宽字。

**Edit 页**：表单 **max-width: 560px**；字段 **14px label + 控件** 两行结构；需要处 **11px hint**；**名称/id** 与 **outputDir / mergeTitle 组内两列** 按第 5.4 节；**中间 `0.5px` 水平线** 分隔基础信息与运行参数组；**focus**：输入框 **紫色边框 + 浅紫 `box-shadow` 光晕**——**全界面唯一允许的 `box-shadow`**，仅作焦点可达性。

---

## 9. 路径安全（Outputs）

- 任何用户传入相对路径：先 **`path.normalize`**，再 `path.resolve` 到项目根。
- **允许访问的根目录** = 当前 **`novel-targets.json` 中所有 `target.outputDir`** 的解析结果集合（**仅 `enabled !== false` 的项是否参与白名单** 可由实现二选一：建议 **全部 targets 的 outputDir 均可列**，避免禁用目标后无法取历史文件）。
- **禁止**：`..` 逃出白名单根、任意非白名单绝对路径、符号链接逃逸。
- **预览**：文本限制最大字节（例如首 **512KB**）；二进制 **415** 或不预览。
- **下载**：`Content-Disposition: attachment`，同样经白名单校验。

---

## 10. 前端工程与目录

### 10.1 `web/client/`

- `vite.config.js`：`proxy: { '/api': 'http://127.0.0.1:3001' }`。
- **样式**：全局 CSS 变量定义于 `src/index.css`（或 `theme.css`），暗色用 `[data-theme="dark"]` 或媒体查询切换。
- **路由**：可用 **React Router** 或轻量状态切换四视图（`/targets`、`/tasks`、`/outputs`、`/targets/:id/edit`）；需与 Topbar「返回」一致。

### 10.2 `web/server/`

```
web/
├── server/
│   ├── index.js
│   └── routes/
│       ├── targets.js
│       ├── tasks.js
│       └── outputs.js
└── client/
    ├── index.html
    ├── vite.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── index.css          # 语义变量 + 全局扁平规则
        └── components/
            ├── Layout.jsx
            ├── Sidebar.jsx
            ├── TopBar.jsx
            ├── Badge.jsx
            ├── Button.jsx
            ├── TargetList.jsx
            ├── TargetAddRow.jsx
            ├── TargetEditForm.jsx
            ├── RunningLogsSection.jsx
            ├── TasksPage.jsx
            ├── OutputList.jsx
            └── LogViewer.jsx
```

可选：`web/server/lib/runTarget.js`。

---

## 11. 数据流（任务与 SSE）

```
浏览器                          server (Express)              子进程 (node 抓取脚本)
  │                                    │                            │
  ├─ POST /api/tasks/start ───────────►│ spawn（或入队）            │
  │◄── { taskId, status } ─────────────│                            │
  │                                    ├──────────────────────────►│
  ├─ GET /api/tasks/:id/log (SSE) ────►│                            │
  │◄── data: { type: line, ... } ──────│◄── stdout/stderr ──────────│
  │◄── data: { type: exit, code } ─────│◄── close ──────────────────│
  ├─ POST /api/tasks/:id/stop ────────►│ kill                       │
  │◄── data: { type: killed } ─────────│                            │
```

---

## 12. `package.json` 脚本（建议）

| 脚本 | 语义 |
|------|------|
| `dev:web` | 并行启动 Express 与 Vite，或使用 `concurrently` |
| `build:web` | 构建 `web/client` |
| `start:web` | 生产：Node 启动 `web/server/index.js` |

---

## 13. 实现顺序（降低返工）

1. **主题与壳层**：CSS 变量（亮/暗）+ **Layout / Sidebar / TopBar**（无业务数据即可对齐视觉定稿）。
2. Express：**127.0.0.1**、**GET `/api/targets`**。
3. **Targets 写回**：校验 + 临时文件 + `.bak` + `rename`（含 `enabled`、二选一 URL 校验）。
4. **Tasks**：`spawn` + **SSE** + **stop** + 断开清理。
5. **并发 3 + FIFO 队列**；**GET `/api/tasks`** 支撑徽章与三分区。
6. **Outputs**：白名单 + 目录选择 + 列表/预览/下载。
7. **React 页面串联**：Targets（含下半日志）、Tasks、Outputs、Edit；与原型逐屏对照验收。

---

## 14. 进程退出与运维

- 处理 **`SIGINT` / `SIGTERM`**：结束子进程，减少孤儿 Chromium。
- **Playwright**：与根项目依赖一致；文档注明需已安装浏览器。

---

## 15. CLI 同步（建议，独立小步提交）

- **`novel-workflow.js`**：读取 targets 时 **跳过 `enabled === false`**（若实现「列表里仍显示但不可跑」，仅 Web 拦截即可，CLI 仍可手动指定 id 运行——产品若要求 CLI 也尊重 `enabled`，则在此处过滤）。
- **交互列表**：打印时可标注 `(disabled)` 或直接隐藏，与 README 一句说明即可。

---

## 16. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-04-12 | 初稿（执行约束）；同日修订：对齐原型 [`novel_dashboard_all_pages.html`](../novel_dashboard_all_pages.html)，补充 UI/UX 定稿、`enabled` 与真实 `scraper` 列表、`limit` 仅启动参数、Outputs 目录选择、组件拆分与实现顺序 |

---

*本文档路径：`docs/novel-web-dashboard.md`*
