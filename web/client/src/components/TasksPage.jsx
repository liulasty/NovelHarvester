import { useEffect, useState } from 'react';
import TopBar from './TopBar.jsx';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import LogViewer from './LogViewer.jsx';
import { apiJson } from '../api.js';

function fmtDur(ms) {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState([]);

  async function refresh() {
    const data = await apiJson('/api/tasks');
    setTasks(data.tasks || []);
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, []);

  const running = tasks.filter((t) => t.status === 'running');
  const queued = tasks.filter((t) => t.status === 'queued');
  const history = tasks.filter((t) => t.status === 'done' || t.status === 'error' || t.status === 'killed');

  async function stop(taskId) {
    try {
      await apiJson(`/api/tasks/${encodeURIComponent(taskId)}/stop`, { method: 'POST' });
      refresh();
    } catch (e) {
      window.alert(e.message);
    }
  }

  return (
    <>
      <TopBar
        title="Tasks"
        right={
          <>
            <Badge variant="running">{`${running.length} running`}</Badge>
            <Badge variant="queued">{`${queued.length} queued`}</Badge>
            <span className="muted-hint">并发上限 3</span>
          </>
        }
      />
      <div className="content">
        <div>
          <div className="section-label">运行中</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {running.length === 0 && <div className="muted-hint">无</div>}
            {running.map((t) => (
              <div key={t.id} className="task-full">
                <div className="task-full-head">
                  <div className="task-dot r" />
                  <span className="task-name">{t.targetLabel || t.targetId}</span>
                  <span className="task-meta" style={{ marginRight: 8 }}>
                    {t.limit ? `章节上限 ${t.limit}` : '无限章节'}
                    {t.startedAt ? ` · ${fmtDur(Date.now() - t.startedAt)}` : ''}
                  </span>
                  <Badge variant="running">running</Badge>
                  <Button variant="danger" onClick={() => stop(t.id)}>
                    停止
                  </Button>
                </div>
                <LogViewer taskId={t.id} variant="tall" />
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="section-label">队列等待</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {queued.length === 0 && <div className="muted-hint">无</div>}
            {queued
              .slice()
              .sort((a, b) => (a.queuePosition || 0) - (b.queuePosition || 0))
              .map((t) => (
                <div key={t.id} className="queue-item">
                  <div className="queue-num">{t.queuePosition ?? '—'}</div>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--color-text-primary)' }}>
                    {t.targetLabel || t.targetId}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>等待空位</span>
                  <Badge variant="queued">queued</Badge>
                  <Button variant="danger" onClick={() => stop(t.id)}>
                    取消
                  </Button>
                </div>
              ))}
          </div>
        </div>

        <div>
          <div className="section-label">历史记录</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {history.length === 0 && <div className="muted-hint">无</div>}
            {history.map((t) => {
              const done = t.status === 'done';
              const killed = t.status === 'killed';
              const err = t.status === 'error';
              const dur =
                t.startedAt && t.finishedAt ? fmtDur(t.finishedAt - t.startedAt) : '—';
              return (
                <div key={t.id} className="task-full">
                  <div className="task-full-head">
                    <div className={`task-dot ${done ? 'd' : killed || err ? 'e' : 'd'}`} />
                    <span className="task-name">{t.targetLabel || t.targetId}</span>
                    <span className="task-meta" style={{ marginRight: 8 }}>
                      {t.limit ? `${t.limit} 章 · ` : ''}
                      {dur}
                    </span>
                    <Badge variant={done ? 'done' : 'error'}>{t.status}</Badge>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
