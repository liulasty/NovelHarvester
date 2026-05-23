import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_SCRAPERS, fetchScrapers } from '../scrapers.js';
import { apiJson } from '../api.js';

function enabledOf(t) {
  if (!t) return true;
  return t.enabled !== false;
}

/**
 * @param {{ initial: object | null; isNew: boolean; onSaved: () => void }} props
 */
export default function TargetEditForm({ initial, isNew, onSaved }) {
  const [label, setLabel] = useState(initial?.label || '');
  const [id, setId] = useState(initial?.id || '');
  const [scraper, setScraper] = useState((initial?.scraper && String(initial.scraper)) || 'book18');
  const [source, setSource] = useState(initial?.urlFile ? 'file' : 'url');
  const [chaptersListUrl, setChaptersListUrl] = useState(initial?.chaptersListUrl || '');
  const [urlFile, setUrlFile] = useState(initial?.urlFile || '');
  const [outputDir, setOutputDir] = useState(initial?.outputDir || '');
  const [mergeTitle, setMergeTitle] = useState(initial?.mergeTitle ?? '');
  const [enabled, setEnabled] = useState(enabledOf(initial));
  const [err, setErr] = useState('');
  const [scrapers, setScrapers] = useState(DEFAULT_SCRAPERS);

  useEffect(() => {
    let cancelled = false;
    fetchScrapers()
      .then((s) => {
        if (!cancelled && Array.isArray(s) && s.length > 0) setScrapers(s);
      })
      .catch(() => {
        // ignore; keep fallback list
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const payload = useMemo(() => {
    const body = {
      id: id.trim(),
      label: label.trim(),
      scraper: scraper || 'book18',
      outputDir: outputDir.trim(),
      mergeTitle: mergeTitle.trim(),
      enabled,
    };
    if (source === 'url') body.chaptersListUrl = chaptersListUrl.trim();
    else body.urlFile = urlFile.trim();
    return body;
  }, [id, label, scraper, outputDir, mergeTitle, enabled, source, chaptersListUrl, urlFile]);

  async function onSubmit(ev) {
    ev.preventDefault();
    setErr('');
    try {
      if (isNew) {
        await apiJson('/api/targets', { method: 'POST', body: payload });
      } else {
        await apiJson(`/api/targets/${encodeURIComponent(initial.id)}`, { method: 'PUT', body: payload });
      }
      onSaved();
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <form id="edit-target-form" onSubmit={onSubmit} className="content" style={{ paddingTop: 0 }}>
      {err && <div className="muted-hint" style={{ color: '#a32d2d' }}>{err}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
        <div className="form-grid">
          <div className="field-group">
            <div className="field-label">目标名称</div>
            <input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </div>
          <div className="field-group">
            <div className="field-label">ID</div>
            <input value={id} onChange={(e) => setId(e.target.value)} required disabled={!isNew} />
            <div className="field-hint">用于文件命名和日志标识；创建后不可修改。</div>
          </div>
        </div>

        <div className="field-group">
          <div className="field-label">站点 / 脚本</div>
          <select value={scraper} onChange={(e) => setScraper(e.target.value)}>
            {scrapers.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="field-group">
          <div className="field-label">目录来源</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input type="radio" name="src" checked={source === 'url'} onChange={() => setSource('url')} />
              章节目录 URL
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input type="radio" name="src" checked={source === 'file'} onChange={() => setSource('file')} />
              本地 url 列表文件
            </label>
          </div>
        </div>

        {source === 'url' ? (
          <div className="field-group">
            <div className="field-label">chaptersListUrl</div>
            <input value={chaptersListUrl} onChange={(e) => setChaptersListUrl(e.target.value)} placeholder="https://..." />
          </div>
        ) : (
          <div className="field-group">
            <div className="field-label">urlFile（项目根相对路径）</div>
            <input value={urlFile} onChange={(e) => setUrlFile(e.target.value)} placeholder="chapters_urls.txt" />
          </div>
        )}

        <hr className="divider" />

        <div className="form-grid">
          <div className="field-group">
            <div className="field-label">输出目录 outputDir</div>
            <input value={outputDir} onChange={(e) => setOutputDir(e.target.value)} required placeholder="novel-output/xnl" />
          </div>
          <div className="field-group">
            <div className="field-label">合并标题 mergeTitle</div>
            <input value={mergeTitle} onChange={(e) => setMergeTitle(e.target.value)} placeholder="可留空" />
          </div>
        </div>
        <div className="field-hint">章节上限不写入 JSON；在 Targets 列表点「运行」时填写。</div>

        <div className="field-group">
          <div className="field-label">启用</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
            <button
              type="button"
              className={`toggle${enabled ? '' : ' off'}`}
              aria-pressed={enabled}
              onClick={() => setEnabled(!enabled)}
            />
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              在 Targets 列表中显示并可运行
            </span>
          </div>
        </div>
      </div>
    </form>
  );
}
