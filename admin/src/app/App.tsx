import { Link, Navigate, Route, Routes } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { WorkspaceShell } from "@/components/admin/workspace-shell"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import type { ScopeKind } from "@/auth/types"
import { CompanyAdminSignupPage } from "@/pages/CompanyAdminSignupPage"
import { LoginPage } from "@/pages/LoginPage"
import { MemberInviteAcceptPage } from "@/pages/MemberInviteAcceptPage"
import { ConnectionGovernancePage } from "@/pages/ConnectionGovernancePage"
import { OAuthCallbackPage } from "@/pages/OAuthCallbackPage"
import { WebSearchPage } from "@/pages/WebSearchPage"
import { MemoriesPage } from "@/pages/MemoriesPage"
import { CompanySkills } from "@/pages/workspace/screens-company-skills"
import { LinkLarkPage } from "@/pages/LinkLarkPage"
import { routed } from "@/pages/workspace/routes"
import { NoAccess } from "@/pages/workspace/ui"
import {
  YouAccess, YouApprovals, YouConnections, YouHome, YouMemory, YouSettings, YouSkills, YouUsage,
} from "@/pages/workspace/screens-you"
import {
  TeamApprovalPolicy, TeamHome, TeamPeople, TeamRoles, TeamUsage,
} from "@/pages/workspace/screens-team"
import {
  CompanyAiOps, CompanyAudit, CompanyConnections, CompanyDepartments, CompanyGuardrails,
  CompanyHome, CompanyPeople, CompanyPolicy,
} from "@/pages/workspace/screens-company"
import { ConnectFlow } from "@/pages/workspace/screens-connect"
import { Artifacts } from "@/pages/workspace/screens-artifacts"
import {
  CompanyDepartmentDetail, CompanyPersonDetail, CompanyRunDetail,
} from "@/pages/workspace/screens-company-detail"

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

  return (
    <div className="page">
      <NoAccess
        what={kind === "team" ? "a team view" : "the company view"}
        who={kind === "team"
          ? "This is a manager's view of a department, and you do not lead one. Whoever holds the Manager role in a team can see it."
          : "This is the company-wide view, limited to company admins. Your own workspace and any team you lead are still yours."}
        action={<Link className="btn" to="/me">Go to your workspace</Link>}
      />
    </div>
  )
}

/* Workspace screens, adapted to routes. Live, apart from the few panels
   that mark themselves as sample data. */
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
const CompanyPolicyRoute = routed(CompanyPolicy)
const CompanyRunDetailRoute = routed(CompanyRunDetail)
const CompanyPersonDetailRoute = routed(CompanyPersonDetail)
const CompanySkillsRoute = routed(CompanySkills)
const CompanyDepartmentDetailRoute = routed(CompanyDepartmentDetail)

export function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Where the Lark sign-in card lands. Public on purpose — it sends you
            to /login itself and returns here, so the nonce survives the trip. */}
        <Route path="/link/lark" element={<LinkLarkPage />} />
        {/* Standalone spec preview — all three personas on one page, no session. */}
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
              Live, apart from skills, memory and artifacts — those panels
              carry their own marker. */}
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
          <Route path="people/:userId" element={<RequireScope kind="company"><CompanyPersonDetailRoute /></RequireScope>} />
          <Route path="people/:userId/connections/:connectionId" element={<RequireScope kind="company"><ConnectionGovernancePage /></RequireScope>} />
          <Route path="departments" element={<RequireScope kind="company"><CompanyDepartmentsRoute /></RequireScope>} />
          <Route path="departments/:departmentId" element={<RequireScope kind="company"><CompanyDepartmentDetailRoute /></RequireScope>} />
          <Route path="ai-ops" element={<RequireScope kind="company"><CompanyAiOpsRoute /></RequireScope>} />
          <Route path="ai-ops/runs/:runId" element={<RequireScope kind="company"><CompanyRunDetailRoute /></RequireScope>} />
          <Route path="skills" element={<RequireScope kind="company"><CompanySkillsRoute /></RequireScope>} />
          <Route path="memories" element={<RequireScope kind="company"><MemoriesPage /></RequireScope>} />
          <Route path="guardrails" element={<RequireScope kind="company"><CompanyGuardrailsRoute /></RequireScope>} />
          <Route path="policy" element={<RequireScope kind="company"><CompanyPolicyRoute /></RequireScope>} />
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
