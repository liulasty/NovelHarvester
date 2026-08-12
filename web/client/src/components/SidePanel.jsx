import { useState, useEffect, useCallback, useRef } from 'react';

function setThemeAttr(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

const BG_THEMES = [
  { id: 'cream', color: '#F5F0EB', label: '米白' },
  { id: 'green', color: '#C7EDCC', label: '护眼' },
  { id: 'paper', color: '#F5E6C8', label: '羊皮' },
  { id: 'gray', color: '#E8E8E8', label: '浅灰' },
  { id: 'dark', color: '#1A1A1E', label: '夜黑' },
];

export default function SidePanel({ onFontSizeChange, readerBg, onBgChange }) {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('novel-theme') || 'light';
  });
  const [showBgPicker, setShowBgPicker] = useState(false);
  const dismissTimer = useRef(null);

  useEffect(() => {
    setThemeAttr(theme);
    localStorage.setItem('novel-theme', theme);
  }, [theme]);

  useEffect(() => {
    return () => { if (dismissTimer.current) clearTimeout(dismissTimer.current); };
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  }, []);

  const handleBgSelect = useCallback((bgId) => {
    onBgChange?.(bgId);
    // auto-dismiss after 400ms for visual feedback
    dismissTimer.current = setTimeout(() => setShowBgPicker(false), 400);
  }, [onBgChange]);

  return (
    <div className="side-panel">
      <button
        className="side-panel-btn"
        data-tip="阅读背景"
        onClick={() => setShowBgPicker(!showBgPicker)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="10"/>
          <circle cx="12" cy="12" r="6"/>
          <circle cx="12" cy="12" r="2"/>
        </svg>
      </button>

      <div className={`bg-themes ${showBgPicker ? 'open' : ''}`}>
        <span className="bg-theme-label">背景</span>
        <div className="bg-theme-dots">
          {BG_THEMES.map((bg) => (
            <div
              key={bg.id}
              className={`bg-theme-dot ${readerBg === bg.id ? 'active' : ''}`}
              style={{ background: bg.color }}
              title={bg.label}
              onClick={() => handleBgSelect(bg.id)}
            />
          ))}
        </div>
      </div>

      <div className="side-panel-divider" />

      <button
        className="side-panel-btn"
        data-tip={theme === 'light' ? '夜间模式' : '日间模式'}
        onClick={toggleTheme}
      >
        {theme === 'light' ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="12" cy="12" r="5"/>
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        )}
      </button>

      <div className="side-panel-divider" />

      <div className="font-size-controls">
        <button className="font-size-btn" data-tip="缩小" onClick={() => onFontSizeChange?.(-1)}>
          A-
        </button>
        <button className="font-size-btn" data-tip="放大" onClick={() => onFontSizeChange?.(1)}>
          A+
        </button>
      </div>
    </div>
  );
}
