import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import TargetsPage from './pages/TargetsPage.jsx';
import TasksPage from './components/TasksPage.jsx';
import OutputsPage from './pages/OutputsPage.jsx';
import EditPage from './pages/EditPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/targets" replace />} />
        <Route path="/targets" element={<TargetsPage />} />
        <Route path="/targets/new" element={<EditPage />} />
        <Route path="/targets/:id/edit" element={<EditPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/outputs" element={<OutputsPage />} />
      </Route>
    </Routes>
  );
}
