import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function NavBar({ onSearch }) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const links = [
    { to: '/', label: '首页' },
    { to: '/novels', label: '全部书库' },
    { to: '/novels?gender=male', label: '男频' },
    { to: '/novels?gender=female', label: '女频' },
  ];

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="navbar-logo" onClick={() => setMenuOpen(false)}>
          <svg viewBox="0 0 28 28" fill="none">
            <rect x="4" y="6" width="20" height="16" rx="3" fill="#8BA4C7" opacity="0.3"/>
            <rect x="6" y="9" width="16" height="2" rx="1" fill="#8BA4C7"/>
            <rect x="6" y="13" width="12" height="2" rx="1" fill="#8BA4C7"/>
            <rect x="6" y="17" width="8" height="2" rx="1" fill="#8BA4C7"/>
          </svg>
          墨语书屋
        </Link>

        <div className="navbar-links">
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={`navbar-link ${location.pathname === link.to ? 'active' : ''}`}
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="navbar-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
          <input
            type="text"
            placeholder="搜索书名、作者..."
            onChange={(e) => onSearch?.(e.target.value)}
          />
        </div>

        <div className="navbar-actions">
          <button className="navbar-btn navbar-btn-outline">登录</button>
          <button className="navbar-btn navbar-btn-primary">注册</button>
        </div>

        {/* Hamburger */}
        <button
          className={`navbar-hamburger ${menuOpen ? 'open' : ''}`}
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="菜单"
        >
          <span /><span /><span />
        </button>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="navbar-mobile">
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={`navbar-mobile-link ${location.pathname === link.to ? 'active' : ''}`}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <div className="navbar-mobile-actions">
            <button className="navbar-btn navbar-btn-outline" style={{ flex: 1 }}>登录</button>
            <button className="navbar-btn navbar-btn-primary" style={{ flex: 1 }}>注册</button>
          </div>
        </div>
      )}
    </nav>
  );
}
