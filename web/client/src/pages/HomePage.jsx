import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar.jsx';
import HeroBanner from '../components/HeroBanner.jsx';
import BookCard from '../components/BookCard.jsx';
import SidePanel from '../components/SidePanel.jsx';
import SiteFooter from '../components/SiteFooter.jsx';

function enrichNovels(novels) {
  return novels.map((n) => ({
    ...n,
    author: n.title.includes('弄玉') ? '弄玉' :
            n.title.includes('罗森') ? '罗森' :
            n.title.includes('帝') ? '青衫仗剑' :
            n.title.includes('仙') ? '一念红尘' :
            n.title.includes('妹妹') ? '江南烟雨' :
            n.title.includes('老婆') ? '夜雨声烦' :
            n.title.includes('奴') ? '暗夜行者' : '墨语作者',
    desc: n.chapterCount > 500 ? `一部宏大的长篇巨著，共 ${n.chapterCount} 章，情节跌宕起伏，引人入胜。` :
          n.chapterCount > 200 ? `精彩长篇力作，${n.chapterCount} 章完整收录，故事扣人心弦。` :
          n.chapterCount > 50 ? `中篇精品小说，${n.chapterCount} 章全本收录，文笔细腻动人。` :
          `短篇佳作，共 ${n.chapterCount} 章，精致耐读。`,
  }));
}

export default function HomePage() {
  const [novels, setNovels] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/novels')
      .then((r) => r.json())
      .then((data) => {
        const enriched = enrichNovels(data).filter((n) => n.chapterCount > 0);
        setNovels(enriched);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Group novels into sections
  const byChapters = [...novels].sort((a, b) => b.chapterCount - a.chapterCount);
  const featured = byChapters.slice(0, 5);
  const hotList = byChapters.slice(0, 10);
  const completed = byChapters.filter((n) => n.chapterCount > 100 && n.chapterCount < 1000).slice(0, 8);
  const newBooks = [...novels].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8);
  const picks = novels.filter((n) => n.chapterCount > 50 && n.chapterCount < 500).slice(0, 8);

  if (loading) {
    return (
      <div className="app-container">
        <NavBar />
        <div className="main-content" style={{ textAlign: 'center', paddingTop: 80 }}>
          <p className="muted-hint">加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <NavBar onSearch={(q) => { if (q) navigate(`/novels?q=${encodeURIComponent(q)}`); }} />
      <SidePanel />

      <div className="main-content">
        <HeroBanner novels={featured} />

        {/* 热销榜单 */}
        <section className="home-section">
          <div className="section-header">
            <h3 className="section-title"><span className="section-title-bar" />热销榜单</h3>
            <span className="section-more" onClick={() => navigate('/novels')}>
              查看更多 →
            </span>
          </div>
          <div className="book-list-h">
            {hotList.map((n, i) => (
              <div
                key={n.id}
                className="book-list-item"
                onClick={() => navigate(`/novels/${n.id}`)}
              >
                <span className={`book-list-rank ${i < 3 ? `top${i + 1}` : 'normal'}`}>
                  {i + 1}
                </span>
                <div
                  className="book-list-cover"
                  style={{ background: `linear-gradient(135deg, ${['#8BA4C7','#D4A88C','#A8C4A0'][i] || '#B8C898'}, ${['#6B84A8','#C08E72','#8AAA82'][i] || '#98A878'})` }}
                >
                  {(n.title || '书').charAt(0)}
                </div>
                <div className="book-list-info">
                  <div className="book-list-title">{n.title}</div>
                  <div className="book-list-meta">{n.author} · {n.chapterCount} 章</div>
                </div>
                <div className="book-list-stat">{n.chapterCount > 500 ? '已完结' : '连载中'}</div>
              </div>
            ))}
          </div>
        </section>

        {/* 完结好书 */}
        <section className="home-section">
          <div className="section-header">
            <h3 className="section-title"><span className="section-title-bar" />完结好书</h3>
            <span className="section-more" onClick={() => navigate('/novels')}>
              查看更多 →
            </span>
          </div>
          <div className="book-grid book-grid-5">
            {completed.map((n) => (
              <BookCard key={n.id} novel={n} />
            ))}
          </div>
        </section>

        {/* 新书推荐 */}
        <section className="home-section">
          <div className="section-header">
            <h3 className="section-title"><span className="section-title-bar" />新书推荐</h3>
            <span className="section-more" onClick={() => navigate('/novels')}>
              查看更多 →
            </span>
          </div>
          <div className="book-grid book-grid-5">
            {newBooks.map((n) => (
              <BookCard key={n.id} novel={n} />
            ))}
          </div>
        </section>

        {/* 编辑精选 */}
        <section className="home-section">
          <div className="section-header">
            <h3 className="section-title"><span className="section-title-bar" />编辑精选</h3>
            <span className="section-more" onClick={() => navigate('/novels')}>
              查看更多 →
            </span>
          </div>
          <div className="book-grid book-grid-5">
            {picks.map((n) => (
              <BookCard key={n.id} novel={n} />
            ))}
          </div>
        </section>
      </div>

      <SiteFooter />
    </div>
  );
}
