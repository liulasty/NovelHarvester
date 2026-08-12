import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

function useCarousel(total) {
  const [current, setCurrent] = useState(0);
  const [direction, setDirection] = useState(1);

  const next = useCallback(() => {
    setDirection(1);
    setCurrent((c) => (c + 1) % total);
  }, [total]);

  const prev = useCallback(() => {
    setDirection(-1);
    setCurrent((c) => (c - 1 + total) % total);
  }, [total]);

  useEffect(() => {
    const timer = setInterval(next, 5000);
    return () => clearInterval(timer);
  }, [next]);

  return { current, direction, next, prev, setCurrent };
}

export default function HeroBanner({ novels }) {
  const navigate = useNavigate();
  const total = Math.min(novels.length, 5);
  const { current, next, prev, setCurrent } = useCarousel(total);

  if (!novels.length) return null;

  const book = novels[current];
  const colors = [
    ['#8BA4C7', '#6B84A8'],
    ['#D4A88C', '#C08E72'],
    ['#A8C4A0', '#8AAA82'],
    ['#C4A0C0', '#A882A4'],
    ['#A0B4C8', '#829AB0'],
  ];
  const [c1, c2] = colors[current % colors.length];

  return (
    <section className="banner-section">
      <div className="banner-carousel">
        <button className="banner-arrow banner-arrow-left" onClick={prev}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>

        <div className="banner-slide">
          <div className="banner-cover">
            <div className="banner-cover-bg" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }} />
            <div className="banner-cover-inner" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
              {(book.title || '书').charAt(0)}
            </div>
          </div>
          <div className="banner-info">
            <span className="banner-tag" style={{ background: c1 + '22', color: c2 }}>精选推荐</span>
            <h2 className="banner-title">{book.title}</h2>
            <p className="banner-author">{book.author || '未知作者'} · {book.chapterCount || '?'} 章</p>
            <p className="banner-desc">{book.desc || `共收录 ${book.chapterCount || '?'} 章，点击开始阅读`}</p>
            <div className="banner-actions">
              <button className="banner-btn banner-btn-primary" onClick={() => navigate(`/novels/${book.id}`)}>
                开始阅读
              </button>
              <button className="banner-btn banner-btn-secondary" onClick={() => navigate(`/novels/${book.id}`)}>
                查看详情
              </button>
            </div>
          </div>
        </div>

        <button className="banner-arrow banner-arrow-right" onClick={next}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>

        <div className="banner-dots">
          {Array.from({ length: total }).map((_, i) => (
            <div
              key={i}
              className={`banner-dot ${i === current ? 'active' : ''}`}
              onClick={() => setCurrent(i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
