import { Suspense, lazy, useEffect, useState } from "react"
import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { WorkspaceShell } from "@/components/admin/workspace-shell"
import { MailShell } from "@/components/admin/mail-shell"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { isMailSurface } from "@/auth/surface"
import type { ScopeKind } from "@/auth/types"
import { CompanyAdminSignupPage } from "@/pages/CompanyAdminSignupPage"
import { Landing } from "@/pages/landing/landing"
import { LoginPage } from "@/pages/LoginPage"
import { MemberInviteAcceptPage } from "@/pages/MemberInviteAcceptPage"
import { ConnectionGovernancePage } from "@/pages/ConnectionGovernancePage"
import { OAuthCallbackPage } from "@/pages/OAuthCallbackPage"
import { WebSearchPage } from "@/pages/WebSearchPage"
import { MemoriesPage } from "@/pages/MemoriesPage"
import { CompanySkills } from "@/pages/workspace/screens-company-skills"
import { LinkLarkPage } from "@/pages/LinkLarkPage"
import { MailPreview } from "@/pages/preview/MailPreview"
import { DecisionsPreview } from "@/pages/workspace/decisions/preview"
import { ApprovalForecastPreview } from "@/pages/workspace/approvals/preview"
import { ApprovalsScreen } from "@/pages/workspace/approvals/screen"
import { routed } from "@/pages/workspace/routes"
import { SettingsShell } from "@/components/admin/settings-shell"
import { SettingsPreferences } from "@/pages/workspace/screens-settings"
import { SettingsProfile } from "@/pages/workspace/screens-profile"
import { NoAccess } from "@/pages/workspace/ui"
import {
  YouConnections, YouMemory, YouUsage,
} from "@/pages/workspace/screens-you"
import { WorkspaceHome } from "@/pages/workspace/screens-home"
import { WorkspaceChat } from "@/pages/workspace/screens-chat"
import { MailRuleDetail, MailRules } from "@/pages/workspace/screens-mail"
import { MailRuleEdit, MailRuleNew } from "@/pages/workspace/screens-mail-new"
import { MailSettings } from "@/pages/workspace/screens-mail-settings"
import { MailCaught } from "@/pages/workspace/screens-mail-caught"
import { MailHome } from "@/pages/workspace/screens-mail-home"
import {
  TeamHome, TeamPeople, TeamRoles, TeamUsage,
} from "@/pages/workspace/screens-team"
import {
  CompanyAiOps, CompanyAudit, CompanyDepartments, CompanyGuardrails,
  CompanyHome, CompanyPeople,
} from "@/pages/workspace/screens-company"
/*
 * Split out, alone among the screens.
 *
 * It draws with React Flow, which is by a distance the heaviest thing the app
 * depends on — and it was in the one bundle every page shares, so opening Mail
 * downloaded a graph library that Mail has no use for. Every other screen is
 * ordinary React and costs little enough to keep eager; this one pays for a
 * split several times over, and it is a page most people never open.
 */
const AgentMap = lazy(() =>
  import("@/pages/workspace/screens-agents").then((m) => ({ default: m.AgentMap })))
import {
  CompanyDepartmentDetail, CompanyPersonDetail, CompanyRunDetail,
} from "@/pages/workspace/screens-company-detail"

type ProtectedProps = {
  children: JSX.Element
}

/**
 * Divo is unreachable, and you are not.
 *
 * The screen this replaces was right about the important thing — a backend
 * blip is not a sign-out, and binning a good token over one would be the app
 * blaming you for its own outage. What it got wrong was leaving you there.
 * "Try again" was the only control, so an outage that lasted longer than your
 * patience was a room with no door: you could not sign out, could not reach
 * /login, could not switch accounts. A dev database tunnel dropping is enough
 * to produce it, and so is any real API outage in production.
 *
 * Two changes. It now retries on its own, backing off, so a connection that
 * comes back lets you in without a click. And there is a way out, because the
 * one thing a person stuck here always has is the ability to start over.
 */
