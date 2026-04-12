import { useCallback, useEffect, useMemo, useState } from 'react';
import TopBar from '../components/TopBar.jsx';
import Button from '../components/Button.jsx';
import Badge from '../components/Badge.jsx';
import TargetList from '../components/TargetList.jsx';
import TargetAddRow from '../components/TargetAddRow.jsx';
import RunningLogsSection from '../components/RunningLogsSection.jsx';
import { apiJson } from '../api.js';
import { useNavigate } from 'react-router-dom';

export default function TargetsPage() {
  const [targets, setTargets] = useState([]);
  const [tasks, setTasks] = useState([]);
  const nav = useNavigate();

  const refreshTargets = useCallback(async () => {
    const data = await apiJson('/api/targets');
    setTargets(data.targets || []);
  }, []);

  const refreshTasks = useCallback(async () => {
    const data = await apiJson('/api/tasks');
    setTasks(data.tasks || []);
  }, []);

  useEffect(() => {
    refreshTargets().catch(() => {});
    refreshTasks().catch(() => {});
    const id = setInterval(() => {
      refreshTasks().catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [refreshTargets, refreshTasks]);

  const runningN = useMemo(() => tasks.filter((t) => t.status === 'running').length, [tasks]);
  const queuedN = useMemo(() => tasks.filter((t) => t.status === 'queued').length, [tasks]);

  return (
    <>
      <TopBar
        title="Targets"
        right={
          <>
            <Badge variant="running">{`${runningN} running`}</Badge>
            <Badge variant="queued">{`${queuedN} queued`}</Badge>
            <Button variant="primary" onClick={() => nav('/targets/new')}>
              + 新增目标
            </Button>
          </>
        }
      />
      <div className="content">
        <div className="conflict-banner">
          提示：与 CLI 同时编辑 <code>novel-targets.json</code> 时，<strong>最后写入者覆盖</strong>；保存前请确认无未合并的手工修改。
        </div>
        <div>
          <div className="section-label">目标列表</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <TargetList targets={targets} onTargetsChanged={refreshTargets} onTaskStarted={refreshTasks} />
            <TargetAddRow />
          </div>
        </div>
        <RunningLogsSection tasks={tasks} onRefresh={refreshTasks} />
      </div>
    </>
  );
}
