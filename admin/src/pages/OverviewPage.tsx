import { useAdminAuth } from '../auth/AdminAuthProvider';

export const OverviewPage = () => {
  const { session, navItems } = useAdminAuth();

  return (
    <div>
      <h1>Admin Overview</h1>
      <p>
        Role: <strong>{session?.role}</strong>
      </p>
      <p>
        Company Scope: <strong>{session?.companyId ?? 'Global (super-admin)'}</strong>
      </p>
      <p>Navigation is backend-driven. Active capability links: {navItems.length}</p>
    </div>
  );
};
