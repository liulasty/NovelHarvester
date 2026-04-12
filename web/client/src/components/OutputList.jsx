import { useEffect, useMemo, useState } from 'react';
import Button from './Button.jsx';
import { apiJson } from '../api.js';

function fmtSize(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return d.toLocaleString();
}

export default function OutputList() {
  const [roots, setRoots] = useState([]);
  const [root, setRoot] = useState('');
  const [innerPath, setInnerPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [previewPath, setPreviewPath] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [previewErr, setPreviewErr] = useState('');

  useEffect(() => {
    (async () => {
      const data = await apiJson('/api/outputs/roots');
      setRoots(data.roots || []);
      if (!root && data.roots && data.roots[0]) setRoot(data.roots[0].outputDir);
    })().catch(() => {});
  }, []);

  async function loadList() {
    if (!root) return;
    const q = new URLSearchParams({ root });
    if (innerPath) q.set('path', innerPath);
    const data = await apiJson(`/api/outputs/list?${q.toString()}`);
    setEntries(data.entries || []);
  }

  useEffect(() => {
    loadList().catch(() => setEntries([]));
  }, [root, innerPath]);

  const crumbs = useMemo(() => {
    const parts = innerPath ? innerPath.split('/').filter(Boolean) : [];
    return parts;
  }, [innerPath]);

  async function openPreview(relPath) {
    setPreviewPath(relPath);
    setPreviewErr('');
    setPreviewText('');
    const q = new URLSearchParams({ root, path: relPath });
    try {
      const res = await fetch(`/api/outputs/preview?${q.toString()}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setPreviewErr(j.error || res.statusText);
        return;
      }
      setPreviewText(await res.text());
    } catch (e) {
      setPreviewErr(e.message);
    }
  }

  return (
    <>
      <div className="section-label">输出目录</div>
      <div className="field-group" style={{ maxWidth: 560 }}>
        <select value={root} onChange={(e) => { setRoot(e.target.value); setInnerPath(''); setPreviewPath(''); }}>
          {roots.map((r) => (
            <option key={r.outputDir} value={r.outputDir}>
              {r.label} — {r.outputDir}
            </option>
          ))}
        </select>
        <div className="field-hint">白名单来自 novel-targets.json 中全部目标的 outputDir。</div>
      </div>

      <div className="section-label" style={{ marginTop: 8 }}>
        路径
      </div>
      <div className="muted-hint" style={{ marginBottom: 6 }}>
        <button type="button" className="topbar-back" onClick={() => setInnerPath('')}>
          根目录
        </button>
        {crumbs.map((p, i) => {
          const prefix = crumbs.slice(0, i + 1).join('/');
          return (
            <span key={prefix}>
              {' / '}
              <button type="button" className="topbar-back" onClick={() => setInnerPath(prefix)}>
                {p}
              </button>
            </span>
          );
        })}
      </div>

      <div className="section-label">文件</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {entries.map((e) => (
          <div key={e.path} className="output-row">
            <div>
              <div className="output-name">{e.name}</div>
              <div className="output-meta">
                {e.isDirectory ? '目录' : fmtSize(e.size)} · {fmtTime(e.mtimeMs)}
              </div>
            </div>
            {e.isDirectory ? (
              <Button
                onClick={() => {
                  setInnerPath(e.path);
                  setPreviewPath('');
                }}
              >
                打开
              </Button>
            ) : (
              <Button onClick={() => openPreview(e.path)}>预览</Button>
            )}
            {!e.isDirectory && (
              <Button
                variant="run"
                onClick={() => {
                  const q = new URLSearchParams({ root, path: e.path });
                  window.open(`/api/outputs/download?${q.toString()}`, '_blank');
                }}
              >
                下载
              </Button>
            )}
          </div>
        ))}
        {entries.length === 0 && <div className="muted-hint">此目录为空或不存在。</div>}
      </div>

      {previewPath && (
        <div>
          <div className="section-label">预览：{previewPath}</div>
          {previewErr ? (
            <div className="muted-hint">{previewErr}</div>
          ) : (
            <div className="preview-box">{previewText}</div>
          )}
        </div>
      )}
    </>
  );
}
