import { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import NavBar from '../components/NavBar.jsx';
import SidePanel from '../components/SidePanel.jsx';
import SiteFooter from '../components/SiteFooter.jsx';
import '../detail.css';

/* ===================== Utility ===================== */

const COVER_COLORS = [
  ['#8BA4C7', '#6B84A8'], ['#D4A88C', '#C08E72'], ['#A8C4A0', '#8AAA82'],
  ['#C4A0C0', '#A882A4'], ['#A0B4C8', '#829AB0'], ['#8FB0A8', '#70968E'],
  ['#B8A8C8', '#9A88B0'], ['#C8A8A0', '#B08880'], ['#98B8C8', '#7898B0'],
];

function coverColor(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = ((h << 5) - h) + title.charCodeAt(i);
  return COVER_COLORS[Math.abs(h) % COVER_COLORS.length];
}

function formatSize(b) {
  if (!b) return '';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b > 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

const TAG_RULES = [
  { kw: ['帝','尊','仙','神','道','破','玄'], tag: '玄幻', cls: 'default' },
  { kw: ['宠','爱','妹妹','老婆','校花','甜'], tag: '甜宠', cls: 'warm' },
  { kw: ['禁忌','宗教','治疗'], tag: '悬疑', cls: 'purple' },
  { kw: ['奴','犬','妻','母'], tag: '都市', cls: 'green' },
];

function guessTag(title) {
  for (const r of TAG_RULES) if (r.kw.some((k) => title.includes(k))) return r;
  return { tag: '都市', cls: 'green' };
}

function numberIcon(n) {
  if (n <= 3) return ['🥇','🥈','🥉'][n - 1];
  return `${n}.`;
}

/* ===================== Chapter Pagination ===================== */

const PAGE_SIZE = 100;

function ChapterPagination({ total, page, onChange }) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const [jump, setJump] = useState('');
  if (totalPages <= 1) return null;

  const pages = [];
  const R = 2;
  let s = Math.max(1, page - R), e = Math.min(totalPages, page + R);
  if (s > 1) { pages.push(1); if (s > 2) pages.push('…'); }
  for (let i = s; i <= e; i++) pages.push(i);
  if (e < totalPages) { if (e < totalPages - 1) pages.push('…'); pages.push(totalPages); }

  const doJump = () => {
    const n = parseInt(jump, 10);
    if (n >= 1 && n <= totalPages) onChange(n);
    setJump('');
  };

  return (
    <div className="detail-chapter-pagination">
      <button className="cp-btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>‹</button>
      {pages.map((p, i) =>
        p === '…' ? <span key={`e${i}`} className="cp-ellipsis">…</span>
        : <button key={p} className={`cp-btn ${p === page ? 'active' : ''}`} onClick={() => onChange(p)}>{p}</button>
      )}
      <button className="cp-btn" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>›</button>
      <span className="cp-info">{page}/{totalPages}</span>
      <input className="cp-jump" type="text" placeholder="页" value={jump}
        onChange={(e) => setJump(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && doJump()}
        onBlur={doJump}
      />
    </div>
  );
}

/* ===================== Main ===================== */

export default function NovelDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [novel, setNovel] = useState(null);
  const [desc, setDesc] = useState('');
  const [descExpanded, setDescExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [sortAsc, setSortAsc] = useState(true);
  const [allNovels, setAllNovels] = useState([]);

  // Fetch novel detail
  useEffect(() => {
    setPage(1);
    setLoading(true);
    setError('');
    fetch(`/api/novels/${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then(async (data) => {
        setNovel(data);
        // Fetch first chapter for description preview
        if (data.chapters?.length > 0) {
          try {
            const r = await fetch(`/api/novels/${encodeURIComponent(id)}/chapter/1`);
            const ch = await r.json();
            const txt = ch.content || '';
            // Extract ~200 chars of actual content (skip title line)
            const lines = txt.split('\n').filter(Boolean);
            const body = lines.slice(1).join('').trim().slice(0, 300);
            setDesc(body || `共 ${data.chapterCount} 章，点击开始阅读`);
          } catch {
            setDesc(`共 ${data.chapterCount} 章，点击开始阅读`);
          }
        } else {
          setDesc('暂无章节信息');
        }
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [id]);

  // Fetch all novels for related list
  useEffect(() => {
    fetch('/api/novels')
      .then((r) => r.json())
      .then((data) => setAllNovels(data.filter((n) => n.id !== id && n.chapterCount > 0)))
      .catch(() => {});
  }, [id]);

  const totalChapters = novel?.chapters?.length || 0;
  const totalPages = Math.ceil(totalChapters / PAGE_SIZE);

  const currentChapters = useMemo(() => {
    if (!novel?.chapters) return [];
    let list = [...novel.chapters];
    if (!sortAsc) list = list.reverse();
    const start = (page - 1) * PAGE_SIZE;
    return list.slice(start, start + PAGE_SIZE);
  }, [novel, page, sortAsc]);

  // Related: pick 5 random
  const related = useMemo(() => {
    if (!allNovels.length) return [];
    return [...allNovels].sort(() => 0.5 - Math.random()).slice(0, 5);
  }, [allNovels]);

  const goPrevPage = useCallback(() => setPage((p) => Math.max(1, p - 1)), []);
  const goNextPage = useCallback(() => setPage((p) => Math.min(totalPages, p + 1)), [totalPages]);

  const [c1, c2] = novel ? coverColor(novel.title) : ['#8BA4C7', '#6B84A8'];
  const { tag, cls } = novel ? guessTag(novel.title) : { tag: '', cls: '' };
  const initial = novel ? (novel.title.charAt(0) || '书') : '书';

  /* ---------- Loading ---------- */
  if (loading) {
    return (
      <div className="app-container">
        <NavBar />
        <div className="detail-page">
          <div style={{ maxWidth: 1200, margin: '80px auto', textAlign: 'center' }}>
            <div className="loading-skeleton" style={{ width: 200, height: 270, margin: '0 auto 20px', borderRadius: 8, background: 'var(--bg-hover)' }} />
            <p className="muted-hint">加载中...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !novel) {
    return (
      <div className="app-container">
        <NavBar />
        <div className="detail-page" style={{ textAlign: 'center', paddingTop: 80 }}>
          <p className="log-err">{error || '未找到该小说'}</p>
          <Link to="/" style={{ color: 'var(--primary)', marginTop: 12, display: 'inline-block' }}>返回首页</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <NavBar />
      <SidePanel />

      <div className="detail-page">
        {/* Breadcrumb */}
        <div className="detail-breadcrumb">
          <Link to="/">首页</Link>
          <span className="sep">/</span>
          <Link to="/novels">书库</Link>
          <span className="sep">/</span>
          <span style={{ color: 'var(--text-secondary)' }}>{novel.title}</span>
        </div>

        {/* ────── Hero ────── */}
        <div className="detail-hero-wrap">
          <div className="detail-hero">
            <div className="detail-cover-wrap">
              <div className="detail-cover" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
                {initial}
              </div>
              <div className="detail-cover-foil" />
            </div>

            <div className="detail-meta">
              <div className="detail-meta-top">
                <div className="detail-title-group">
                  <h1 className="detail-title">{novel.title}</h1>
                  <div className="detail-author">
                    <span className="detail-author-icon">作</span>
                    <span>{/* Try to derive author from title */}</span>
                  </div>
                </div>
              </div>

              <div className="detail-tags">
                <span className={`detail-tag ${cls}`}>{tag}</span>
                {novel.chapterCount > 500 && <span className="detail-tag amber">已完结</span>}
                {novel.chapterCount > 200 && <span className="detail-tag default">长篇</span>}
                {novel.chapterCount > 50 && novel.chapterCount <= 200 && <span className="detail-tag green">中篇</span>}
                {novel.chapterCount <= 50 && <span className="detail-tag warm">短篇</span>}
              </div>

              <div className="detail-stats">
                <div className="detail-stat-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6h16M4 12h16M4 18h12"/></svg>
                  <span>共 <span className="detail-stat-value">{novel.chapterCount}</span> 章</span>
                </div>
                {novel.mergedSize && (
                  <div className="detail-stat-item">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <span>全文 <span className="detail-stat-value">{formatSize(novel.mergedSize)}</span></span>
                  </div>
                )}
                <div className="detail-stat-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  <span>{novel.chapterCount > 500 ? '已完结' : '连载中'}</span>
                </div>
              </div>

              <div className={`detail-desc ${descExpanded ? 'expanded' : ''}`}>
                {desc}
                {desc.length > 200 && (
                  <span className="detail-desc-expand" onClick={() => setDescExpanded(!descExpanded)}>
                    {descExpanded ? '收起' : '展开'}
                  </span>
                )}
              </div>

              <div className="detail-actions">
                <button className="detail-action-btn primary" onClick={() => {
                  if (novel.chapters?.length > 0) navigate(`/reader/${id}/1`);
                  else if (novel.mergedFile) navigate(`/reader/${id}/merged`);
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  开始阅读
                </button>
                {novel.mergedFile && (
                  <button className="detail-action-btn secondary" onClick={() => navigate(`/reader/${id}/merged`)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    全文阅读
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ────── Content Grid ────── */}
        <div className="detail-content-grid">
          {/* Left: Chapters */}
          <div className="detail-chapters-wrap">
            <div className="detail-chapters-header">
              <div className="detail-chapters-title">
                章节目录
                <span className="detail-chapters-count">
                  共 {totalChapters} 章 · 当前 {Math.min((page - 1) * PAGE_SIZE + 1, totalChapters)}-{Math.min(page * PAGE_SIZE, totalChapters)}
                </span>
              </div>
              <div className="detail-chapters-bar">
                <button className={`bar-btn ${sortAsc ? 'active' : ''}`} onClick={() => setSortAsc(true)}>正序</button>
                <button className={`bar-btn ${!sortAsc ? 'active' : ''}`} onClick={() => setSortAsc(false)}>倒序</button>
              </div>
            </div>

            <div className="detail-chapter-list">
              {currentChapters.length > 0 ? currentChapters.map((ch) => (
                <div key={ch.seq} className="detail-chapter-item" onClick={() => navigate(`/reader/${id}/${ch.seq}`)}>
                  {ch.title || `第 ${ch.seq} 章`}
                </div>
              )) : (
                <p className="muted-hint" style={{ gridColumn: '1/-1', padding: 16 }}>暂无章节信息</p>
              )}
            </div>

            <ChapterPagination total={totalChapters} page={page} onChange={setPage} />
          </div>

          {/* Right: Sidebar */}
          <div className="detail-sidebar">
            {/* Download card */}
            {novel.mergedFile && (
              <div className="detail-sidebar-card">
                <div className="sidebar-card-title">文件下载</div>
                <div className="detail-download-list">
                  <a
                    className="detail-download-btn"
                    href={`/api/novels/${encodeURIComponent(id)}/merged`}
                    download
                  >
                    <span>{novel.mergedFile}</span>
                    <span className="size">{formatSize(novel.mergedSize)}</span>
                  </a>
                </div>
              </div>
            )}

            {/* Related */}
            {related.length > 0 && (
              <div className="detail-sidebar-card">
                <div className="sidebar-card-title">相关推荐</div>
                <div className="detail-related-list">
                  {related.map((n) => {
                    const [rc1, rc2] = coverColor(n.title);
                    return (
                      <div key={n.id} className="related-item" onClick={() => navigate(`/novels/${n.id}`)}>
                        <div className="related-cover" style={{ background: `linear-gradient(135deg, ${rc1}, ${rc2})` }}>
                          {(n.title || '书').charAt(0)}
                        </div>
                        <div className="related-info">
                          <div className="related-title">{n.title}</div>
                          <div className="related-meta">{n.chapterCount || '?'} 章</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Info card */}
            <div className="detail-sidebar-card">
              <div className="sidebar-card-title">作品信息</div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 2 }}>
                <div>分类：{tag}</div>
                <div>章节数：{novel.chapterCount}</div>
                {novel.updatedAt && (
                  <div>更新于：{new Date(novel.updatedAt).toLocaleDateString('zh-CN')}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
