const express = require('express');

/**
 * @param {import('../lib/taskManager').TaskManager} taskManager
 */
function createTasksRouter(taskManager) {
  const r = express.Router();

  r.get('/', (_req, res) => {
    res.json({ tasks: taskManager.listTasks() });
  });

  r.post('/start', (req, res) => {
    try {
      const { targetId, limit } = req.body || {};
      if (!targetId || typeof targetId !== 'string') {
        return res.status(400).json({ error: '须提供 targetId' });
      }
      const result = taskManager.startTask(targetId, limit);
      res.status(201).json(result);
    } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
      if (e.code === 'DISABLED') return res.status(409).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/stop', (req, res) => {
    try {
      taskManager.stopTask(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
      if (e.code === 'BAD_STATE') return res.status(400).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/:id/log', (req, res) => {
    const task = taskManager.subscribeLog(req.params.id, res);
    if (!task && !res.headersSent) {
      res.status(404).json({ error: '未知任务' });
    }
  });

  return r;
}

module.exports = { createTasksRouter };
