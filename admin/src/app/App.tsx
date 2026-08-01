import { Navigate, Route, Routes } from "react-router-dom"
import { EmptyState } from "@/components/admin/empty-state"
import { Toaster } from "@/components/ui/sonner"
import { WorkspaceShell } from "@/components/admin/workspace-shell"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import type { ScopeKind } from "@/auth/types"
import { CompanyAdminSignupPage } from "@/pages/CompanyAdminSignupPage"
import { LoginPage } from "@/pages/LoginPage"
import { MemberInviteAcceptPage } from "@/pages/MemberInviteAcceptPage"
import { MemberDetailPage } from "@/pages/MemberDetailPage"
import { ConnectionGovernancePage } from "@/pages/ConnectionGovernancePage"
import { CompanyControlsPage } from "@/pages/CompanyControlsPage"
import { OAuthCallbackPage } from "@/pages/OAuthCallbackPage"
import { WebSearchPage } from "@/pages/WebSearchPage"
import { RunDetailPage } from "@/pages/RunDetailPage"
import { MemoriesPage } from "@/pages/MemoriesPage"
import { SkillsLabPage } from "@/pages/SkillsLabPage"
import { MockDashboardPage } from "@/pages/MockDashboardPage"
import { routed } from "@/pages/workspace/routes"
import {
  YouAccess, YouApprovals, YouConnections, YouHome, YouMemory, YouSettings, YouSkills, YouUsage,
} from "@/pages/workspace/screens-you"
import {
  TeamApprovalPolicy, TeamHome, TeamPeople, TeamRoles, TeamUsage,
} from "@/pages/workspace/screens-team"
import {
  CompanyAiOps, CompanyAudit, CompanyConnections, CompanyDepartments, CompanyGuardrails,
  CompanyHome, CompanyPeople,
} from "@/pages/workspace/screens-company"
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

/**
 * Where "/" lands. Everyone has a You scope, so that is the honest default —
 * an admin gets the Company scope from the switcher rather than being dropped
 * into it, because the first thing most people want is their own workspace.
 */
const DefaultProtectedRoute = () => <Navigate to="/me" replace />

/**
 * Guards a scope this person may not have.
 *
 * Deep links matter here: someone forwards a `/team/people` URL to a colleague
 * who leads nothing, and silently redirecting to `/me` reads like the app is
 * broken. It says what happened instead.
 */
const RequireScope = ({ kind, children }: { kind: ScopeKind; children: JSX.Element }) => {
  const { scopes } = useAdminAuth()
  if (scopes.some((scope) => scope.kind === kind)) return children

  const reason = kind === "team"
    ? "This is a manager's view of a department. You do not lead one."
    : "This is the company-wide view. It is limited to company admins."

  return (
    <div className="page">
      <EmptyState title="You do not have access to this" description={reason} />
    </div>
  )
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
const CompanyHomeRoute = routed(CompanyHome)
const CompanyPeopleRoute = routed(CompanyPeople)
const CompanyDepartmentsRoute = routed(CompanyDepartments)
const CompanyAiOpsRoute = routed(CompanyAiOps)
const CompanyGuardrailsRoute = routed(CompanyGuardrails)
const CompanyAuditRoute = routed(CompanyAudit)

export function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Standalone spec preview — all three personas on one page, no session. */}
        <Route path="/mock-dashboard" element={<MockDashboardPage />} />
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

          {/* ── Your team ─────────────────────────────────── */}
          <Route path="team" element={<RequireScope kind="team"><TeamOverview /></RequireScope>} />
          <Route path="team/people" element={<RequireScope kind="team"><TeamPeopleRoute /></RequireScope>} />
          <Route path="team/roles" element={<RequireScope kind="team"><TeamRolesRoute /></RequireScope>} />
          <Route path="team/approvals" element={<RequireScope kind="team"><TeamApprovalsRoute /></RequireScope>} />
          <Route path="team/usage" element={<RequireScope kind="team"><TeamUsageRoute /></RequireScope>} />

          {/* ── Company ─────────────────────────────────────
              The Workspace screens, on the admin API the old pages used. */}
          <Route path="home" element={<RequireScope kind="company"><CompanyHomeRoute /></RequireScope>} />
          <Route path="people" element={<RequireScope kind="company"><CompanyPeopleRoute /></RequireScope>} />
          <Route path="people/:userId" element={<RequireScope kind="company"><MemberDetailPage /></RequireScope>} />
          <Route path="people/:userId/connections/:connectionId" element={<RequireScope kind="company"><ConnectionGovernancePage /></RequireScope>} />
          <Route path="departments" element={<RequireScope kind="company"><CompanyDepartmentsRoute /></RequireScope>} />
          <Route path="ai-ops" element={<RequireScope kind="company"><CompanyAiOpsRoute /></RequireScope>} />
          <Route path="ai-ops/runs/:runId" element={<RequireScope kind="company"><RunDetailPage /></RequireScope>} />
          <Route path="skills" element={<RequireScope kind="company"><SkillsLabPage /></RequireScope>} />
          <Route path="memories" element={<RequireScope kind="company"><MemoriesPage /></RequireScope>} />
          <Route path="guardrails" element={<RequireScope kind="company"><CompanyGuardrailsRoute /></RequireScope>} />
          {/* Company ceiling — still the capability-governance screen; the full
              tool ceiling matrix is the next thing to wire. */}
          <Route path="policy" element={<RequireScope kind="company"><CompanyControlsPage /></RequireScope>} />
          {/* Connections — fixture overview; web search is the one real company
              connection surface that exists today. */}
          <Route path="connections" element={<RequireScope kind="company"><CompanyConnectionsRoute /></RequireScope>} />
          <Route path="connections/web-search" element={<RequireScope kind="company"><WebSearchPage /></RequireScope>} />
          <Route path="activity" element={<RequireScope kind="company"><CompanyAuditRoute /></RequireScope>} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster richColors position="top-right" />
    </>
  )
}
