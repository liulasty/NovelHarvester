import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import NavBar from '../components/NavBar.jsx';
import BookCard from '../components/BookCard.jsx';
import SidePanel from '../components/SidePanel.jsx';
import SiteFooter from '../components/SiteFooter.jsx';

const TAGS = ['全部', '玄幻', '甜宠', '悬疑', '都市'];
const SORTS = [
  { key: 'chapters', label: '章节数' },
  { key: 'updated', label: '最近更新' },
  { key: 'title', label: '书名' },
];

const TAG_RULES = [
  { keywords: ['帝', '尊', '仙', '神', '道', '破', '玄'], tag: '玄幻' },
  { keywords: ['甜', '宠', '爱', '妹妹', '老婆', '校花'], tag: '甜宠' },
  { keywords: ['禁忌', '宗教', '治疗'], tag: '悬疑' },
];

function guessTag(title) {
  for (const rule of TAG_RULES) {
    if (rule.keywords.some((kw) => title.includes(kw))) return rule.tag;
  }
  return '都市';
}

export default function NovelsPage() {
  const [novels, setNovels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchParams] = useSearchParams();
  const [activeTag, setActiveTag] = useState('全部');
  const [activeSort, setActiveSort] = useState('chapters');
  const [searchQ, setSearchQ] = useState(searchParams.get('q') || '');

  useEffect(() => {
    fetch('/api/novels')
      .then((r) => r.json())
      .then((data) => {
        setNovels(data.filter((n) => n.chapterCount > 0));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let list = [...novels];

    if (searchQ) {
      const q = searchQ.toLowerCase();
      list = list.filter((n) => n.title.toLowerCase().includes(q));
    }

    const gender = searchParams.get('gender');
    // Simple gender filter by title keywords
    if (gender === 'female') {
      list = list.filter((n) => /妹妹|校花|宠|妻|老婆/.test(n.title));
    } else if (gender === 'male') {
      list = list.filter((n) => /帝|尊|仙|神|道|破|侠|奴/.test(n.title));
    }

    if (activeTag !== '全部') {
      list = list.filter((n) => guessTag(n.title) === activeTag);
    }

    list.sort((a, b) => {
      if (activeSort === 'chapters') return (b.chapterCount || 0) - (a.chapterCount || 0);
      if (activeSort === 'updated') return (b.updatedAt || 0) - (a.updatedAt || 0);
      return (a.title || '').localeCompare(b.title || '');
    });

    return list;
  }, [novels, activeTag, activeSort, searchQ, searchParams]);

  return (
    <div className="app-container">
      <NavBar onSearch={setSearchQ} />
      <SidePanel />

      <div className="main-content">
        {/* Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {TAGS.map((t) => (
              <button
                key={t}
                className={`navbar-btn navbar-btn-${activeTag === t ? 'primary' : 'outline'}`}
                onClick={() => setActiveTag(t)}
                style={{ borderRadius: 6 }}
              >
                {t}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {SORTS.map((s) => (
              <button
                key={s.key}
                className={`navbar-btn navbar-btn-${activeSort === s.key ? 'primary' : 'outline'}`}
                onClick={() => setActiveSort(s.key)}
                style={{ borderRadius: 6, fontSize: 12 }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="muted-hint" style={{ textAlign: 'center', paddingTop: 60 }}>加载中...</p>
        ) : filtered.length === 0 ? (
          <p className="muted-hint" style={{ textAlign: 'center', paddingTop: 60 }}>暂无匹配的小说</p>
        ) : (
          <>
            <p className="muted-hint" style={{ marginBottom: 16, fontSize: 12 }}>
              共 {filtered.length} 部小说
            </p>
            <div className="book-grid">
              {filtered.map((n) => (
                <BookCard key={n.id} novel={n} />
              ))}
            </div>
          </>
        )}
      </div>

      <SiteFooter />
    </div>
  );
}
