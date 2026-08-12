export default function TopBar({ title, back, onBack, right, backText }) {
  return (
    <div className="topbar">
      {back ? (
        <button type="button" className="topbar-back" onClick={onBack}>
          ← {backText || '返回'}
        </button>
      ) : (
        <span className="topbar-title">{title}</span>
      )}
      {right != null && right !== false && <div className="topbar-right">{right}</div>}
    </div>
  );
}
