export default function TopBar({ title, back, onBack, right }) {
  return (
    <div className="topbar">
      {back ? (
        <button type="button" className="topbar-back" onClick={onBack}>
          ← 返回 Targets
        </button>
      ) : (
        <span className="topbar-title">{title}</span>
      )}
      {right != null && right !== false && <div className="topbar-right">{right}</div>}
    </div>
  );
}