function Unreachable({ retry }: { retry: () => Promise<void> }) {
  const { logout } = useAdminAuth()
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)

  // 2s, 4s, 8s, 16s, then every 30s. Frequent while an outage is most likely
  // to be a blip, then slow enough not to hammer a backend that is genuinely
  // down — and never stopping, because the whole point is to recover unattended.
  const waitMs = Math.min(2000 * 2 ** attempt, 30_000)

  useEffect(() => {
    const timer = setTimeout(() => {
      setBusy(true)
      void retry().finally(() => {
        setBusy(false)
        setAttempt((n) => n + 1)
      })
    }, waitMs)
    return () => clearTimeout(timer)
  }, [retry, waitMs, attempt])

  return (
    <div className="cur">
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--cur-canvas)" }}>
        <div style={{ textAlign: "center", maxWidth: 380 }}>
          <div className="ws-auth-wait">Cannot reach Divo right now.</div>
          <p className="ws-sub" style={{ marginTop: 10, lineHeight: 1.5 }}>
            You are still signed in — this is the connection, not your account.
            {attempt > 0 ? ' Divo keeps trying on its own.' : ''}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
            <button type="button" className="btn primary" disabled={busy} onClick={() => { setAttempt(0); setBusy(true); void retry().finally(() => setBusy(false)) }}>
              {busy ? 'Trying…' : 'Try again'}
            </button>
            {/*
              The door. `logout` drops the token locally whether or not the
              server can be told, so this works in exactly the situation that
              makes it necessary.
            */}
            <button type="button" className="btn" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  )
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
    return <Unreachable retry={refresh} />
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  return children
}

/**
 * Which product this session is handed.
 *
 * One build, two audiences. Somebody who administers nothing gets Divo Mail —
 * three rows and a settings page — and everybody else gets the workspace. The
 * test is `surfaceFor`, derived from the same `scopes` array the switcher and
 * the settings rail already run on, so there is one answer rather than three.
 */
const AppShell = () => {
  const { scopes } = useAdminAuth()
  return isMailSurface(scopes) ? <MailShell /> : <WorkspaceShell />
}

/**
 * `/` is the one route in this app that has to mean something to a stranger.
 *
 * Everything else can reasonably answer "sign in first". The front door cannot:
 * it used to bounce anybody without a session straight to `/login`, so the
 * first thing Divo ever showed a new person was a password field. A product
 * whose whole proposition is "ask it in words" opening on a form contradicts
 * itself before it has said anything.
 *
 * So the gate sits here rather than inside `<Protected>`, and only for the
 * index path. `/me`, `/chat`, `/team` and the rest are as protected as they
 * ever were — a stranger who deep-links into one still gets `/login`, which is
 * right, because there is nothing on those pages to show somebody with no
 * account.
 *
 * `loading` and `unreachable` both fall through to `<Protected>` on purpose.
 * Being unable to reach Divo is not being signed out, and neither is a session
 * that has not finished restoring; showing either person a signup landing would
 * be the app forgetting who they are and then inviting them to register.
 */
const RootGate = () => {
  const { session, loading, unreachable } = useAdminAuth()
  const { pathname } = useLocation()
  if (!session && !loading && !unreachable && pathname === "/") return <Landing />
  return (
    <Protected>
      <AppShell />
    </Protected>
  )
}

/**
 * Refuses a workspace feature to somebody on the mail surface.
 *
 * Approvals, Automations and Things Divo made are not simplified away for
 * members — they are genuinely other features, and a member who follows a link
 * to one should be told that rather than bounced somewhere else. A silent
 * redirect from a URL a colleague sent them reads as the app being broken.
 *
 * `/` itself is the exception and is a redirect rather than a refusal: it
 * means "your workspace", and for a member their workspace is their mail.
 */
const RequireWorkspace = ({ children }: { children: JSX.Element }) => {
  const { scopes } = useAdminAuth()
  if (!isMailSurface(scopes)) return children

  return (
    <div className="page">
      <NoAccess
        what="this part of Divo"
        who="Your Divo is set up for mail. Whoever administers Divo where you work can open the rest of it up."
        action={<Link className="btn" to="/me/mail">Go to your rules</Link>}
      />
    </div>
  )
}

/** A member's settings live inside the mail app, not behind the takeover. */
const SettingsEntry = () => {
  const { scopes } = useAdminAuth()
  if (isMailSurface(scopes)) return <Navigate to="/me/settings" replace />
  return <SettingsShell />
}

const MeHomeEntry = () => {
  const { scopes } = useAdminAuth()
  if (isMailSurface(scopes)) return <Navigate to="/me/mail" replace />
  return <MeHome />
}

/**
 * `/me/settings` is the member's one settings page, and on the workspace
 * surface it is what it has always been: a redirect into the takeover. Kept as
 * one path rather than two so a link to "your settings" means the same thing
 * whoever opens it.
 */
