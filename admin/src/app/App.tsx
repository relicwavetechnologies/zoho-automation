import { Navigate, Route, Routes } from 'react-router-dom';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { AdminLayout } from '../components/layout/AdminLayout';
import { DepartmentsPage } from '../pages/DepartmentsPage';
import { GoogleOauthCallbackPage } from '../pages/GoogleOauthCallbackPage';
import { LarkOauthCallbackPage } from '../pages/LarkOauthCallbackPage';
import { CompanyAdminSignupPage } from '../pages/CompanyAdminSignupPage';
import { LoginPage } from '../pages/LoginPage';
import { MemberInviteAcceptPage } from '../pages/MemberInviteAcceptPage';
import { MemberLoginPage } from '../pages/MemberLoginPage';
import { MembersPage } from '../pages/MembersPage';
import { OverviewPage } from '../pages/OverviewPage';
import { AiOpsPage } from '../pages/AiOpsPage';
import { AgentsPage } from '../pages/AgentsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { ZohoOauthCallbackPage } from '../pages/ZohoOauthCallbackPage';
import { Toaster } from '../components/ui/toaster';

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

const DefaultProtectedRoute = () => {
  const { navItems } = useAdminAuth()
  const fallbackPath = navItems[0]?.path ?? '/home'
  return <Navigate to={fallbackPath} replace />
}

export const App = () => {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/desktop-login" element={<MemberLoginPage />} />
        <Route path="/member-login" element={<MemberLoginPage />} />
        <Route path="/signup/company-admin" element={<CompanyAdminSignupPage />} />
        <Route path="/signup/member-invite" element={<MemberInviteAcceptPage />} />

        <Route
          path="/"
          element={
            <Protected>
              <AdminLayout />
            </Protected>
          }
        >
          <Route index element={<DefaultProtectedRoute />} />
          <Route path="home" element={<OverviewPage />} />
          <Route path="overview" element={<Navigate to="/home" replace />} />
          <Route path="workspaces" element={<PlaceholderPage title="Workspaces" />} />
          <Route path="people" element={<MembersPage />} />
          <Route path="members" element={<Navigate to="/people" replace />} />
          <Route path="rbac" element={<Navigate to="/settings?tab=governance" replace />} />
          <Route path="executions" element={<Navigate to="/ai-ops?tab=executions" replace />} />
          <Route path="token-usage" element={<Navigate to="/ai-ops?tab=token-usage" replace />} />
          <Route path="integrations" element={<Navigate to="/settings?tab=integrations" replace />} />
          <Route path="audit" element={<Navigate to="/settings?tab=audit" replace />} />
          <Route path="controls" element={<Navigate to="/settings?tab=controls" replace />} />
          <Route path="vector-requests" element={<Navigate to="/settings?tab=share-requests" replace />} />
          <Route path="ai-models" element={<Navigate to="/ai-ops?tab=models" replace />} />
          <Route path="departments" element={<DepartmentsPage />} />
          <Route path="ai-ops" element={<AiOpsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="lark/callback" element={<LarkOauthCallbackPage />} />
          <Route path="google/callback" element={<GoogleOauthCallbackPage />} />
          <Route path="zoho/callback" element={<ZohoOauthCallbackPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  );
};
