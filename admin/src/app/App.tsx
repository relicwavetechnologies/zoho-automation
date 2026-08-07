import { Link, Navigate, Route, Routes, useParams } from "react-router-dom"
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
import { SettingsShell } from "@/components/admin/settings-shell"
import {
  SettingsModels, SettingsPreferences, SettingsProfile,
} from "@/pages/workspace/screens-settings"
import { NoAccess } from "@/pages/workspace/ui"
import {
  YouAccess, YouApprovals, YouConnections, YouMemory, YouSkills, YouUsage,
} from "@/pages/workspace/screens-you"
import { WorkspaceHome } from "@/pages/workspace/screens-home"
import { AutomationDetail, Automations } from "@/pages/workspace/screens-automations"
import { MailRuleDetail, MailRules } from "@/pages/workspace/screens-mail"
import { MailRuleNew } from "@/pages/workspace/screens-mail-new"
import {
  TeamApprovalPolicy, TeamHome, TeamPeople, TeamRoles, TeamUsage,
} from "@/pages/workspace/screens-team"
import {
  CompanyAiOps, CompanyAudit, CompanyConnections, CompanyDepartments, CompanyGuardrails,
  CompanyHome, CompanyPeople, CompanyPolicy,
} from "@/pages/workspace/screens-company"
import { Artifacts } from "@/pages/workspace/screens-artifacts"
import {
  CompanyDepartmentDetail, CompanyPersonDetail, CompanyRunDetail,
} from "@/pages/workspace/screens-company-detail"

type ProtectedProps = {
  children: JSX.Element
}