const MeSettingsEntry = () => {
  const { scopes } = useAdminAuth()
  if (isMailSurface(scopes)) return <MailSettings />
  return <Navigate to="/settings/profile" replace />
}

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
 * who leads nothing, and silently redirecting to `/` reads like the app is
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
        action={<Link className="btn" to="/">Go to your workspace</Link>}
      />
    </div>
  )
}

/* Workspace screens, adapted to routes. Live, apart from the few panels
   that mark themselves as sample data. */
/* `full` because Home owns its own scroller now. The landing has to be exactly
   one screenful, and "one screenful" is only knowable inside a box with a
   definite height — measured against the shell's padding it is always a topbar
   and 30 pixels out. See the hero note in `screens-home.tsx`. */
const MeHome = routed(WorkspaceHome, { full: true })
const MeChat = routed(WorkspaceChat, { full: true })
const MeConnections = routed(YouConnections)
const MeMail = routed(MailRules)
const MeMailNew = routed(MailRuleNew)
const MeMailEdit = routed(MailRuleEdit)
const MeMailDetail = routed(MailRuleDetail)
const MeMemory = routed(YouMemory)
const MeUsage = routed(YouUsage)
const TeamOverview = routed(TeamHome)
const TeamPeopleRoute = routed(TeamPeople)
const TeamRolesRoute = routed(TeamRoles)
const TeamUsageRoute = routed(TeamUsage)
const CompanyHomeRoute = routed(CompanyHome)
const CompanyPeopleRoute = routed(CompanyPeople)
const CompanyDepartmentsRoute = routed(CompanyDepartments)
const CompanyAiOpsRoute = routed(CompanyAiOps)
const CompanyAgentsRoute = routed(AgentMap)
const CompanyGuardrailsRoute = routed(CompanyGuardrails)
const CompanyAuditRoute = routed(CompanyAudit)
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

        {/*
          Divo Mail — the packaged member product, as a clickable proposal.

          Fixture-driven and unauthenticated. It shares nothing with the routes
          below except the design tokens: its own shell, its own nav, its own
          five screens. That separation is the argument it is making — a member
          handed mail should not be able to tell there is a workspace, an
          approvals queue or a company scope behind it.

          Development builds only, and that is not tidiness. Being outside
          `<Protected>` meant anyone who could reach this origin got the whole
          thing signed out, and its fixtures are not anonymous — they carry real
          colleagues' addresses and a real outside counsel's domain, written to
          make the pitch feel true. A prototype is worth showing to the people
          you choose; it is not worth publishing.
        */}
        {import.meta.env.DEV ? (
          <Route path="/preview/mail/*" element={<MailPreview />} />
        ) : null}

        {/* Every decision variant, side by side, with no run needed to raise one.
            Development only for the same reason as the mail preview above: it
            sits outside `<Protected>`, and its fixtures read like real customer
            work because that is the only way the layout tells the truth. */}
        {import.meta.env.DEV ? (
          <Route path="/preview/decisions" element={<DecisionsPreview />} />
        ) : null}

        {/* One policy seen by three people, because the confusion is not what
            the policy says — it is that the same policy produces three
            different lived experiences and nothing said so. */}
        {import.meta.env.DEV ? (
          <Route path="/preview/approvals" element={<ApprovalForecastPreview />} />
        ) : null}

        <Route path="/" element={<RootGate />}>
          {/* Home is the composer, and the composer is the front page. It used
              to be one redirect further in, at `/me`, which made the address of
              the thing everybody opens Divo to do a private-looking sub-path
              and left `/` as a bounce with nothing on it. */}
          <Route index element={<MeHomeEntry />} />

          {/* ── You — the work surface only ─────────────────
              Everything you *configure* moved to /settings. What stays is what
              you came here to do: ask, decide, and read what came back. */}
          {/* `/me` was here. Its children were never nested under it — they are
              siblings below, `me/mail` and the rest — so moving Home up to `/`
              retires this one path and leaves them exactly where they were. */}
          <Route path="me" element={<Navigate to="/" replace />} />
          {/* `/chat` mints a thread id and redirects onto it, so every
              conversation is somewhere you can be sent, reload into, and keep
              open in a second tab beside another one. */}
          <Route path="chat" element={<RequireWorkspace><MeChat /></RequireWorkspace>} />
          <Route path="chat/:threadId" element={<RequireWorkspace><MeChat /></RequireWorkspace>} />
          <Route path="me/mail" element={<MeMail />} />
          {/* The member's settings page. Inside the app rather than behind the
              Settings takeover, because for a member it is one screen and the
              takeover exists to hold four groups of them. */}
          <Route path="me/settings" element={<MeSettingsEntry />} />
          {/* `new` before `:ruleId`, or the wizard is read as a rule id. */}
          <Route path="me/mail/new" element={<MeMailNew />} />
          <Route path="me/mail/:ruleId" element={<MeMailDetail />} />
          {/* The same form as `new`, entered over an existing rule. Kept as its
              own path rather than a mode flag on the detail page so an edit is
              somewhere you can be sent, and somewhere you can leave. */}
          <Route path="me/mail/:ruleId/edit" element={<MeMailEdit />} />
          {/* Not under `me/mail`, because it is not about one rule and not a
              step in making one — it is the other half of the same question. */}
          <Route path="me/home" element={<MailHome />} />
          <Route path="me/caught" element={<MailCaught />} />
          {/* Approvals is retired, and the thread is what replaced it.

              It was live, so this is the one removal that moved a capability
              rather than deleting a mock. A decision raised in a web chat is
              answered where it was asked — the composer swaps itself for the
              same card, which is why one renderer was worth having. A decision
              raised from Lark carries no thread at all, and the Lark card it
              was already sent to is where it is answered. Home still lists
              everything waiting on you either way. */}
          <Route path="me/approvals" element={<Navigate to="/" replace />} />
          {/* "Things Divo made" is retired. It was a hardcoded list of four
              invented documents standing in front of a real feature: a run
              genuinely writes an artifact, `GET /api/artifacts` lists them, and
              two surfaces already show the real ones — the panel beside the
              chat and the "Made" band on Home. A fake index of a real thing is
              worse than no index. */}
          <Route path="me/artifacts" element={<Navigate to="/" replace />} />
          {/* Automations is retired: a complete backend domain with no door
              facing a browser. No HTTP route reaches
              `ScheduledWorkflowControlService`, and its `create()` refuses any
              channel that is not desktop or lark — so the page showed four
              invented rows above controls that were every one of them
              disabled. It comes back when a route does. */}
          <Route path="me/automations" element={<Navigate to="/" replace />} />
          <Route path="me/automations/:automationId" element={<Navigate to="/" replace />} />

          {/* Where the configuration pages used to live. Kept as redirects
              rather than deleted: these paths are in people's history and in
              links they have already sent each other, and a 404 for a page that
              still exists somewhere else is the rudest possible answer. */}
          <Route path="me/connections" element={<Navigate to="/settings/connections" replace />} />
          {/* Access, Skills and Models were retired. Connected apps is the
              nearest surviving answer to "what can Divo do for me, and with
              what", so every path that used to reach one of them lands there
              rather than on a 404. */}
          <Route path="me/access" element={<Navigate to="/settings/connections" replace />} />
          <Route path="me/mail-rules" element={<Navigate to="/me/mail" replace />} />
          <Route path="me/skills" element={<Navigate to="/settings/connections" replace />} />
          <Route path="me/memory" element={<Navigate to="/settings/memory" replace />} />
          <Route path="me/usage" element={<Navigate to="/settings/usage" replace />} />
          {/* `me/settings` used to redirect into the takeover. It is a real page
              now — see above — and on the workspace surface `SettingsEntry`
              sends it back out again. */}

          {/* ── Your team ─────────────────────────────────── */}
          <Route path="team" element={<RequireScope kind="team"><TeamOverview /></RequireScope>} />
          <Route path="team/people" element={<Navigate to="/settings/team/people" replace />} />
          <Route path="team/roles" element={<Navigate to="/settings/team/roles" replace />} />
          <Route path="team/approvals" element={<Navigate to="/settings/approvals" replace />} />
          <Route path="team/usage" element={<Navigate to="/settings/team/usage" replace />} />

          {/* ── Company ─────────────────────────────────────
              The Workspace screens, on the admin API the old pages used. */}
          <Route path="home" element={<RequireScope kind="company"><CompanyHomeRoute /></RequireScope>} />
          {/* Watching the company is work, not configuration, so AI Ops and the
              audit log stay on this side of the door. */}
          <Route path="ai-ops" element={<RequireScope kind="company"><CompanyAiOpsRoute /></RequireScope>} />
          <Route path="ai-ops/runs/:runId" element={<RequireScope kind="company"><CompanyRunDetailRoute /></RequireScope>} />
          {/* Who may run what, as a map rather than a matrix. Work, not
              configuration — it answers a question rather than changing
              anything, so it stays on this side of the Settings door. */}
          {/* The one lazily-loaded screen, so it needs the one boundary. The
              fallback is the app's own loading line rather than a spinner:
              this arrives in a fraction of a second on a warm connection, and
              a spinner that brief reads as a flicker. */}
          <Route path="agents" element={
            <RequireScope kind="company">
              <Suspense fallback={<div className="page"><div className="muted">Loading the agent map…</div></div>}>
                <CompanyAgentsRoute />
              </Suspense>
            </RequireScope>
          } />
          <Route path="activity" element={<RequireScope kind="company"><CompanyAuditRoute /></RequireScope>} />

          <Route path="people" element={<Navigate to="/settings/company/people" replace />} />
          <Route path="people/:userId" element={<RedirectPerson />} />
          <Route path="departments" element={<Navigate to="/settings/company/departments" replace />} />
          <Route path="departments/:departmentId" element={<RedirectDepartment />} />
          <Route path="skills" element={<Navigate to="/settings/company/skills" replace />} />
          <Route path="memories" element={<Navigate to="/settings/company/memory" replace />} />
          <Route path="guardrails" element={<Navigate to="/settings/company/guardrails" replace />} />
          <Route path="policy" element={<Navigate to="/settings/company/people" replace />} />
          <Route path="connections" element={<Navigate to="/settings/connections" replace />} />
          <Route path="connections/web-search" element={<Navigate to="/settings/connections/web-search" replace />} />
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
              <SettingsEntry />
            </Protected>
          }
        >
          <Route index element={<Navigate to="/settings/profile" replace />} />

          <Route path="profile" element={<SettingsProfile />} />
          <Route path="preferences" element={<SettingsPreferences />} />
          <Route path="connections" element={<MeConnections />} />
          <Route path="connections/web-search" element={<RequireScope kind="company"><WebSearchPage /></RequireScope>} />
          {/* Retired, and kept reachable. Somebody's bookmark or a link already
              sent to a colleague still resolves to the page that answers the
              question they were asking. */}
          <Route path="access" element={<Navigate to="/settings/connections" replace />} />
          <Route path="mail-rules" element={<Navigate to="/me/mail" replace />} />
          <Route path="skills" element={<Navigate to="/settings/connections" replace />} />
          <Route path="models" element={<Navigate to="/settings/connections" replace />} />
          <Route path="memory" element={<MeMemory />} />
          <Route path="usage" element={<MeUsage />} />

          <Route path="team/people" element={<RequireScope kind="team"><TeamPeopleRoute /></RequireScope>} />
          <Route path="team/roles" element={<RequireScope kind="team"><TeamRolesRoute /></RequireScope>} />
          {/* Remapped, not duplicated. This was manager-only and showed switches
              with no consequence; the page it points at shows the consequence to
              everyone and carries the switches for whoever may flip them. */}
          <Route path="team/approvals" element={<Navigate to="/settings/approvals" replace />} />
          <Route path="approvals" element={<ApprovalsScreen />} />
          <Route path="team/usage" element={<RequireScope kind="team"><TeamUsageRoute /></RequireScope>} />

          <Route path="company/people" element={<RequireScope kind="company"><CompanyPeopleRoute /></RequireScope>} />
          <Route path="company/people/:userId" element={<RequireScope kind="company"><CompanyPersonDetailRoute /></RequireScope>} />
          <Route path="company/people/:userId/connections/:connectionId" element={<RequireScope kind="company"><ConnectionGovernancePage /></RequireScope>} />
          <Route path="company/departments" element={<RequireScope kind="company"><CompanyDepartmentsRoute /></RequireScope>} />
          <Route path="company/departments/:departmentId" element={<RequireScope kind="company"><CompanyDepartmentDetailRoute /></RequireScope>} />
          <Route path="company/skills" element={<RequireScope kind="company"><CompanySkillsRoute /></RequireScope>} />
          <Route path="company/memory" element={<RequireScope kind="company"><MemoriesPage /></RequireScope>} />
          <Route path="company/guardrails" element={<RequireScope kind="company"><CompanyGuardrailsRoute /></RequireScope>} />
          {/* The company ceiling and the company connections page are retired.
              The ceiling is still enforced by the backend and still explained
              wherever it locks something — there is simply no screen that edits
              it. Connections moved: the coverage panels are gone, and the three
              company-held connections live on Connected apps, which is the one
              place a person looks to find out what Divo can reach. */}
          <Route path="company/policy" element={<Navigate to="/settings/company/people" replace />} />
          <Route path="company/connections" element={<Navigate to="/settings/connections" replace />} />
          <Route path="company/connections/web-search" element={<Navigate to="/settings/connections/web-search" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  )
}
