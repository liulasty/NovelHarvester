import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import NavBar from '../components/NavBar.jsx';
import SidePanel from '../components/SidePanel.jsx';
import '../reader.css';

/* ──────── Back to Top ──────── */
function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 400);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <button className={`back-to-top ${show ? 'visible' : ''}`} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} title="回到顶部">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 15l-6-6-6 6"/></svg>
    </button>
  );
}

/* ──────── Reading Progress ──────── */
function ReadingProgress() {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(docHeight > 0 ? Math.min((scrollTop / docHeight) * 100, 100) : 0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <div className="reader-progress-bar">
      <div className="reader-progress-bar-fill" style={{ width: `${progress}%` }} />
    </div>
  );
}

/* ──────── Nav Buttons ──────── */
function NavBtn({ label, dir, disabled, onClick, hint }) {
  return (
    <button className="reader-nav-btn" disabled={disabled} onClick={onClick}>
      {dir === 'prev' && <>← {label}</>}
      {!dir && label}
      {dir === 'next' && <>{label} →</>}
      {hint && <span className="keyboard-hint"><kbd>{hint}</kbd></span>}
    </button>
  );
}

function NavChapterBtn({ dir, label, chapterTitle, disabled, onClick }) {
  return (
    <button className="reader-nav-btn" disabled={disabled} onClick={onClick}>
      <span className="nav-label">{dir === 'prev' ? '← 上一章' : '下一章 →'}</span>
      <span className="nav-title">{chapterTitle || label}</span>
    </button>
  );
}