const Protected = ({ children }: ProtectedProps) => {
  const { session, loading, unreachable, refresh } = useAdminAuth()

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

  /*
   * Being unable to reach Divo is not the same as being signed out.
   *
   * The provider used to bin the token whenever `/me` failed for any reason,
   * so a backend blip bounced people to /login holding a credential that was
   * still good. It now keeps the token and says so here instead — sending
   * somebody to re-enter their password because a request timed out is the
   * app blaming them for its own outage.
   */
  if (!session && unreachable) {
    return (
      <div className="cur">
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--cur-canvas)" }}>
          <div style={{ textAlign: "center", maxWidth: 380 }}>
            <div className="ws-auth-wait">Cannot reach Divo right now.</div>
            <p className="ws-sub" style={{ marginTop: 10, lineHeight: 1.5 }}>
              You are still signed in — this is the connection, not your account.
            </p>
            <button type="button" className="btn" style={{ marginTop: 16 }} onClick={() => void refresh()}>
              Try again
            </button>
          </div>
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

/* Params have to survive a redirect, so these two cannot be a bare <Navigate>. */
const RedirectPerson = () => {
  const { userId } = useParams()
  return <Navigate to={`/settings/company/people/${userId}`} replace />
}
const RedirectDepartment = () => {
  const { departmentId } = useParams()
  return <Navigate to={`/settings/company/departments/${departmentId}`} replace />
}

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
const MeHome = routed(WorkspaceHome)
const MeApprovals = routed(YouApprovals)
const MeArtifacts = routed(Artifacts)
const MeAutomations = routed(Automations)
const MeAutomationDetail = routed(AutomationDetail)
const MeConnections = routed(YouConnections)
const MeAccess = routed(YouAccess)
const MeMail = routed(MailRules)
const MeMailNew = routed(MailRuleNew)
const MeMailDetail = routed(MailRuleDetail)
const MeSkills = routed(YouSkills)
const MeMemory = routed(YouMemory)
const MeUsage = routed(YouUsage)
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

          {/* ── You — the work surface only ─────────────────
              Everything you *configure* moved to /settings. What stays is what
              you came here to do: ask, decide, and read what came back. */}
          <Route path="me" element={<MeHome />} />
          <Route path="me/mail" element={<MeMail />} />
          {/* `new` before `:ruleId`, or the wizard is read as a rule id. */}
          <Route path="me/mail/new" element={<MeMailNew />} />
          <Route path="me/mail/:ruleId" element={<MeMailDetail />} />
          <Route path="me/approvals" element={<MeApprovals />} />
          <Route path="me/artifacts" element={<MeArtifacts />} />
          <Route path="me/automations" element={<MeAutomations />} />
          <Route path="me/automations/:automationId" element={<MeAutomationDetail />} />

          {/* Where the configuration pages used to live. Kept as redirects
              rather than deleted: these paths are in people's history and in
              links they have already sent each other, and a 404 for a page that
              still exists somewhere else is the rudest possible answer. */}
          <Route path="me/connections" element={<Navigate to="/settings/connections" replace />} />
          <Route path="me/access" element={<Navigate to="/settings/access" replace />} />
          <Route path="me/mail-rules" element={<Navigate to="/me/mail" replace />} />
          <Route path="me/skills" element={<Navigate to="/settings/skills" replace />} />
          <Route path="me/memory" element={<Navigate to="/settings/memory" replace />} />
          <Route path="me/usage" element={<Navigate to="/settings/usage" replace />} />
          <Route path="me/settings" element={<Navigate to="/settings/profile" replace />} />

          {/* ── Your team ─────────────────────────────────── */}
          <Route path="team" element={<RequireScope kind="team"><TeamOverview /></RequireScope>} />
          <Route path="team/people" element={<Navigate to="/settings/team/people" replace />} />
          <Route path="team/roles" element={<Navigate to="/settings/team/roles" replace />} />
          <Route path="team/approvals" element={<Navigate to="/settings/team/approvals" replace />} />
          <Route path="team/usage" element={<Navigate to="/settings/team/usage" replace />} />

          {/* ── Company ─────────────────────────────────────
              The Workspace screens, on the admin API the old pages used. */}
          <Route path="home" element={<RequireScope kind="company"><CompanyHomeRoute /></RequireScope>} />
          {/* Watching the company is work, not configuration, so AI Ops and the
              audit log stay on this side of the door. */}
          <Route path="ai-ops" element={<RequireScope kind="company"><CompanyAiOpsRoute /></RequireScope>} />
          <Route path="ai-ops/runs/:runId" element={<RequireScope kind="company"><CompanyRunDetailRoute /></RequireScope>} />
          <Route path="activity" element={<RequireScope kind="company"><CompanyAuditRoute /></RequireScope>} />

          <Route path="people" element={<Navigate to="/settings/company/people" replace />} />
          <Route path="people/:userId" element={<RedirectPerson />} />
          <Route path="departments" element={<Navigate to="/settings/company/departments" replace />} />
          <Route path="departments/:departmentId" element={<RedirectDepartment />} />
          <Route path="skills" element={<Navigate to="/settings/company/skills" replace />} />
          <Route path="memories" element={<Navigate to="/settings/company/memory" replace />} />
          <Route path="guardrails" element={<Navigate to="/settings/company/guardrails" replace />} />
          <Route path="policy" element={<Navigate to="/settings/company/policy" replace />} />
          <Route path="connections" element={<Navigate to="/settings/company/connections" replace />} />
          <Route path="connections/web-search" element={<Navigate to="/settings/company/connections/web-search" replace />} />
        </Route>

        {/* ── Settings takeover ─────────────────────────────
            Its own layout, not a route inside the app shell — that is what
            makes it a takeover. Scope guards are unchanged: the rail hides a
            group this session cannot reach, and the route still refuses it, so
            a hand-typed URL gets the same answer as the nav. */}
        <Route
          path="/settings"
          element={
            <Protected>
              <SettingsShell />
            </Protected>
          }
        >
          <Route index element={<Navigate to="/settings/profile" replace />} />

          <Route path="profile" element={<SettingsProfile />} />
          <Route path="preferences" element={<SettingsPreferences />} />
          <Route path="models" element={<SettingsModels />} />
          <Route path="connections" element={<MeConnections />} />
          <Route path="access" element={<MeAccess />} />
          <Route path="mail-rules" element={<Navigate to="/me/mail" replace />} />
          <Route path="skills" element={<MeSkills />} />
          <Route path="memory" element={<MeMemory />} />
          <Route path="usage" element={<MeUsage />} />

          <Route path="team/people" element={<RequireScope kind="team"><TeamPeopleRoute /></RequireScope>} />
          <Route path="team/roles" element={<RequireScope kind="team"><TeamRolesRoute /></RequireScope>} />
          <Route path="team/approvals" element={<RequireScope kind="team"><TeamApprovalsRoute /></RequireScope>} />
          <Route path="team/usage" element={<RequireScope kind="team"><TeamUsageRoute /></RequireScope>} />

          <Route path="company/people" element={<RequireScope kind="company"><CompanyPeopleRoute /></RequireScope>} />
          <Route path="company/people/:userId" element={<RequireScope kind="company"><CompanyPersonDetailRoute /></RequireScope>} />
          <Route path="company/people/:userId/connections/:connectionId" element={<RequireScope kind="company"><ConnectionGovernancePage /></RequireScope>} />
          <Route path="company/departments" element={<RequireScope kind="company"><CompanyDepartmentsRoute /></RequireScope>} />
          <Route path="company/departments/:departmentId" element={<RequireScope kind="company"><CompanyDepartmentDetailRoute /></RequireScope>} />
          <Route path="company/skills" element={<RequireScope kind="company"><CompanySkillsRoute /></RequireScope>} />
          <Route path="company/memory" element={<RequireScope kind="company"><MemoriesPage /></RequireScope>} />
          <Route path="company/guardrails" element={<RequireScope kind="company"><CompanyGuardrailsRoute /></RequireScope>} />
          <Route path="company/policy" element={<RequireScope kind="company"><CompanyPolicyRoute /></RequireScope>} />
          <Route path="company/connections" element={<RequireScope kind="company"><CompanyConnectionsRoute /></RequireScope>} />
          <Route path="company/connections/web-search" element={<RequireScope kind="company"><WebSearchPage /></RequireScope>} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster richColors position="top-right" />
    </>
  )
}
