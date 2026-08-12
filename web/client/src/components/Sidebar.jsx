import { NavLink } from 'react-router-dom';

const items = [
  { to: '/novels', label: 'Novels', dot: 'd-purple' },
  { to: '/targets', label: 'Targets', dot: 'd-coral' },
  { to: '/tasks', label: 'Tasks', dot: 'd-teal' },
  { to: '/outputs', label: 'Outputs', dot: 'd-coral' },
];

export default function Sidebar() {
  return (
    <nav className="sidebar">
      <div className="sidebar-title">Novel Scraper</div>
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          <span className={`nav-dot ${it.dot}`} />
          {it.label}
        </NavLink>
      ))}
    </nav>
  );
}
