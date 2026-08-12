import { useNavigate } from 'react-router-dom';

const COVER_COLORS = [
  ['#8BA4C7', '#6B84A8'],
  ['#D4A88C', '#C08E72'],
  ['#A8C4A0', '#8AAA82'],
  ['#C4A0C0', '#A882A4'],
  ['#A0B4C8', '#829AB0'],
  ['#C8B4A0', '#B09A82'],
  ['#8FB0A8', '#70968E'],
  ['#B8A8C8', '#9A88B0'],
  ['#C8A8A0', '#B08880'],
  ['#98B8C8', '#7898B0'],
  ['#B8C898', '#98A878'],
  ['#C898A8', '#B07890'],
];

const TAG_RULES = [
  { keywords: ['帝', '尊', '仙', '神', '道', '破', '玄'], tag: '玄幻', cls: 'default' },
  { keywords: ['甜', '宠', '爱', '妹妹', '老婆', '校花'], tag: '甜宠', cls: 'warm' },
  { keywords: ['禁忌', '宗教', '治疗'], tag: '悬疑', cls: 'purple' },
  { keywords: ['奴', '犬'], tag: '都市', cls: 'green' },
  { keywords: ['侠', '剑', '江湖'], tag: '武侠', cls: 'default' },
];

function getTag(title) {
  for (const rule of TAG_RULES) {
    if (rule.keywords.some((kw) => title.includes(kw))) {
      return { tag: rule.tag, cls: rule.cls };
    }
  }
  return { tag: '都市', cls: 'green' };
}

function getCoverColor(title) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash) + title.charCodeAt(i);
  }
  return COVER_COLORS[Math.abs(hash) % COVER_COLORS.length];
}

function getFirstChar(title) {
  const cleaned = title.replace(/[《》]/g, '').trim();
  return cleaned.charAt(0) || '书';
}

export default function BookCard({ novel, compact }) {
  const navigate = useNavigate();
  const [c1, c2] = getCoverColor(novel.title);
  const { tag, cls } = getTag(novel.title);
  const initial = getFirstChar(novel.title);

  if (compact) {
    return (
      <div className="book-list-item" onClick={() => navigate(`/novels/${novel.id}`)}>
        <div className="book-list-cover" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
          {initial}
        </div>
        <div className="book-list-info">
          <div className="book-list-title">{novel.title}</div>
          <div className="book-list-meta">{novel.chapterCount || '?'} 章</div>
        </div>
      </div>
    );
  }

  return (
    <div className="book-card" onClick={() => navigate(`/novels/${novel.id}`)}>
      <div className="book-cover" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
        <span className="book-cover-text">{initial}</span>
        <div className="book-cover-overlay" />
      </div>
      <div className="book-card-body">
        <div className="book-card-title">{novel.title}</div>
        <div className="book-card-author">{novel.author || '未知作者'}</div>
        <div className="book-card-tags">
          <span className={`book-card-tag ${cls}`}>{tag}</span>
          {novel.chapterCount > 200 && <span className="book-card-tag default">长篇</span>}
        </div>
        <div className="book-card-desc">{novel.desc || `共 ${novel.chapterCount || '?'} 章`}</div>
      </div>
    </div>
  );
}
