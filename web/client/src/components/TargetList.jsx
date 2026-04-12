import { useNavigate } from 'react-router-dom';
import Button from './Button.jsx';
import { apiJson } from '../api.js';

function subline(t) {
  const eng = (t.scraper && String(t.scraper).trim()) || 'book18';
  return `${eng} · ${t.id}`;
}

function enabledOf(t) {
  return t.enabled !== false;
}

export default function TargetList({ targets, onTargetsChanged, onTaskStarted }) {
  const nav = useNavigate();

  async function toggleEnabled(t) {
    const next = !enabledOf(t);
    await apiJson(`/api/targets/${encodeURIComponent(t.id)}`, {
      method: 'PATCH',
      body: { enabled: next },
    });
    onTargetsChanged();
  }

  async function run(t) {
    if (!enabledOf(t)) return;
    const raw = window.prompt('试跑章节上限（留空表示不限制，仅本次运行）:', '');
    if (raw === null) return;
    const limit = String(raw).trim() === '' ? undefined : raw;
    try {
      await apiJson('/api/tasks/start', { method: 'POST', body: { targetId: t.id, limit } });
      onTaskStarted?.();
    } catch (e) {
      window.alert(e.message);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {targets.map((t) => (
        <div key={t.id} className={`target-row${enabledOf(t) ? '' : ' disabled'}`}>
          <div>
            <div className="target-name">{t.label}</div>
            <div className="target-sub">{subline(t)}</div>
          </div>
          <button
            type="button"
            className={`toggle${enabledOf(t) ? '' : ' off'}`}
            title="启用 / 禁用"
            onClick={() => toggleEnabled(t)}
          />
          <Button onClick={() => nav(`/targets/${encodeURIComponent(t.id)}/edit`)}>编辑</Button>
          <Button variant="run" disabled={!enabledOf(t)} onClick={() => run(t)}>
            运行
          </Button>
        </div>
      ))}
    </div>
  );
}
