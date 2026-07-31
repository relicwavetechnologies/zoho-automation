# Divo Workspace — member/manager web UI + the artifact pipeline

**Status:** design agreed, mock built, nothing wired to real data yet.
**Date:** 2026-08-01
**Purpose:** handover context. Everything a fresh agent needs to take this from mock to implementation without re-deriving it.

---

## 0. Read this first

Two related pieces of work, in this order:

1. **The Workspace web UI** — a role-aware app for members, managers and admins. Mock is built and complete. Next step is mapping every panel to real data.
2. **The artifact pipeline** — giving the things Divo makes during a chat somewhere to live and be rendered. Mock is built; the pipeline is net-new and is the larger piece.

The mock is deliberately a **spec**, not a prototype to be thrown away. Its fixture types mirror real backend contracts field-for-field so screens can be wired rather than rewritten.

**A hard rule carried through everything below:** the mock marks, in the UI itself, every panel that has no backend behind it. Do not remove those markers when wiring — remove them only when the endpoint actually exists. The marker vocabulary lives in `DATA_SOURCES` in `admin/src/pages/workspace/fixtures.ts`.

---

## 1. Why this exists

Company users talk to Divo in Lark. That works, but a chat window is a bad place to do anything that isn't chat:

- Connecting personal accounts (Google, Canva, Airtable) inside message bubbles is poor UX.
- Nobody can see what Divo is allowed to do for them, or why.
- Managers have real authority in the backend but no interface anywhere except the desktop app.
- Anything Divo *produces* — a deck, a checklist, a research brief — has nowhere to be rendered.

The web UI answers all four. Chat itself stays in Lark and is explicitly **out of scope** for now.

---

## 2. What was built

### Files

| Path | What |
|---|---|
| `admin/src/pages/MockDashboardPage.tsx` | The shell: scope switcher, nav, topbar, command palette, router |
| `admin/src/pages/workspace/fixtures.ts` | All fixture data + types mirroring backend contracts + `DATA_SOURCES` honesty map |
| `admin/src/pages/workspace/ui.tsx` | Primitives: staged loading, skeletons, panel, matrix, diff preview, drawer |
| `admin/src/pages/workspace/screens-you.tsx` | Member scope: home, connections, access, approvals, skills, memory, usage, settings |
| `admin/src/pages/workspace/screens-team.tsx` | Manager scope: overview, people, roles, approval policy, usage |
| `admin/src/pages/workspace/screens-company.tsx` | Admin scope: overview, people, departments, ceiling, connections, activity |
| `admin/src/pages/workspace/screens-connect.tsx` | Flow spec: the Lark → browser connect handoff |
| `admin/src/pages/workspace/screens-artifacts.tsx` | Artifact list + viewer (deck / checklist / research) |
| `admin/src/styles/workspace.css` | ~490 lines, built on top of `cursor.css` |

Route: `/mock-dashboard`, mounted at `admin/src/app/App.tsx:66`, outside the `<Protected>` shell.
Deleted: `admin/src/styles/mock-dashboard.css` (3,747 lines, orphaned after the rewrite).

Run it:

```bash
npm run dev --prefix admin -- --port 5199
```

### Design decisions worth preserving

**Scope, not role, is the structural idea.** The sidebar carries an explicit scope — **You / Your team / Company** — and the nav reshapes beneath it. A manager is two people (an individual with their own connections and spend, and a lead responsible for a team); a flat nav makes "Connections" ambiguous. A member has one scope, so the control renders as a static label with no affordance — nothing hints at a door they cannot open. One app, one code path, no separate member bundle.

**Cursor design language, System B only.** The admin runs two parallel token systems. `admin/src/styles/global.css` holds shadcn HSL tokens used by `components/ui/*` and the un-ported legacy pages; `admin/src/styles/cursor.css` holds the `--cur-*` raw-hex system used by `AdminShell` and every redesigned page. **They share no variables.** The Workspace is scoped under `.cur` and extends `cursor.css`. Do not introduce a third system.

