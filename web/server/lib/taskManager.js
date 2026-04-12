const { spawn } = require('child_process');
const crypto = require('crypto');
const { buildSpawnArgs } = require('./runTarget');
const { readConfig, findTargetIndex, normalizeEnabled } = require('./targetsStore');

const MAX_CONCURRENT = 3;
const HEARTBEAT_MS = 15000;
const LOG_TAIL = 200;

/** @typedef {'queued'|'running'|'done'|'error'|'killed'} TaskStatus */

class TaskManager {
  /**
   * @param {object} opts
   * @param {string} opts.projectRoot
   */
  constructor(opts) {
    this.projectRoot = opts.projectRoot;
    /** @type {Map<string, object>} */
    this.tasks = new Map();
    /** @type {string[]} */
    this.queue = [];
    this.runningCount = 0;
    this.heartbeatTimer = setInterval(() => this._pingAll(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  _pingAll() {
    for (const t of this.tasks.values()) {
      for (const res of t.subscribers) {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch (_) {}
      }
    }
  }

  _labelForTargetId(targetId) {
    try {
      const { targets } = readConfig(this.projectRoot);
      const i = findTargetIndex(targets, targetId);
      if (i < 0) return targetId;
      return targets[i].label || targetId;
    } catch {
      return targetId;
    }
  }

  _broadcast(task, obj) {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of task.subscribers) {
      try {
        res.write(line);
      } catch (_) {}
    }
  }

  _appendLine(task, text, stream) {
    task.lastLines.push({ text, stream, t: Date.now() });
    if (task.lastLines.length > LOG_TAIL) task.lastLines.splice(0, task.lastLines.length - LOG_TAIL);
    this._broadcast(task, { type: 'line', text, stream: stream || 'stdout' });
  }

  _finishTask(task, status, exitCode) {
    if (task.status === 'running') this.runningCount = Math.max(0, this.runningCount - 1);
    task.status = status;
    task.finishedAt = Date.now();
    if (typeof exitCode === 'number') task.exitCode = exitCode;
    if (task.proc) {
      task.proc.removeAllListeners();
      task.proc = null;
    }
    this._drainQueue();
  }

  _drainQueue() {
    while (this.runningCount < MAX_CONCURRENT && this.queue.length > 0) {
      const id = this.queue.shift();
      const task = this.tasks.get(id);
      if (!task || task.status !== 'queued') continue;
      this._startProcess(task);
    }
  }

  _startProcess(task) {
    let scriptArgs;
    try {
      scriptArgs = buildSpawnArgs(this.projectRoot, task.target, task.limit);
    } catch (e) {
      task.status = 'error';
      task.finishedAt = Date.now();
      task.errorMessage = e.message;
      this._broadcast(task, { type: 'line', text: e.message, stream: 'stderr' });
      this._broadcast(task, { type: 'exit', code: 1, error: true });
      this._drainQueue();
      return;
    }

    task.status = 'running';
    task.startedAt = Date.now();
    this.runningCount += 1;

    const proc = spawn(process.execPath, scriptArgs.argv, {
      cwd: this.projectRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    task.proc = proc;

    proc.stdout.on('data', (buf) => {
      const s = buf.toString();
      for (const line of s.split(/\r?\n/)) {
        if (line) this._appendLine(task, line, 'stdout');
      }
    });
    proc.stderr.on('data', (buf) => {
      const s = buf.toString();
      for (const line of s.split(/\r?\n/)) {
        if (line) this._appendLine(task, line, 'stderr');
      }
    });
    proc.on('close', (code) => {
      if (task.killed) {
        this._finishTask(task, 'killed', code == null ? 1 : code);
        this._broadcast(task, { type: 'killed' });
      } else {
        const ok = code === 0;
        this._finishTask(task, ok ? 'done' : 'error', code == null ? 1 : code);
        this._broadcast(task, { type: 'exit', code: code == null ? 1 : code });
      }
      for (const res of task.subscribers) {
        try {
          res.end();
        } catch (_) {}
      }
      task.subscribers.clear();
    });
  }

  /**
   * @param {string} targetId
   * @param {string|number|undefined} limit
   */
  startTask(targetId, limit) {
    const { targets } = readConfig(this.projectRoot);
    const idx = findTargetIndex(targets, targetId);
    if (idx < 0) {
      const e = new Error('未知 targetId');
      e.code = 'NOT_FOUND';
      throw e;
    }
    const target = targets[idx];
    if (!normalizeEnabled(target)) {
      const e = new Error('目标已禁用，无法启动');
      e.code = 'DISABLED';
      throw e;
    }

    const id = crypto.randomUUID();
    const task = {
      id,
      createdAt: Date.now(),
      targetId: target.id,
      targetLabel: target.label,
      status: /** @type {TaskStatus} */ ('queued'),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      limit: limit != null && limit !== '' ? Number(limit) : null,
      target,
      proc: null,
      subscribers: new Set(),
      lastLines: [],
      killed: false,
      errorMessage: null,
    };
    this.tasks.set(id, task);

    if (this.runningCount < MAX_CONCURRENT) {
      this._startProcess(task);
    } else {
      this.queue.push(id);
    }

    const queuePosition = task.status === 'queued' ? this.queue.indexOf(id) + 1 : null;
    return {
      taskId: id,
      status: task.status,
      queuePosition,
    };
  }

  stopTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      const e = new Error('未知任务');
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (task.status === 'queued') {
      const qi = this.queue.indexOf(taskId);
      if (qi >= 0) this.queue.splice(qi, 1);
      task.killed = true;
      task.status = 'killed';
      task.finishedAt = Date.now();
      this._broadcast(task, { type: 'killed' });
      return;
    }
    if (task.status !== 'running' || !task.proc) {
      const e = new Error('任务未在运行');
      e.code = 'BAD_STATE';
      throw e;
    }
    task.killed = true;
    try {
      task.proc.kill('SIGTERM');
    } catch (_) {}
  }

  subscribeLog(taskId, res) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();

    task.subscribers.add(res);
    for (const row of task.lastLines) {
      res.write(`data: ${JSON.stringify({ type: 'line', text: row.text, stream: row.stream })}\n\n`);
    }
    if (task.status === 'done' || task.status === 'error' || task.status === 'killed') {
      if (task.status === 'killed') res.write(`data: ${JSON.stringify({ type: 'killed' })}\n\n`);
      else res.write(`data: ${JSON.stringify({ type: 'exit', code: task.exitCode ?? 1 })}\n\n`);
      res.end();
      task.subscribers.delete(res);
      return task;
    }

    const onClose = () => {
      task.subscribers.delete(res);
      res.removeListener('close', onClose);
    };
    res.on('close', onClose);
    return task;
  }

  listTasks() {
    const out = [];
    for (const t of this.tasks.values()) {
      let queuePosition = null;
      if (t.status === 'queued') {
        const i = this.queue.indexOf(t.id);
        queuePosition = i >= 0 ? i + 1 : null;
      }
      out.push({
        id: t.id,
        createdAt: t.createdAt,
        targetId: t.targetId,
        targetLabel: t.targetLabel || this._labelForTargetId(t.targetId),
        status: t.status,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        exitCode: t.exitCode,
        limit: t.limit,
        queuePosition,
        lastLines: t.lastLines.slice(-8),
      });
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  killAllChildren() {
    for (const t of this.tasks.values()) {
      if (t.proc) {
        try {
          t.proc.kill('SIGTERM');
        } catch (_) {}
      }
    }
  }
}

module.exports = { TaskManager, MAX_CONCURRENT };
