import { Navigate, Route, Routes } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { WorkspaceShell } from "@/components/admin/workspace-shell"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { AiOpsPage } from "@/pages/AiOpsPage"
import { CompanyAdminSignupPage } from "@/pages/CompanyAdminSignupPage"
import { DepartmentsPage } from "@/pages/DepartmentsPage"
import { LoginPage } from "@/pages/LoginPage"
import { MemberInviteAcceptPage } from "@/pages/MemberInviteAcceptPage"
import { MemberLoginPage } from "@/pages/MemberLoginPage"
import { MemberDetailPage } from "@/pages/MemberDetailPage"
import { ConnectionGovernancePage } from "@/pages/ConnectionGovernancePage"
import { CompanyControlsPage } from "@/pages/CompanyControlsPage"
import { MembersPage } from "@/pages/MembersPage"
import { OAuthCallbackPage } from "@/pages/OAuthCallbackPage"
import { OverviewPage } from "@/pages/OverviewPage"
import { GuardrailsPage } from "@/pages/GuardrailsPage"
import { WebSearchPage } from "@/pages/WebSearchPage"
import { RunDetailPage } from "@/pages/RunDetailPage"
import { MemoriesPage } from "@/pages/MemoriesPage"
import { SkillsLabPage } from "@/pages/SkillsLabPage"
import { SettingsPage } from "@/pages/SettingsPage"
import { MockDashboardPage } from "@/pages/MockDashboardPage"
import { routed } from "@/pages/workspace/routes"
import {
  YouAccess, YouApprovals, YouConnections, YouHome, YouMemory, YouSettings, YouSkills, YouUsage,
} from "@/pages/workspace/screens-you"
import {
  TeamApprovalPolicy, TeamHome, TeamPeople, TeamRoles, TeamUsage,
} from "@/pages/workspace/screens-team"
import { CompanyConnections } from "@/pages/workspace/screens-company"
import { ConnectFlow } from "@/pages/workspace/screens-connect"
import { Artifacts } from "@/pages/workspace/screens-artifacts"

type ProtectedProps = {
  children: JSX.Element
}

const Protected = ({ children }: ProtectedProps) => {
  const { session, loading } = useAdminAuth()

  // Painted before anything else on a cold load, so it has to be on the same
  // tokens as the shell — a shadcn-styled flash here undoes the whole point.
  if (loading) {
    return (
      <div className="cur">
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--cur-canvas)" }}>
          <div className="ws-auth-wait">Restoring your session…</div>
        </div>
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

/* Workspace screens, adapted to routes. Still on fixtures; each marks itself. */
const MeHome = routed(YouHome)
const MeApprovals = routed(YouApprovals)
const MeArtifacts = routed(Artifacts)
const MeConnections = routed(YouConnections)
const MeConnectFlow = routed(ConnectFlow)
const MeAccess = routed(YouAccess)
const MeSkills = routed(YouSkills)
const MeMemory = routed(YouMemory)
const MeUsage = routed(YouUsage)
const MeSettings = routed(YouSettings)
const TeamOverview = routed(TeamHome)
const TeamPeopleRoute = routed(TeamPeople)
const TeamRolesRoute = routed(TeamRoles)
const TeamApprovalsRoute = routed(TeamApprovalPolicy)
const TeamUsageRoute = routed(TeamUsage)
const CompanyConnectionsRoute = routed(CompanyConnections)

export function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Standalone spec preview — all three personas on one page, no session. */}
        <Route path="/mock-dashboard" element={<MockDashboardPage />} />
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
              <WorkspaceShell />
            </Protected>
          }
        >
          <Route index element={<DefaultProtectedRoute />} />

          {/* ── You ─────────────────────────────────────────
              Fixtures. Every panel marks its own data state. */}
          <Route path="me" element={<MeHome />} />
          <Route path="me/approvals" element={<MeApprovals />} />
          <Route path="me/artifacts" element={<MeArtifacts />} />
          <Route path="me/connections" element={<MeConnections />} />
          <Route path="me/connections/lark-flow" element={<MeConnectFlow />} />
          <Route path="me/access" element={<MeAccess />} />
          <Route path="me/skills" element={<MeSkills />} />
          <Route path="me/memory" element={<MeMemory />} />
          <Route path="me/usage" element={<MeUsage />} />
          <Route path="me/settings" element={<MeSettings />} />

          {/* ── Your team ───────────────────────────────────
              Fixtures. The manager endpoints are real (see
              /api/desktop/departments/*) — wiring is the next step. */}
          <Route path="team" element={<TeamOverview />} />
          <Route path="team/people" element={<TeamPeopleRoute />} />
          <Route path="team/roles" element={<TeamRolesRoute />} />
          <Route path="team/approvals" element={<TeamApprovalsRoute />} />
          <Route path="team/usage" element={<TeamUsageRoute />} />

          {/* ── Company ─────────────────────────────────────
              Live pages, absorbed into the Workspace shell. */}
          <Route path="home" element={<OverviewPage />} />
          <Route path="people" element={<MembersPage />} />
          <Route path="people/:userId" element={<MemberDetailPage />} />
          <Route path="people/:userId/connections/:connectionId" element={<ConnectionGovernancePage />} />
          <Route path="departments" element={<DepartmentsPage />} />
          <Route path="ai-ops" element={<AiOpsPage />} />
          <Route path="ai-ops/runs/:runId" element={<RunDetailPage />} />
          <Route path="skills" element={<SkillsLabPage />} />
          <Route path="memories" element={<MemoriesPage />} />
          <Route path="guardrails" element={<GuardrailsPage />} />
          {/* Company ceiling — capability governance today; the full tool ceiling
              matrix from the Workspace spec supersedes this. */}
          <Route path="policy" element={<CompanyControlsPage />} />
          {/* Connections — fixture overview; web search is the one real company
              connection surface that exists today. */}
          <Route path="connections" element={<CompanyConnectionsRoute />} />
          <Route path="connections/web-search" element={<WebSearchPage />} />
          {/* Renamed: this page is an audit-log viewer, not settings. */}
          <Route path="activity" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster richColors position="top-right" />
    </>
  )
}
