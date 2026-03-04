import { NavLink } from 'react-router-dom';

import type { AdminNavItem } from '../../auth/types';

export const Sidebar = ({ navItems }: { navItems: AdminNavItem[] }) => {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__kicker">EMIAC</span>
        <h1>Control Plane</h1>
      </div>

      <nav className="sidebar__nav">
        {navItems.map((item) => (
          <NavLink
            key={item.id}
            to={item.path}
            className={({ isActive }) =>
              isActive ? 'sidebar__link sidebar__link--active' : 'sidebar__link'
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
};
