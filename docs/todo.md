# 待办事项

## review-by-claude.md 提取
- [x] 统一站点适配器接口，减少重复代码
      `gaode/lib/scraper-common.js` 抽共享函数（sanitizeFilePart / chapterNumberFromTitle /
      titleLooksLikeChapterHeading / mergeChapterLists / isTransientNavError / stripAdLines /
      isLeadingNoiseLine / stripLeadingNoise / extractFlags / useHeadedLaunch / URL-file 三件套 /
      parsePageFraction / chunkImpliesMorePages / appendFailureLog），12 站已全部迁移，净减约 850 行。
      站点特有逻辑（parseEntryUrl、等待循环、选择器、xncwxw/chengzixs stripAdLines、9ksw 保序合并）仍留各站。
- [x] 错误处理标准化（重试、日志、告警）— 各站有 failure jsonl / 章节级 try-catch；shuwen6 支持 --retry-failed
- [x] 配置文件外提（去除硬编码 URL）— novel-targets.json
- [x] 下载进度持久化，支持断点续传 — chapters_manifest.json + 已存在章节跳过
- [x] 清理遗留服务版本（serve-novel.js / srv.js / srv.py 三选一）— 文件已删除
- [x] 合并流程增加章节完整性校验 — merge-novel.js 全书级数据清洗
- [x] Web 仪表板增加任务队列可视化管理 — TaskManager + /api/tasks（并发 3 / FIFO / SSE）
- [x] 添加 playwright 浏览器资源回收机制 — 12/12 scraper 均 browser.close()
