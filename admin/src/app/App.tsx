import { Navigate, Route, Routes } from 'react-router-dom';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { AuditLogsPage } from '../pages/AuditLogsPage';
import { AdminLayout } from '../components/layout/AdminLayout';
import { ControlsPage } from '../pages/ControlsPage';
import { LoginPage } from '../pages/LoginPage';
import { MembersPage } from '../pages/MembersPage';
import { OverviewPage } from '../pages/OverviewPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { RbacPage } from '../pages/RbacPage';

const Protected = ({ children }: { children: JSX.Element }) => {
  const { session, loading } = useAdminAuth();

  if (loading) {
    return <div className="loading">Loading session...</div>;
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return children;
};

export const App = () => {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/"
        element={
          <Protected>
            <AdminLayout />
          </Protected>
        }
      >
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="companies" element={<PlaceholderPage title="Companies" />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="rbac" element={<RbacPage />} />
        <Route path="audit" element={<AuditLogsPage />} />
        <Route path="controls" element={<ControlsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};
