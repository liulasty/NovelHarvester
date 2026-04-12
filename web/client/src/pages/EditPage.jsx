import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import TopBar from '../components/TopBar.jsx';
import Button from '../components/Button.jsx';
import TargetEditForm from '../components/TargetEditForm.jsx';
import { apiJson } from '../api.js';

export default function EditPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const isNew = !id || id === 'new';
  const [initial, setInitial] = useState(null);
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    if (isNew) {
      setInitial(null);
      return;
    }
    (async () => {
      try {
        const data = await apiJson('/api/targets');
        const t = (data.targets || []).find((x) => x.id === id);
        if (!t) {
          setLoadErr('未找到该目标');
          setInitial(null);
          return;
        }
        setInitial(t);
      } catch (e) {
        setLoadErr(e.message);
      }
    })();
  }, [id, isNew]);

  if (!isNew && loadErr) {
    return (
      <>
        <TopBar back onBack={() => nav('/targets')} right={null} />
        <div className="content">
          <div className="muted-hint">{loadErr}</div>
        </div>
      </>
    );
  }

  if (!isNew && !initial) {
    return (
      <>
        <TopBar back onBack={() => nav('/targets')} right={null} />
        <div className="content">
          <div className="muted-hint">加载中…</div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar
        back
        onBack={() => nav('/targets')}
        right={
          <>
            <Button type="button" onClick={() => nav('/targets')}>
              取消
            </Button>
            <Button type="submit" form="edit-target-form" variant="save">
              保存
            </Button>
          </>
        }
      />
      <TargetEditForm
        initial={initial}
        isNew={isNew}
        onSaved={() => nav('/targets')}
      />
    </>
  );
}
