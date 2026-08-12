import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import TargetsPage from './pages/TargetsPage.jsx';
import TasksPage from './components/TasksPage.jsx';
import OutputsPage from './pages/OutputsPage.jsx';
import EditPage from './pages/EditPage.jsx';
import HomePage from './pages/HomePage.jsx';
import NovelsPage from './pages/NovelsPage.jsx';
import NovelDetailPage from './pages/NovelDetailPage.jsx';
import ReaderPage from './pages/ReaderPage.jsx';

export default function App() {
  return (
    <Routes>
      {/* New design - reader facing pages */}
      <Route path="/" element={<HomePage />} />
      <Route path="/novels" element={<NovelsPage />} />
      <Route path="/novels/:id" element={<NovelDetailPage />} />
      <Route path="/reader/:id/:seq" element={<ReaderPage />} />

      {/* Legacy admin pages with sidebar */}
      <Route element={<Layout />}>
        <Route path="/targets" element={<TargetsPage />} />
        <Route path="/targets/new" element={<EditPage />} />
        <Route path="/targets/:id/edit" element={<EditPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/outputs" element={<OutputsPage />} />
      </Route>
    </Routes>
  );
}
