# 架构

## 技术栈

- **运行时**：Node.js
- **自动化**：Playwright（浏览器爬虫）
- **前端**：React 19 + Vite 6 + React Router 7
- **服务**：Express
- **工具**：concurrently

## 模块划分

| 模块 | 路径 | 职责 |
|------|------|------|
| 站点适配器 | `gaode/` | 各小说站点的适配器（book18, diyibanzhu, nzxs, shuwen6, bookszw, 69xku, 9ksw, kateman），含共享 helper |
| 编排器 | `lib/orchestrator/` | registry（站点注册）、targets（目标管理）、plan（执行计划） |
| 主流程 | `novel-workflow.js` | CLI 编排入口：发现 → 下载 → 合并，支持交互式/按 ID 执行 |
| 章节合并 | `merge-novel.js` | 章节拼接，CLI + require 两种调用方式 |
| 章节下载 | `download.js` | book18 兼容 shim |
| Web 仪表板 | `web/` | Express 服务 + Vite/React 前端界面 |
| Web 服务 | `serve-novel.js` / `srv.js` / `srv.py` | 遗留 HTTP 服务（多版本） |

## 数据流

```
站点适配器发现章节 → novel-workflow.js 编排下载 → merge-novel.js 合并 → Web 仪表板展示
```
