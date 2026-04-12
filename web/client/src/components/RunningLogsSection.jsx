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

export default function RunningLogsSection({ tasks, onRefresh }) {
  const running = tasks.filter((t) => t.status === 'running');

  async function stop(id) {
    try {
      await apiJson(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST' });
      onRefresh();
    } catch (e) {
      window.alert(e.message);
    }
  }

  if (running.length === 0) {
    return (
      <div>
        <div className="section-label">运行中日志</div>
        <div className="muted-hint">当前没有运行中的任务。</div>
      </div>
    );
  }

  return (
    <div>
      <div className="section-label">运行中日志</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {running.map((t) => (
          <div key={t.id} className="task-card">
            <div className="task-head">
              <div className="task-dot r" />
              <span className="task-name">{t.targetLabel || t.targetId}</span>
              <span className="task-meta">
                {t.limit ? `章节上限 ${t.limit}` : '无限章节'}
                {t.startedAt ? ` · ${fmtDur(Date.now() - t.startedAt)}` : ''}
              </span>
              <Button variant="danger" style={{ marginLeft: 8 }} onClick={() => stop(t.id)}>
                停止
              </Button>
            </div>
            <LogViewer taskId={t.id} variant="short" />
          </div>
        ))}
      </div>
    </div>
  );
}
