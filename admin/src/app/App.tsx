import { Navigate, Route, Routes } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { AdminShell } from "@/components/admin/admin-shell"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { AgentsPage } from "@/pages/AgentsPage"
import { AiOpsPage } from "@/pages/AiOpsPage"
import { CompanyAdminSignupPage } from "@/pages/CompanyAdminSignupPage"
import { DepartmentsPage } from "@/pages/DepartmentsPage"
import { LoginPage } from "@/pages/LoginPage"
import { MemberInviteAcceptPage } from "@/pages/MemberInviteAcceptPage"
import { MemberLoginPage } from "@/pages/MemberLoginPage"
import { MembersPage } from "@/pages/MembersPage"
import { OAuthCallbackPage } from "@/pages/OAuthCallbackPage"
import { OverviewPage } from "@/pages/OverviewPage"
import { MemoriesPage } from "@/pages/MemoriesPage"
import { SettingsPage } from "@/pages/SettingsPage"

type ProtectedProps = {
  children: JSX.Element
}

const Protected = ({ children }: ProtectedProps) => {
  const { session, loading } = useAdminAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="rounded-2xl shadow-soft px-5 py-3 text-sm font-medium text-muted-foreground">Loading admin session...</div>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  return children
}

const DefaultProtectedRoute = () => {
  const { navItems } = useAdminAuth()
  const fallbackPath = navItems[0]?.path ?? "/home"
  return <Navigate to={fallbackPath} replace />
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/desktop-login" element={<MemberLoginPage />} />
        <Route path="/member-login" element={<MemberLoginPage />} />
        <Route path="/signup/company-admin" element={<CompanyAdminSignupPage />} />
        <Route path="/signup/member-invite" element={<MemberInviteAcceptPage />} />
        <Route path="/zoho/callback" element={<OAuthCallbackPage provider="zoho" />} />
        <Route path="/lark/callback" element={<OAuthCallbackPage provider="lark" />} />
        <Route path="/google/callback" element={<OAuthCallbackPage provider="google" />} />

        <Route
          path="/"
          element={
            <Protected>
              <AdminShell />
            </Protected>
          }
        >
          <Route index element={<DefaultProtectedRoute />} />
          <Route path="home" element={<OverviewPage />} />
          <Route path="overview" element={<Navigate to="/home" replace />} />
          <Route path="workspaces" element={<SettingsPage />} />
          <Route path="people" element={<MembersPage />} />
          <Route path="members" element={<Navigate to="/people" replace />} />
          <Route path="departments" element={<DepartmentsPage />} />
          <Route path="ai-ops" element={<AiOpsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="memories" element={<MemoriesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="rbac" element={<Navigate to="/settings?tab=governance" replace />} />
          <Route path="executions" element={<Navigate to="/ai-ops?tab=executions" replace />} />
          <Route path="token-usage" element={<Navigate to="/ai-ops" replace />} />
          <Route path="integrations" element={<Navigate to="/settings?tab=integrations" replace />} />
          <Route path="audit" element={<Navigate to="/settings?tab=audit" replace />} />
          <Route path="controls" element={<Navigate to="/settings?tab=controls" replace />} />
          <Route path="vector-requests" element={<Navigate to="/settings?tab=permissions" replace />} />
          <Route path="ai-models" element={<Navigate to="/ai-ops?tab=models" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster richColors position="top-right" />
    </>
  )
}
