import TopBar from '../components/TopBar.jsx';
import OutputList from '../components/OutputList.jsx';

export default function OutputsPage() {
  return (
    <>
      <TopBar title="Outputs" right={<span className="muted-hint">白名单目录</span>} />
      <div className="content">
        <OutputList />
      </div>
    </>
  );
}
