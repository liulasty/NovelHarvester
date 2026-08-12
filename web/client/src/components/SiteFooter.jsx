import { Link } from 'react-router-dom';

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-links">
          <Link to="/" className="footer-link">首页</Link>
          <Link to="/novels" className="footer-link">全部书库</Link>
          <span className="footer-link">关于我们</span>
          <span className="footer-link">帮助中心</span>
          <span className="footer-link">用户协议</span>
          <span className="footer-link">隐私政策</span>
        </div>
        <p className="footer-text">
          墨语书屋 · 致力于提供舒适的阅读体验<br />
          本站内容均来自网络公开资源，仅供阅读交流
        </p>
      </div>
    </footer>
  );
}