Discipline the new CSS holds to, which the previous mock broke:
- radii **8px** (controls) / **12px** (cards) / **999px** (pills). Nothing else.
- type scale **11 / 12 / 13 / 14 / 15 / 20 / 30**. No in-between nudging.
- weight 400 default; 500 max for structural headings; 600 **only** for uppercase micro-labels. Headings are never bold.
- depth by hairline. Raised = `box-shadow: inset 0 0 0 1px`. Real shadow only for drawer / palette / toast.
- orange (`#f54e00` light, `#fb5613` dark) is **scarce** — brand mark, one primary CTA per view, cost, focus ring.

`cursor.css` has no `--cur-warning`; `workspace.css` defines `--ws-warning` for both themes. The overlay scrim is `--ws-scrim`, a fixed rgba — deriving it from `--cur-ink` breaks in dark, since ink inverts.

**Loading is part of the design.** Regions resolve independently with skeletons matched to final geometry so nothing reflows. The `useStaged` hook drives it; the topbar has a replay button to re-watch the sequence.

**Dark mode is first-class.** The old mock had no theme toggle and sat outside the shell, so its dark mode was never once looked at. The new one has a toggle and has been verified in both themes on every screen.

---

## 3. Backend ground truth

Cited so the next agent does not have to re-derive it. `backend/` is **deprecated** — everything is in `advance-backend/`.

### 3.1 Three independent role axes — do not conflate

| Axis | Where | Values |
|---|---|---|
| **Company role** (the *ceiling*) | `AdminMembership.role`, plain String | `MEMBER` / `COMPANY_ADMIN` / `SUPER_ADMIN` + custom |
| **Department role** (the *grant*) | `DepartmentRole.slug` via `DepartmentMembership` | `MANAGER` / `MEMBER` / custom, per department |
| **Admin nav role** (frontend only) | `admin/src/auth/types.ts` | includes a phantom `DEPARTMENT_MANAGER` |

**`DEPARTMENT_MANAGER` is vestigial and actively hostile.** No login path issues it, `getCapabilities()` gives it zero nav items, and the admin frontend throws on it: `"Department managers do not have admin dashboard access in this phase."` (`admin/src/auth/AdminAuthProvider.tsx:46-48`). That line is the problem this project exists to solve.

**A manager is nothing more than** an active `DepartmentMembership` whose `role.slug === 'MANAGER'`, in an active department, plus an active `AdminMembership`. Canonical check: `desktop-department-management.service.ts:55-72` (`isLiveManager`). There are **no reporting lines, no `managerId`, no hierarchy**. "Your team" in the UI means *your department*, and one person can manage several.

### 3.2 Permission resolution

Resolver: `src/application/permissions/permission.service.ts`.

Precedence, highest first:
1. `DepartmentUserToolOverride` (per person)
2. `DepartmentToolPermission` (per department role)
3. **default deny**

Then clamped by the company ceiling (`permission.service.ts:180-189`, logs `perm.dept.ceiling.blocked`). **A department grant above the ceiling silently does nothing.** The UI must surface this at the moment of the toggle — the mock renders those cells locked with an inline explanation.

Every resolved permission carries a `source` (`PermissionSource`): `company_default | company_override | department_role | department_user_override | derived`. **This is the single most valuable thing the backend gives the UI** — it answers "why does this person have this", which is what makes a permission screen comprehensible. Surface it everywhere.

Taxonomy: 40 canonical tool ids in `src/domain/tools/tool-id.ts` (`TOOL_CAPABILITY_DEFINITIONS`). Six are admin-only by default: `larkBase`, `larkApproval`, `googleAppsScript`, `airtableSchema`, `airtableAutomation`, `skillPublishing`. Action groups: `read | create | update | delete | send | execute`.

### 3.3 ⚠️ Per-user overrides can be created but never removed

`updateUserOverride` (`department-admin.service.ts:865-890`) is an **upsert only**. Grepping the whole codebase, `departmentUserToolOverride` has exactly two operations: `findMany` and `upsert`. **There is no delete anywhere.**

