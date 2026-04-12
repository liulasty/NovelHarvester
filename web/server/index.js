const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { createTargetsRouter } = require('./routes/targets');
const { createTasksRouter } = require('./routes/tasks');
const { createOutputsRouter } = require('./routes/outputs');
const { TaskManager } = require('./lib/taskManager');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.NOVEL_WEB_PORT || 3001);
const HOST = process.env.NOVEL_WEB_HOST || '127.0.0.1';
const taskManager = new TaskManager({ projectRoot: PROJECT_ROOT });

function shutdown() {
  taskManager.killAllChildren();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const app = express();
app.use(express.json({ limit: '512kb' }));

app.use('/api/targets', createTargetsRouter(PROJECT_ROOT));
app.use('/api/tasks', createTasksRouter(taskManager));
app.use('/api/outputs', createOutputsRouter(PROJECT_ROOT));

const clientDist = path.join(PROJECT_ROOT, 'web', 'client', 'dist');
const hasClientBuild = fs.existsSync(path.join(clientDist, 'index.html'));
if (hasClientBuild) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message || '服务器错误' });
});

const server = http.createServer(app);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(
      `[novel-web] 无法监听 ${HOST}:${PORT}（EADDRINUSE）。常见原因：另一窗口仍在跑 npm run dev:web 或已启动的 node web/server/index.js。\n` +
        `处理：结束占用该端口的进程，或换端口，例如 PowerShell：\n` +
        `  $env:NOVEL_WEB_PORT = \"3002\"; npm run start:web\n` +
        `若用 Vite 开发，请把 web/client/vite.config.js 里 proxy 的 target 改成新端口，或停掉已占用的服务。`
    );
  } else {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Novel web API http://${HOST}:${PORT}`);
});
