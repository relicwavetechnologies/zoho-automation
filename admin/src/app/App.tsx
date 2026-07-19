import { Navigate, Route, Routes } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { AdminShell } from "@/components/admin/admin-shell"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { AgentsPage } from "@/pages/AgentsPage"
import { AiOpsPage } from "@/pages/AiOpsPage"
import { AiProvidersPage } from "@/pages/AiProvidersPage"
import { CompanyAdminSignupPage } from "@/pages/CompanyAdminSignupPage"
import { DepartmentsPage } from "@/pages/DepartmentsPage"
import { LoginPage } from "@/pages/LoginPage"
import { MemberInviteAcceptPage } from "@/pages/MemberInviteAcceptPage"
import { MemberLoginPage } from "@/pages/MemberLoginPage"
import { MemberDetailPage } from "@/pages/MemberDetailPage"
import { MembersPage } from "@/pages/MembersPage"
import { OAuthCallbackPage } from "@/pages/OAuthCallbackPage"
import { OverviewPage } from "@/pages/OverviewPage"
import { GuardrailsPage } from "@/pages/GuardrailsPage"
import { WebSearchPage } from "@/pages/WebSearchPage"
import { RunDetailPage } from "@/pages/RunDetailPage"
import { MemoriesPage } from "@/pages/MemoriesPage"
import { SkillsLabPage } from "@/pages/SkillsLabPage"
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

/**
 * Padding/rhythm wrapper for the not-yet-redesigned shadcn pages. The Cursor
 * shell's scroll area has no padding (designed pages self-pad via `.page`), so
 * these legacy pages get their old `space-y-5 p-6` container here until they're
 * ported to the mock design too.
 */
const Legacy = ({ children }: { children: JSX.Element }) => <div className="space-y-5 p-6">{children}</div>

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
          <Route path="workspaces" element={<Legacy><SettingsPage /></Legacy>} />
          <Route path="people" element={<MembersPage />} />
          <Route path="people/:userId" element={<MemberDetailPage />} />
          <Route path="members" element={<Navigate to="/people" replace />} />
          <Route path="departments" element={<Legacy><DepartmentsPage /></Legacy>} />
          <Route path="ai-ops" element={<AiOpsPage />} />
          <Route path="ai-ops/runs/:runId" element={<RunDetailPage />} />
          <Route path="skills" element={<SkillsLabPage />} />
          <Route path="guardrails" element={<GuardrailsPage />} />
          <Route path="web-search" element={<WebSearchPage />} />
          <Route path="ai-providers" element={<Legacy><AiProvidersPage /></Legacy>} />
          <Route path="agents" element={<Legacy><AgentsPage /></Legacy>} />
          <Route path="memories" element={<Legacy><MemoriesPage /></Legacy>} />
          <Route path="settings" element={<Legacy><SettingsPage /></Legacy>} />
          <Route path="rbac" element={<Navigate to="/settings" replace />} />
          <Route path="executions" element={<Navigate to="/ai-ops?tab=executions" replace />} />
          <Route path="token-usage" element={<Navigate to="/ai-ops" replace />} />
          <Route path="integrations" element={<Navigate to="/settings" replace />} />
          <Route path="audit" element={<Navigate to="/settings" replace />} />
          <Route path="controls" element={<Navigate to="/settings" replace />} />
          <Route path="vector-requests" element={<Navigate to="/settings" replace />} />
          <Route path="ai-models" element={<Navigate to="/ai-ops?tab=models" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster richColors position="top-right" />
    </>
  )
}
