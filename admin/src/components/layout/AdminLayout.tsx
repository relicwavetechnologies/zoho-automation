import { Outlet } from 'react-router-dom';

import { useAdminAuth } from '../../auth/AdminAuthProvider';
import { Sidebar } from './Sidebar';

export const AdminLayout = () => {
  const { session, navItems, logout } = useAdminAuth();

  return (
    <div className="layout">
      <Sidebar navItems={navItems} />

      <main className="content">
        <header className="topbar">
          <div>
            <p className="topbar__label">Signed in as</p>
            <h2>{session?.role ?? 'UNKNOWN'}</h2>
          </div>

          <button type="button" onClick={() => void logout()} className="btn btn--ghost">
            Log out
          </button>
        </header>

        <section className="panel">
          <Outlet />
        </section>
      </main>
    </div>
  );
};