/* ──────── Chapter Reader ──────── */
function ReaderContent({ id, seq, chapter, novel, fontSize, onFontSizeChange }) {
  const navigate = useNavigate();
  const topRef = useRef(null);

  useEffect(() => {
    if (topRef.current) topRef.current.scrollIntoView({ behavior: 'smooth' });
    document.title = `${chapter?.title || `第 ${seq} 章`} - ${novel?.title || ''}`;
  }, [seq]);

  const hasPrev = seq > 1;
  const hasNext = novel?.chapterCount ? seq < novel.chapterCount : true;

  const goPrev = useCallback(() => hasPrev && navigate(`/reader/${id}/${seq - 1}`), [hasPrev, id, navigate]);
  const goNext = useCallback(() => hasNext && navigate(`/reader/${id}/${seq + 1}`), [hasNext, id, navigate]);

  // keyboard
  useEffect(() => {
    const fn = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [goPrev, goNext]);

  // Process content into paragraphs
  const paragraphs = chapter?.content
    ? chapter.content.split('\n').filter(Boolean).map((p) => p.trim()).filter(Boolean)
    : [];

  // Estimate reading time (~300 chars/min for Chinese)
  const totalChars = paragraphs.reduce((acc, p) => acc + p.length, 0);
  const readingMinutes = Math.max(1, Math.round(totalChars / 300));
  const readingTimeLabel = `约 ${readingMinutes} 分钟阅读`;

  return (
    <div ref={topRef}>
      {/* Toolbar */}
      <div className="reader-toolbar">
        <div className="reader-toolbar-inner">
          <div className="reader-toolbar-left">
            <Link to={`/novels/${id}`} className="reader-toolbar-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
              目录
            </Link>
          </div>
          {novel && (
            <div className="reader-toolbar-info">
              <span>{novel.title}</span>
              <span className="sep">·</span>
              <span>第 {seq}/{novel.chapterCount} 章</span>
            </div>
          )}
          <div className="reader-toolbar-right">
            <button className="reader-toolbar-font-btn" onClick={() => onFontSizeChange?.(-1)} title="缩小字体">A-</button>
            <button className="reader-toolbar-font-btn" onClick={() => onFontSizeChange?.(1)} title="放大字体">A+</button>
          </div>
        </div>
      </div>

      {/* Top nav */}
      <div className="reader-top-nav">
        <div className="reader-top-nav-inner">
          <NavBtn label="上一章" dir="prev" disabled={!hasPrev} onClick={goPrev} hint="←" />
          <span style={{ fontSize: 12, color: 'var(--r-muted)' }}>{seq}/{novel?.chapterCount}</span>
          <NavBtn label="下一章" dir="next" disabled={!hasNext} onClick={goNext} hint="→" />
        </div>
      </div>

      {/* Content */}
      <div className="reader-content reader-wrap">
        <div className="reader-content-card">
          <div className="reader-chapter-title">
            <h1>{chapter?.title || `第 ${seq} 章`}</h1>
            <div className="deco-line">
              <span /><div className="deco-dot" /><span />
            </div>
          </div>

          <div className="reader-reading-time">
            <span>{readingTimeLabel}</span>
          </div>

          <div className={`reader-text size-${['small', 'medium', 'large'][fontSize]}`}>
            {paragraphs.length > 0
              ? paragraphs.map((p, i) => <p key={i}>{p}</p>)
              : chapter?.content || ''}
          </div>
        </div>
      </div>

      {/* Bottom nav */}
      <div className="reader-bottom-nav">
        <div className="reader-bottom-nav-inner">
          <NavChapterBtn
            dir="prev"
            label={`第 ${seq - 1} 章`}
            chapterTitle={hasPrev ? `第 ${seq - 1} 章` : ''}
            disabled={!hasPrev}
            onClick={goPrev}
          />
          <Link to={`/novels/${id}`} className="reader-nav-btn center" style={{ textDecoration: 'none' }}>
            <span className="nav-label">返回</span>
            <span className="nav-title">目录</span>
          </Link>
          <NavChapterBtn
            dir="next"
            label={`第 ${seq + 1} 章`}
            chapterTitle={hasNext ? `第 ${seq + 1} 章` : ''}
            disabled={!hasNext}
            onClick={goNext}
          />
        </div>
      </div>
    </div>
  );
}

/* ──────── Merged Reader ──────── */
function MergedReader({ id, novel }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fontSize, setFontSize] = useState(() =>
    parseInt(localStorage.getItem('novel-reader-fontsize') || '1', 10)
  );

  useEffect(() => {
    fetch(`/api/novels/${encodeURIComponent(id)}/merged`)
      .then((r) => { if (!r.ok) throw new Error('加载失败'); return r.text(); })
      .then(setContent)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { document.title = `${novel?.title || ''} - 全文阅读`; }, [novel]);

  const adjustSize = useCallback((dir) => {
    setFontSize((p) => {
      const n = Math.max(0, Math.min(2, p + dir));
      localStorage.setItem('novel-reader-fontsize', String(n));
      return n;
    });
  }, []);

  const paragraphs = content.split('\n').filter(Boolean).map((p) => p.trim()).filter(Boolean);
  const totalChars = paragraphs.reduce((acc, p) => acc + p.length, 0);
  const readingMinutes = Math.max(1, Math.round(totalChars / 300));

  if (loading) return (
    <div className="reader-skeleton">
      <div className="skeleton-card">
        <div className="skeleton-title" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
      </div>
      <p className="muted-hint" style={{ textAlign: 'center', marginTop: 20 }}>加载中...</p>
    </div>
  );
  if (error) return <div className="reader-skeleton"><p className="log-err" style={{ textAlign: 'center' }}>{error}</p></div>;

  const navigate = useNavigate();

  return (
    <div>
      <div className="reader-toolbar">
        <div className="reader-toolbar-inner">
          <Link to={`/novels/${id}`} className="reader-toolbar-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            目录
          </Link>
          <div className="reader-toolbar-info">
            <span>{novel?.title}</span>
            <span className="sep">·</span>
            <span>全文阅读</span>
          </div>
          <div className="reader-toolbar-right">
            <button className="reader-toolbar-font-btn" onClick={() => adjustSize(-1)} title="缩小字体">A-</button>
            <button className="reader-toolbar-font-btn" onClick={() => adjustSize(1)} title="放大字体">A+</button>
          </div>
        </div>
      </div>

      <div className="reader-content reader-wrap">
        <div className="reader-content-card">
          <div className="reader-chapter-title">
            <h1>{novel?.title || ''}</h1>
            <div className="deco-line"><span /><div className="deco-dot" /><span /></div>
          </div>
          <div className="reader-reading-time">
            <span>约 {readingMinutes} 分钟阅读 · {totalChars.toLocaleString()} 字</span>
          </div>
          <div className={`reader-text size-${['small', 'medium', 'large'][fontSize]}`}>
            {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          </div>
        </div>
      </div>

      <div className="reader-bottom-nav">
        <div className="reader-bottom-nav-inner">
          <button className="reader-nav-btn center" onClick={() => navigate(`/novels/${id}`)}>
            <span className="nav-label">← 返回</span>
            <span className="nav-title">目录</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ──────── Main ──────── */
export default function ReaderPage() {
  const { id, seq } = useParams();
  const [novel, setNovel] = useState(null);
  const [chapter, setChapter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fontSize, setFontSize] = useState(() =>
    parseInt(localStorage.getItem('novel-reader-fontsize') || '1', 10)
  );
  const [readerBg, setReaderBg] = useState(() =>
    localStorage.getItem('novel-reader-bg') || 'cream'
  );

  const isMerged = seq === 'merged';
  const seqNum = parseInt(seq, 10);

  const handleFont = useCallback((dir) => {
    setFontSize((p) => {
      const n = Math.max(0, Math.min(2, p + dir));
      localStorage.setItem('novel-reader-fontsize', String(n));
      return n;
    });
  }, []);

  const handleBg = useCallback((bg) => {
    setReaderBg(bg);
    localStorage.setItem('novel-reader-bg', bg);
  }, []);

  useEffect(() => {
    if (isMerged) {
      fetch(`/api/novels/${encodeURIComponent(id)}`)
        .then((r) => r.json()).then(setNovel)
        .catch(setError).finally(() => setLoading(false));
      return;
    }
    setLoading(true); setError('');
    Promise.all([
      fetch(`/api/novels/${encodeURIComponent(id)}`).then((r) => r.json()),
      fetch(`/api/novels/${encodeURIComponent(id)}/chapter/${seq}`).then((r) => r.json()),
    ])
      .then(([a, b]) => { setNovel(a); setChapter(b); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [id, seq, isMerged]);

  if (loading || error) {
    return (
      <div className="app-container">
        <NavBar />
        <SidePanel onFontSizeChange={handleFont} readerBg={readerBg} onBgChange={handleBg} />
        <div className={`reader-page reader-bg-${readerBg}`}>
          <div className="reader-skeleton">
            {error ? (
              <p className="log-err" style={{ textAlign: 'center', padding: 60 }}>{error}</p>
            ) : (
              <div className="skeleton-card">
                <div className="skeleton-title" />
                <div className="skeleton-line" />
                <div className="skeleton-line" />
                <div className="skeleton-line" />
                <div className="skeleton-line" />
                <div className="skeleton-line" />
                <p className="muted-hint" style={{ textAlign: 'center', marginTop: 20 }}>加载中...</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <NavBar />
      <SidePanel onFontSizeChange={handleFont} readerBg={readerBg} onBgChange={handleBg} />

      <div className={`reader-page reader-bg-${readerBg}`}>
        <ReadingProgress />
        {isMerged
          ? <MergedReader id={id} novel={novel} />
          : <ReaderContent id={id} seq={seqNum} chapter={chapter} novel={novel} fontSize={fontSize} onFontSizeChange={handleFont} />
        }
        <BackToTop />
      </div>
    </div>
  );
}