This matters more than it sounds: `allowed: false` is an explicit *deny* that still outranks the role. Removing the override means "follow the role". The backend can only express the first. So once a person has an exception they are permanently decoupled from their role — flip it, never lift it.

The mock has a **"Use role instead"** button for this, marked `Needs backend`. Fix is small: a `DELETE` route plus `permissions.invalidateDept(...)`.

### 3.4 What managers can already do (real, member-auth)

`/api/desktop/departments/*` — all gated by `requireManager` / `revalidateManager`:

```
GET    /departments/:id/manage            → { department, roles, memberships }
GET    /departments/:id/candidates?query=
GET    /departments/:id/manager-approval
PUT    /departments/:id/manager-approval  { enabled, requiredActions }
PUT    /departments/:id/roles/:roleId/zoho-scope
POST   /departments/:id/roles             { name, slug }
PUT    /departments/:id/roles/:roleId     { name }
DELETE /departments/:id/roles/:roleId
PUT    /departments/:id/memberships       { userId, roleId }
DELETE /departments/:id/memberships/:userId
```

Plus tool grants via `/api/desktop/auth/tools/:toolId/departments/:deptId/{roles/:roleId|members/:userId}/actions/:actionGroup`, gated by `canGovernDepartment` (company admin **or** that department's manager).

Manager guardrails already enforced server-side: cannot touch `isSystem` or `MANAGER` roles, cannot modify a member whose role is MANAGER, cannot grant MANAGER, cannot create `show_all` Zoho roles.

**So the manager UI is buildable today.** This is the good news of the whole project.

### 3.5 Connections

Six providers in `IntegrationConnection`: `google_workspace | zoho | canva | airtable | aitable | lark`.

**Member can self-connect:** Google, Canva, Airtable (OAuth), Lark.
**Admin only:** Zoho, AITable, Airtable-PAT, Serper/web search, OMS.

`ownerType: 'user'` + `ownerUserId` = personal consent; `ownerType: 'company'` = shared. Sharing is `IntegrationConnectionGrant` (`granteeType: user|department|role|company`, `access: read_only|read_write|admin`).

Who may manage a connection (`desktop-auth.routes.ts:350-355`): owner, creator, an `admin` grant, or company admin. **A department manager is deliberately not on that list.**

Privacy line, stated in code (`company.routes.ts:327`): metadata and policy only — OAuth credentials and token metadata never leave the backend. The mock states this to the member explicitly, because it is the reassurance a consent surface exists to give.

**No expiry or reauth state.** `accessTokenExpiresAt` / `refreshTokenExpiresAt` are stored but never compared to anything. A dead connection reads as healthy until a tool call fails. A "Reconnect" affordance needs that check adding first.

### 3.6 Usage and cost — real vs unreliable

**Real:** cost is priced server-side from actual cache-split token counts against one source of truth (`src/application/observability/pricing.ts`). Not estimated. `AiTokenUsage` is never pruned, so cost history is long-lived.

Landmines to design around:

- **Lark runs never terminate.** Only the desktop/Pi trace ingest calls `complete()`/`fail()`. The LLM proxy creates Lark runs and never closes them, so they sit at `status: "running"` forever with a null duration. Any completed-vs-failed chart including Lark is wrong.
- **`MemberTokenPolicy.monthlyTokenLimit` is enforced by nothing.** It is displayed and settable. The thing that actually bites is `MemberProxyPolicy.monthlyBudgetUsd`, which returns HTTP 402 (`llm-proxy.service.ts:101-105`). Show that one.
- **`analytics.routes.ts:190-193`** uses a hardcoded blended rate ignoring both real per-model pricing and the cache split. It contradicts the Cost/Spend tabs on the same page.
- **Traces prune at 7 days** (`TRACE_RETENTION_DAYS`); cost history does not. So "my activity last quarter" can show runs and money but not steps.
- **No narration.** A timeline renders tool names, not sentences.

**Nothing is department-scoped.** No spend or execution route accepts a `departmentId`. Team aggregation is net-new.

**Members have no usage endpoints at all.** Every spend/run/analytics route requires an admin session. `GET /api/desktop/auth/usage` exists but returns only three totals and is called by nothing.

### 3.7 Known open issues, already documented

- `plans/issues/legacy-admin-permission-router.md` — **P1**: `createAdminPermissionRoutes` mounted at `/admin` with no auth middleware (`server.ts`), accepts caller-supplied company/role/actor.
- `plans/issues/legacy-google-zoho-oauth-header-auth.md` — **P1**: legacy `/api/google/auth/connect` and `/api/zoho/auth/connect` take identity from `x-company-id` / `x-user-id` headers. **Do not build the new UI against these.**
- `plans/issues/admin-oauth-callback-routes-without-handlers.md` — admin SPA Lark/Google callbacks POST to routes that do not exist.

---

## 4. Real vs needs-endpoint vs net-new

The line the next agent has to respect.

### Buildable today, endpoints exist

- Connections: connect / manage / share / disconnect, per provider
- Approvals inbox: `GET /api/desktop/approvals`, `POST /:id/decision`
- Permission reads with provenance; role grants; per-member override **creation**
- Department memberships, custom roles, manager-approval policy
- Skills: gateway ops `skills.list`, `skills.search`, `skills.get`
- Profile: `GET /api/desktop/auth/me`, `/departments`, `/model-options`

### Data exists, route does not — cheap

- Member usage (only three totals today, unconsumed)
- Member run history (`ExecutionRun.userId` is indexed; route is admin-only)
- Member memory list/delete (`/api/admin/memories` is admin-auth)

### Net-new

- **Access requests.** No model. `RuntimeApproval` is per-tool-call, tied to a live run, and expires — it is "approve this send", not "grant me Gmail".
- **Team-scoped usage.** No route accepts a department.
- **Connection health / reauth.** Expiry is stored, never evaluated.
- **Override removal.** §3.3.
- **Web sign-in.** `admin/src/pages/MemberLoginPage.tsx` is a stub. Sessions come only from Lark OAuth or a desktop handoff code. Options: drive the Lark flow (`/lark/authorize-url` → `/callback` → `/poll` → `/exchange` — note `pendingCallbacks` is an **in-process Map**, so it breaks on multi-instance), or mint via `POST /api/desktop/auth/handoff` and redeem with `/exchange`.
- **The whole artifact pipeline.** §6.

---

## 5. The Lark → browser connect handoff

Mock: `admin/src/pages/workspace/screens-connect.tsx`, reachable from **Connected apps → "Connecting from a Lark chat"**.

**Already built:** Divo posts a Connect card when a tool is blocked; `ConnectionAuthorizationIntent` stores the Lark chat, original message and original request text; `GET /api/google/connection/callback` (`src/http/google/google-connection.routes.ts`) resolves `connected | already_consumed | denied | expired | invalid` and **on success already enqueues the agent continuation**, so the original request resumes on its own.

**The one change:** the callback currently dead-ends on a bare HTML page telling the user to close the tab, while the work finishes somewhere they are no longer looking. Replace the terminal `res.send(resultHtml(…))` with `res.redirect(302, \`${WEB_URL}/connected?outcome=…&intent=…\`)`. The five outcomes map one-to-one onto five landing states.

**Plus one small endpoint:** given an intent id, return outcome, connected account, original request text and a Lark deep link. No tokens, no scopes.

**Constraint:** the tab Lark opens has **no dashboard session**. The landing page must render standalone — no shell, no nav, nothing assuming auth — and carry no secrets in the URL.

The payoff: the landing page quotes back what the user originally asked and says Divo has already resumed it. It also becomes the single best moment to explain what they just consented to, which no part of the Lark flow currently does.

---

## 6. The artifact pipeline

The larger piece, and the reason for this document.

### 6.1 The intent

While chatting in Lark, Divo produces things — a pitch deck, a checklist, a research brief. Today they die inside the container. The target:

- Divo writes a file (as it already does), then posts a **link** in the Lark chat.
- The link opens in the member's web app and **renders properly** — HTML decks as decks, checklists as checklists, research with its sources.
- The artifact belongs to the user, is access-controlled and shareable.
- **When the agent edits the file, an event fires and any open render updates in place.**

Reference use case, stated by the product owner: *"my people who pitch to clients should ask Divo to make a nice deck, it makes an HTML file, and we render that HTML at a link under the user's section."*

This is **not** a replacement for Lark Docs. Lark Docs is company-oriented and collaborative. Artifacts are closer to raw rendered output — fast, disposable, agent-owned, and able to be anything a file can be.

### 6.2 What exists

`divo-pi/divo/extensions/divo-artifact/index.ts` (222 lines). The tool badges a workspace file path so the **desktop sidebar** knows what to open. Presentation only — explicitly no gateway, SaaS or RBAC authority.

**It is deliberately disabled, and the tests enforce that.** `divo-pi/divo/test/runtime.test.mjs:85-90` asserts the extension is not passed to the runtime, `divo_artifact` is absent from the tool allowlist, and the system prompt never mentions `DIVO_ARTIFACTS_DIR` or `divo_artifact`.

Useful pieces already there: `DIVO_ARTIFACTS_DIR` env (`runtime.mjs:240`), stable `artifactIdFromPath()`, `titleFromPath()`, and `resolveWorkspaceFilePath()` which jails paths inside the workspace root.

**And one real head start:** `advance-backend/src/infrastructure/channels/lark/lark.webhook.routes.ts:1067` already has a `divo_artifact` branch. The Lark card is half-built.

### 6.3 Why it cannot support the vision

| Blocker | Where |
|---|---|
| `mimeFromPath()` returns `text/markdown` or `undefined` — **HTML is rejected outright** | `divo-artifact/index.ts` |
| The file never leaves the container workspace — nothing uploads or persists it | by design |
| It badges a **path** for the desktop sidebar, not a URL — a Lark card has nothing to link to | by design |
| No owner, no company, no grants — an artifact is just a path | — |
| No event on write, so an open viewer cannot update | — |
| No versioning — the workspace file is overwritten in place | — |

### 6.4 Target shape

Mock: `admin/src/pages/workspace/screens-artifacts.tsx`, nav entry **Things Divo made**.

**List** — cards with a type-specific thumbnail, when, sharing state, and a live "Divo is editing" badge.

**Viewer** — the screen the idea rests on:
- canvas bar showing the real file path, a `Sandboxed` marker, and the revision number
- the render itself, per kind:
  - **deck** — HTML rendered as slides with pips
  - **checklist** — tickable, and ticking tells the chat
  - **research** — prose plus **source cards** (host, title, snippet)
- right rail: **who can see it** (grants), **history** (every revision with what changed), **where it came from** (deep link back to the Lark thread and the prompt that produced it)
- a live banner when the agent is mid-edit; the open render advances on its own

### 6.5 Security constraint — decide this early

**Agent-written HTML must never execute on the dashboard origin.** Same-origin script in the app means it can read the session of whoever opens a shared artifact. Render inside a sandboxed iframe served from a **separate origin**, with a restrictive CSP and no ambient credentials.

This constrains storage and serving, not just CSS. Settle it before building the store.

### 6.6 Suggested build order

1. **Widen the mime map.** `mimeFromPath()` accepts HTML (and later others). Smallest possible change; unblocks everything.
2. **Persist artifacts.** New model: id, companyId, ownerUserId, title, mime, storage key, revision, createdBy run/conversation, timestamps. Durable object storage for the bytes. Content-addressed or versioned — history depends on it.
3. **Upload on write.** The Pi runtime pushes the file when `divo_artifact` is called. Decide: does the tool upload, or does a container-side watcher?
4. **Serve it.** Sandboxed-origin render endpoint + an authenticated metadata endpoint for the surrounding UI.
5. **Grants.** Reuse the `IntegrationConnectionGrant` shape — `granteeType: user|department|role|company`. Do not invent a second sharing model.
6. **Link it in Lark.** The webhook branch exists; give it a URL.
7. **The write event.** Runtime → backend → open viewers (SSE or websocket). This is what makes it feel alive rather than exported.
8. **Re-enable the extension** and update `runtime.test.mjs`, which currently asserts it stays off.

Steps 1, 6 are small. 2, 3, 7 are the real work.

---

## 7. Open decisions

1. **Web sign-in** — Lark redirect, or desktop handoff code? Note the Lark poll path uses an in-process Map and breaks under more than one backend instance.
2. **Access requests** — worth the net-new model, or do members ask their manager out-of-band? The mock designs it because "I can't do X" is the main reason a member opens the app.
3. **Artifact storage** — object store + DB metadata is the obvious answer, but the sandbox origin decision (§6.5) shapes it.
4. **Does the Workspace replace the admin app**, or sit beside it? The agreed direction is one app with a role-aware shell, with the admin surface becoming the Company scope. That implies eventually retiring the redirect-only routes (`/rbac`, `/integrations`, `/audit`, `/token-usage`) rather than carrying them over.
5. **Artifact editing by humans** — the mock is read-only for the member. Agent-only editing is simpler and probably correct for v1.

---

## 8. Immediate next step

Map every Workspace panel to its real endpoint, starting with the surfaces that already work end to end:

1. Connections (member self-service) — the highest-value, lowest-risk win
2. Approvals inbox
3. Manager people + roles + approval policy
4. Profile / model options
5. Then the three cheap new member endpoints (usage, runs, memory)

Leave the artifact pipeline until the Workspace is wired, unless it is being run in parallel by a second agent — the two touch almost nothing in common.

---

## Appendix — things that will waste your time if you don't know them

- `backend/` is deprecated. Everything is `advance-backend/`.
- There is **no** `desktop-compat.routes.ts`. The desktop contract is five routers under `advance-backend/src/http/desktop/`.
- Backend tests run with `node --import tsx --test 'tests/**/*.test.ts'` — **not** vitest. Pi tests: `node --test divo/test/*.test.mjs`.
- `admin/tsconfig.json` has `files: []` and project references, so `tsc --noEmit -p tsconfig.json` checks **nothing**. Use `npm run build` (`tsc -b && vite build`) or `tsc -b --force`.
- `divo_dev` access is via `scripts/db-tunnel.sh` (`pnpm dev:e2e`). **db push only** — there is no `_prisma_migrations` table.
- `run-event.types.ts` and `OrchestrationTracer` define a rich event vocabulary that is **never instantiated**. The events actually in the database are `run_start`, `run_end`, `turn_start`, `turn_end`, `tool_result`, `model_call`, `learning_context`.
- `StepResult` is written but no endpoint ever reads it.
- Desktop/Lark parity is a standing principle: the two channels should behave near-identically. Mirror the desktop runtime rather than building Lark-only or web-only workarounds.

---

## 9. Absorbing the admin app — surface map

Decided 2026-08-01: **absorb, do not rebuild.** Split by layer, not by page.

- **Keep** `admin/src/cursor/` (11 query-hook files) and `admin/src/auth/`. This carries the expensive correctness: super-admin company-scope resolution, the `canViewRawExecutionData` redaction gate, the pricing mirror, and `reconstructRun()` which folds a flat event stream into turns with per-model cost.
- **Rebuild** the shell, IA and page chrome. The shell is already done — it is the Workspace mock.
- **Delete** System A token usage, the `Legacy` wrapper, redirect-only routes, and dead code.

### 9.1 The drift, measured

The backend issues nav capabilities (`admin-auth.routes.ts:190-196`) and the sidebar **ignores them**, hardcoding its own list (`admin-sidebar.tsx:20-45`). The two sets barely agree:

| | Backend issues | Sidebar shows |
|---|---|---|
| home, people, departments, ai-ops, settings | yes | yes |
| **workspaces** | yes (SUPER_ADMIN only) | **never shown** |
| **memories** | yes | **never shown** |
| **skills, guardrails, web-search, controls** | **unknown to backend** | shown |

Consequence: four live pages have **no server-side role gating in the nav contract at all**. `navItems` is effectively dead — its only remaining use is `navItems[0]?.path` as a redirect fallback in `DefaultProtectedRoute`.

**`SettingsPage` is the clearest fossil.** 58 lines, and despite the name it renders an **audit log viewer** (`/api/admin/audit/logs`). It is mounted at three routes: `/workspaces`, `/settings`, and as the target of the `/rbac` redirect. In the Workspace it becomes **Company → Activity**, correctly named at last.

### 9.2 Page-by-page

| Existing page | Lines | Verdict | Lands as |
|---|---|---|---|
| `OverviewPage` | 121 | keep, restyle | Company → Overview |
| `MembersPage` | 112 | keep, restyle | Company → Everyone |
| `MemberDetailPage` | 300 | keep, restyle | Everyone → person |
| `ConnectionGovernancePage` | 156 | keep, restyle | person → connection |
| `DepartmentsPage` + 5 tabs | ~1,370 | keep; heavy overlap with the manager screens — reconcile, don't duplicate | Company → Departments |
| `AiOpsPage` | 306 | keep; drop the two KPI tiles fed by the blended-rate estimate | Company → AI Ops |
| `RunDetailPage` | 154 | keep as-is, it is good | AI Ops → run |
| `GuardrailsPage` | 347 | keep; drop the unenforced token-limit control | Company → Guardrails |
| `WebSearchPage` | 151 | merge | Company → Connections |
| `CompanyControlsPage` | 94 | merge | Company → Company ceiling |
| `SkillsLabPage` | 941 | keep, restyle last (largest single page) | Company → Skills |
| `MemoriesPage` | 201 | **hold** — memory is being reworked separately; also uses raw Tailwind colours, off the design system | Company → Memory |
| `SettingsPage` | 58 | rename — it is an audit viewer, not settings | Company → Activity |
| `MemberLoginPage` | 18 | stub mounted at two routes; replace when web sign-in is decided | — |
| `MockDashboardPage` | — | becomes the app | — |

**Delete on cutover:** the seven redirect-only routes (`/rbac`, `/integrations`, `/audit`, `/token-usage`, `/executions`, `/ai-models`, `/vector-requests`), plus `/workspaces` and `/members` aliases.

**Already deleted (2026-08-01):** `src/lib/admin-user-connections.ts` (343 lines, zero importers, self-described placeholder) and `src/components/admin/theme-toggle.tsx` (59 lines, zero importers). Also `src/styles/mock-dashboard.css` (3,747 lines).

### 9.3 Company scope, as it now stands in the mock

```
Overview · Everyone · Departments
Operations   AI Ops · Skills · Memory
Governance   Company ceiling · Connections · Guardrails · Activity
```

All ten screens exist as mock. Four were added by absorbing admin surfaces (AI Ops, Guardrails, Skills, Memory) and carry the caveats found during the audit — the Lark-status warning on the runs list, and a note that the unenforced token limit must not be carried over.

### 9.4 Cutover order

1. **Shell swap** — Workspace shell becomes the app shell; existing pages render inside it via a compatibility wrapper. Working but unstyled. One change, immediate coherence.
2. Port the already-Cursor pages (Overview, AiOps, RunDetail, Members, MemberDetail) — they mostly need the new `Panel` / `PageHeader` primitives.
3. Port Departments — reconcile with the manager screens rather than duplicating.
4. Port Guardrails, then merge WebSearch and CompanyControls into their new homes.
5. SkillsLab last.
6. Delete System A, the `Legacy` wrapper, and the redirect routes.
7. Decide `navItems`: either make the sidebar honour it, or delete the capability. Two sources of truth is what produced this drift.
