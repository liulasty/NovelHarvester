import { useNavigate } from 'react-router-dom';

export default function TargetAddRow() {
  const nav = useNavigate();
  return (
    <button type="button" className="add-row" onClick={() => nav('/targets/new')}>
      + 添加目标
    </button>
  );
}
