# Feature: Admin UI Redesign

> **Status:** `in-progress`
> **Last updated:** 2026-08-17 by codex

---

## Overview

Redesign the admin dashboard to match a specific visual direction the user identified through reference screenshots (Codename.com sales dashboard, sugarcrm customer journeys). The current admin UI feels generic and templated — bloated empty states, low-contrast cards, brand colour barely visible, wasted whitespace. The goal is a denser, more confident, more branded interface.

**Constraint: stay on shadcn.** Components are robust and accessible. Only build custom primitives if shadcn cannot achieve the look (and document why in Key Decisions when it happens). The custom layer goes in `admin/src/components/admin/`.

---

## Reference Direction (from screenshots)

The aesthetic the user wants:

1. **Heavy rounded corners** — `rounded-2xl` to `rounded-3xl` on cards and chips
2. **Soft floating shadows** — cards feel elevated, not flat-bordered
3. **Pill-shaped chips everywhere** — user mentions, filter chips, status, segment toggles
4. **Black for emphasis** — one "hero" surface per section gets a black fill (e.g. featured metric, primary CTA pill)
5. **Pink/magenta primary accent** — currently orange-red (`hsl(10 76% 58%)`); references use a vivid pink
6. **Avatar-driven UI** — people chips with photo + name as first-class elements
7. **Bold oversized numbers** — primary metric value at `text-4xl` to `text-5xl`, semibold
8. **Two-rail sidebar** — thin icon-only rail on far left + labelled list rail next to it
9. **Top horizontal nav option** — pill-active state (black fill) for the active tab
10. **Layered card colour** — mix of white, black, and gradient-tinted surfaces in same view
11. **Information density** — multiple widgets per row, breathing but not bloated

Reference screenshots in chat history:
- Codename.com sales dashboard (heavy density, pill chips, black hero card)
- sugarcrm cases (top nav with pill-active state, journey graph)
- Welcome Kristin productivity dashboard (gradient metric cards, big numbers, soft floating shells, light-blue background)
- Stakent crypto (dark theme done right — deep navy bg, purple emphasis card, sparkline metrics)
- Financial Dashboard (orange-red primary used heavily, black emphasis CTAs, very rounded — *closest to current divo brand*)

The Financial Dashboard is the most relevant reference: it uses a saturated orange-red almost identical to the current divo `--primary` (`hsl(10 76% 58%)`), warm off-white background, white cards, black for emphasis. Decision: keep orange-red primary, copy the *usage pattern* from this reference.

---

## Plan

### Phase 1: Design tokens
- [ ] Decide primary colour (pink/magenta vs keep current orange-red) — see Open Questions
- [ ] Decide default theme (light vs dark) — references are light-first
- [ ] Update `admin/src/styles/global.css` CSS variables: primary, accent, card, background, ring, radius
- [ ] Add new tokens: `--shadow-soft`, `--shadow-elevated` for card elevation
- [ ] Add `--surface-emphasis` token for the "black hero card" treatment
- [ ] Bump `--radius` to `0.875rem` (current is `0.625rem`) so primitives pick up rounder corners
- [ ] Verify dark mode tokens look intentional, not just inverted

### Phase 2: Primitive audit
- [ ] Audit current `components/ui/*` — confirm they all consume tokens (no hardcoded colours or radii)
- [ ] Add missing shadcn primitives we'll need: `Avatar`, `HoverCard`, `Popover`, `Toggle`, `ToggleGroup` (check what's missing)
- [ ] Remove `bg-card` `shadow-none` on `Card` — replace with token-driven elevation

### Phase 3: Shell redesign
- [ ] `admin-sidebar.tsx`: convert to two-rail layout (icon rail + label rail) OR pick top-nav model — see Open Questions
- [ ] `top-bar.tsx`: pill-shaped search field with `cmdk` preview on focus, notification + avatar on right
- [ ] `admin-shell.tsx`: page padding tightens, container uses softer background gradient

### Phase 4: Domain component refresh (`components/admin/`)
- [ ] `MetricCard`: bigger numbers (`text-4xl` semibold), tighter padding, fix the `tone="dark"` bug visible in current OverviewPage screenshot
- [ ] `SectionCard`: soft shadow, rounded-2xl, lighter borders
- [ ] `StatusBadge`: pill shape (already a pill — verify radius matches new tokens)
- [ ] New: `PersonChip` — avatar + name pill (used everywhere in references)
- [ ] New: `EmphasisCard` — black-fill variant for the "hero" card per section
- [ ] New: `SegmentedControl` — pill-style toggle group (Revenue / Leads / W/L)
- [ ] `EmptyState`: collapse to one-line variant (the current giant empty state is the visible problem)

### Phase 5: Page-by-page redesign
Order by visibility:
- [ ] `OverviewPage` — fix the broken metric cards first, then redesign with new components
- [ ] `MembersPage` — heavy `PersonChip` usage
- [ ] `DepartmentsPage`
- [ ] `AgentsPage`
- [ ] `AiOpsPage`
- [ ] `SettingsPage`
- [ ] Auth pages: `LoginPage`, `MemberLoginPage`, `CompanyAdminSignupPage`, `MemberInviteAcceptPage`, `OAuthCallbackPage`

### Out of scope
- Redesigning the desktop Electron client (separate feature)
- New admin pages — refresh existing only
- Backend/API changes
- Charting library changes (still use whatever is current; can revisit later)

---

## Current State

<!-- AI: overwrite this entire section every session. Do not append. -->

**What is working:**
- **Third-party logo rendering now has one deep module**:
  - `BrandMark` owns Logo.dev lookup URLs, sizing, loading, accessibility, and local/monogram fallbacks.
  - Workspace providers, tool traces, mail surfaces, previews, and known citation vendors all use the same catalogue.
  - Unknown citation domains remain behind Divo's cached favicon proxy so research targets are not disclosed to Logo.dev.
  - The publishable key is injected at container startup from the backend-owned environment file; local Vite reads that same source.
- Theme, floor/mat/card surface system, dark mode toggle, and redesigned shell remain in place from earlier sessions.
- `OverviewPage` and `AgentsPage` keep the newer visual language and still build cleanly.
- **Admin data fetching now has a shared React Query cache layer**:
  - `admin/package.json` includes `@tanstack/react-query`.
  - `admin/src/main.tsx` mounts a shared `QueryClientProvider`.
  - `admin/src/auth/AdminAuthProvider.tsx` clears the query cache whenever the admin token changes or is removed, so company-scoped data does not leak across sessions.
  - `admin/src/components/admin/use-api-list.ts` now runs through React Query instead of raw `useEffect` fetch state, and exposes `refresh` / `refreshing`.
- The main list-style pages now benefit from cached requests, deduping, and background-safe refreshes without bespoke refetch hacks:
  - `OverviewPage`
  - `MembersPage`
  - `SettingsPage`
  - `AiOpsPage`
- `MembersPage` no longer uses a `refreshKey` querystring cache-buster. Invite creation and the manual refresh button now refetch through the shared query layer.
- `AiOpsPage` execution drawers now cache execution run detail and event timelines per run ID, so reopening the same run does not always cold-fetch both endpoints.
- `AgentsPage` and `DepartmentsPage` now sit on top of query-backed hooks:
  - `admin/src/pages/agents/use-agent-data.ts` uses React Query for the agent list and tool registry, invalidates the agent cache on CRUD, and applies an optimistic active-toggle update.
  - `admin/src/pages/AgentsPage.tsx` tracks `selectedAgentId` instead of a frozen object snapshot, so drawer state stays aligned with refreshed cache data.
  - `admin/src/pages/departments/use-department-data.ts` uses React Query for department lists, shared tool registry data, and a cached department-detail map while preserving section-level lazy loading, skeletons, and optimistic permission ticks.
- **Departments page is now fully rebuilt around live `advance-backend` data**:
  - `admin/src/lib/api.ts` now exports typed department contracts plus a `departmentsApi` client for list/detail/config/role/member/permission calls.
  - `admin/src/pages/departments/use-department-data.ts` owns list loading, section-scoped detail loading, tool catalog lookup, per-section error/loading state, and all department mutations.
  - `admin/src/pages/DepartmentsPage.tsx` now shows real metrics, a richer registry table, row-click drawer opening, and a working “New department” flow.
  - `admin/src/pages/departments/DepartmentDrawer.tsx` implements the resizable sheet pattern used by `AgentDrawer`, with tabs for `Overview`, `Roles`, `Members`, `Permissions`, and `Config`.
  - Department tabs no longer hydrate one big payload up front. The drawer loads `overview` first, then fetches each tab’s data only when that tab is opened.
  - Every tab now renders a purpose-built skeleton while its own section is loading, instead of blocking the whole drawer behind one spinner.
  - Permission and user-override checkboxes in `PermissionsTab` now update optimistically from local cache, then reconcile against the backend in the background.
  - `OverviewTab` edits name/description/status.
  - `RolesTab` creates custom roles and updates default/scope settings.
  - `MembersTab` searches synced candidates, adds members, updates role assignments, and removes members.
  - `PermissionsTab` edits role-level tool permissions and per-user overrides against the backend action-group matrix.
  - `ConfigTab` edits prompt/skills plus JSON-backed `zohoRateLimit` and `managerApproval` settings, and exposes the config `isActive` switch.
- `admin` build verification passes:
  - `cd admin && pnpm exec tsc -b`
  - `cd admin && pnpm build`

**What is in progress:**
- Manual QA has not yet been done on the new cache behavior across route transitions, invite creation, agent toggle/update flows, and reopening AI Ops execution drawers.

**What is not started:**
- Sidebar visual refresh is still incomplete relative to the original reference set.
- Members, AiOps, and Settings pages still need the same redesign pass that Departments now has.
- Overview still contains placeholder analytics for top-agent/cost style KPIs because the backend does not expose those rollups yet.
- No browser/manual interaction pass has been done yet on `/departments` or the other cache-enabled admin pages; only TypeScript and production build verification is complete.

**Blockers:**
- None.

**Next action:**
> Start `cd admin && pnpm dev`, then manually verify cache behavior on the main admin pages:
> 1. page-to-page navigation does not cold-refetch every list immediately after returning
> 2. `MembersPage` invite creation refreshes directory/invites without `r=` query busting
> 3. `AgentsPage` toggle/update/create/delete flows reconcile cleanly with the cached graph and drawer selection
> 4. `DepartmentsPage` still preserves lazy section loading, skeletons, optimistic permission ticks, and post-mutation refreshes
> 5. `AiOpsPage` execution drawer reopens recent run details from cache and still refreshes cleanly when needed
> 6. logout/login between different admin accounts clears stale cached company data
>
> If manual QA is clean, decide whether to extend React Query deeper into auth/session bootstrap and add page-specific stale times for the noisier operational surfaces.

---

## Key Decisions

| Decision | Why |
|---|---|
| Stay on shadcn unless blocked | Accessibility + Radix correctness; build custom only with documented reason |
| Custom layer lives in `components/admin/` | Already established pattern — keep it |
| Token-driven recolour, never hardcoded | Future palette swaps stay one-file changes |
| Light theme is default | All reference screenshots are light-first; dark mode stays supported but secondary |
| Department config uses JSON editors for `zohoRateLimit` and `managerApproval` | The `advance-backend` contract stores these as arbitrary JSON blobs, not simple booleans; exposing toggles would hide real backend behavior |
| One `BrandMark` boundary for third-party identity | Callers choose a semantic brand and placement; URL policy, fallbacks, and vendor assets cannot drift between screens |
| Keep arbitrary citation favicons on Divo's proxy | Logo.dev is appropriate for the known app catalogue, but should not receive every domain found in private company research |

---

## Locked Decisions (from second round of references)

- **Primary colour: keep orange-red `hsl(10 76% 58%)`** — Financial Dashboard reference uses near-identical orange-red to great effect. Problem isn't the colour, it's that we barely use it.
- **Default theme: light** — light-first like references; dark stays supported.
- **Sidebar: keep current single-rail** but redesigned (current `admin-sidebar.tsx` is fine structurally — just needs visual refresh).
- **Density: high** — 3–4 metric cards per row, no full-row empty states.
- **Empty states: hot-fix immediately** — they wrap themselves in a Card while being rendered inside a SectionCard, creating a visible card-in-card with a 220px min-height. That's the root cause of the giant empty boxes in the current screenshot.

---

## Key Files

| File | Role |
|---|---|
| `admin/src/styles/global.css` | CSS variables — Phase 1 lands here |
| `admin/src/components/ui/*` | shadcn primitives — read-only unless audit finds hardcoded values |
| `admin/src/components/admin/*` | Custom layer — Phase 4 refreshes these |
| `admin/src/pages/OverviewPage.tsx` | First page to redesign (also has visible bug to fix first) |
| `admin/src/app/App.tsx` | Routing — only touches if shell changes |

---

## Progress Log

### 2026-08-17 — codex
- Added the centralized Logo.dev-backed `BrandMark` catalogue and migrated workspace provider tiles, tool traces, mail/auth marks, previews, and known citation vendors to it.
- Preserved local assets/SVGs as immediate loading and network-failure fallbacks, and preserved the backend favicon adapter for unknown citation domains.
- Added runtime config injection for the static nginx admin, local Vite loading from `advance-backend/.env`, compose environment wiring, deployment-secret injection, and public Logo.dev attribution.
- Verification: all 319 admin unit tests pass, the production admin build passes, and 18 of 21 configured Logo.dev lookups returned PNGs; the other three correctly use bundled product fallbacks.

### 2026-05-06 — codex
- Implemented the department management surface in `admin/` against the existing `advance-backend` API: typed `departmentsApi`, `useDepartmentData`, `CreateDepartmentDialog`, `DepartmentDrawer`, and the five drawer tabs (`Overview`, `Roles`, `Members`, `Permissions`, `Config`).
- Rewrote `DepartmentsPage.tsx` to use live list/detail data, open the resizable drawer on row click, and show real department/member/role metrics.
- Chose JSON editors for `zohoRateLimit` / `managerApproval` because the backend stores structured JSON rather than booleans.
- Verification: `cd admin && pnpm exec tsc -b` and `cd admin && pnpm build` both pass.

### 2026-05-06 — codex
- Reworked the department drawer to load data per tab instead of fetching all department detail up front.
- Added section-aware skeleton loaders and section-scoped error/loading state so each tab can fetch, retry, and refresh independently.
- Verification: `cd admin && pnpm exec tsc -b`, `cd admin && pnpm build`, and `cd advance-backend && pnpm typecheck` pass.

### 2026-05-07 — codex
- Made department permission and user-override checkboxes optimistic inside `useDepartmentData()`: local cache updates immediately, network reconcile happens in the background, and failed writes roll back to the previous state.
- Verification: `cd admin && pnpm exec tsc -b` and `cd admin && pnpm build` pass.

### 2026-05-07 — codex
- Added a shared React Query layer to the admin app: new query client, provider wiring, token-scoped cache keys, and auth-time cache clearing.
- Migrated `useApiList()` to React Query and removed `MembersPage`'s `refreshKey` querystring cache-busting in favor of proper refetches.
- Migrated `useAgentData()` and `useDepartmentData()` onto query-backed caches while preserving department tab lazy-loading and optimistic permission toggles; also cached AI Ops execution drawer detail queries.
- Verification: `cd admin && pnpm exec tsc -b` and `cd admin && pnpm build` pass.

### 2026-05-06 — claude (session 7)
- User feedback: the "New department" button (and all `bg-primary` action buttons) was still orange-red, despite the dashboard moving to maroon. They wanted the orange replaced.
- **Unified `--primary` with `--accent`** — both tokens now hold maroon (`350 72% 36%` light, `350 70% 52%` dark). Two tokens, one color. Action buttons (Button default variant), focus rings (`--ring`), and `--chart-1` all flip to maroon. Updated `docs/UI-DESIGN-SYSTEM.md` brand-and-emphasis section to document the unification.
- Follow-up feedback: the home page felt subtly "glassy" via gradient cards (right rail), other pages felt flat. Lack of consistency.
- Added a default soft-accent gradient to `SectionCard` and to `MetricCard` (default tone only — tinted variants stay solid). Pattern: `bg-gradient-to-br from-card via-card to-accent/[0.05]`. Tiny maroon dust in the bottom-right corner of every page-level card.
- Added a `hero` prop to `SectionCard` for the stronger `from-accent/15` treatment used on the home right rail.
- Applied the same gradient to the React Flow canvas wrapper on AgentsPage.
- Documented the new gradient as the "glassy feel" pattern in `docs/UI-DESIGN-SYSTEM.md`. Added rule that tinted surfaces skip the gradient.
- `tsc -b` passes.

### 2026-05-06 — claude (session 6)
- Implemented full dark mode + theme toggle.
- Refined dark tokens in `global.css`: 4-tier hierarchy (floor `5%` → mat `9%` → card `13%` → emphasis `3%`). Brightened accent maroon to `350 70% 52%`. New shadow recipe with hairline ring.
- **Critical decision (after user feedback)**: emphasis does NOT flip to white in dark — stays dark (deepest tier). Originally I had `--emphasis: 0 0% 100%` in dark, user pushed back ("there should be no such white backgrounds please") with a screenshot of the white AUDIT card. Changed to `222 35% 3%` and updated UI-DESIGN-SYSTEM.md to document this rule.
- Created `useTheme()` hook with `light/dark/system` cycle, localStorage persistence, and live `prefers-color-scheme` listener.
- Created `<ThemeToggle />` with Sun/Moon/Monitor icon swap (rotate + scale + opacity transition).
- Mounted toggle in TopBar; standardized all TopBar icon buttons to h-8 with shadow-soft.
- Added no-flash inline script to `index.html` to apply `.dark` class before React paints.
- Added `dark:` variants to avatar tone classes (`OverviewPage.toneClasses`) and the AgentDrawer status pill (`Live`/`Off`) and sub-agent active dot.
- Switched hardcoded `bg-white/15` icon containers to `bg-emphasis-foreground/15` so they adapt cleanly.
- Updated `docs/UI-DESIGN-SYSTEM.md`: new section 8a "Dark mode" explaining the surface hierarchy, brand colors, shadows, avatar overrides, what flips for free, and what needs explicit `dark:` variants. Added 3 anti-patterns about theme handling.
- `tsc -b` passes.

### 2026-05-06 — claude (session 4)
- User feedback: root layout needed to be unified, robust, and non-scrollable. Wanted "L-shape" floor visible — strip on top (for navbar) AND strip on left (for sidebar). Mat in bottom-right with only top-left corner rounded. Page itself must never scroll; only mat content scrolls.
- Restructured `admin-shell.tsx`: `h-screen overflow-hidden` flex column. TopBar at top of floor; below it a flex row of sidebar + mat. Mat is `lg:rounded-tl-[2rem]` with inner `overflow-y-auto` scroller.
- Made TopBar thinner (h-16) and removed sticky/backdrop — now sits naturally on the floor strip.
- Sidebar: transparent bg, no border, smaller logo header. Active item changed from black blob to white-pill-on-floor (`bg-card shadow-soft`) — reads as a chip on the floor surface, matching reference style.
- `tsc -b` passes.

### 2026-05-06 — claude (session 3)
- User rejected session-2 result: "trash" — said the existing UI work needs to be thrown out for the home page; demanded light mode and a "floor + mat" layered look matching Codename.com reference exactly.
- Found `admin/index.html` had hardcoded `class="dark"` — that's why everything rendered in dark mode despite light tokens being default. Removed.
- Introduced `--mat` token (third surface tier). Added `mat` colour to tailwind config.
- Restructured `admin-shell.tsx` to put a `rounded-3xl bg-mat` container inside floor padding — gives the layered "mat on floor" look from the reference.
- Made top-bar transparent over the mat.
- Threw out the previous OverviewPage and rebuilt from scratch to match Codename.com structure: user chips → faded page title → hero number with pills + 5 stat tiles → person stat pills → 3-column grid (breakdown + chart + gradient right-rail) → bottom pink-panel + bar chart card.
- Inlined `PersonChip` and `StatTile` helpers in the page file (will extract to `components/admin/` if reused).
- Used real data where available (executions/members/departments counts), placeholder data for the rest.

### 2026-05-06 — claude (session 2)
- User provided three more references (Welcome Kristin productivity dashboard, Stakent crypto, Financial Dashboard). Locked decisions: keep orange-red primary (Financial Dashboard validates), light theme default, single-rail sidebar, high density, hot-fix empty states.
- Diagnosed root cause of broken metric cards in user's screenshot: `MetricCard` used raw `bg-foreground` / `bg-accent` utilities — `tone="dark"` flipped foreground/background but in dark mode produced low-contrast surfaces. Replaced with new `bg-emphasis` token whose foreground/background flip semantically per theme.
- Diagnosed root cause of giant empty states: `EmptyState` wrapped itself in another `Card` while being rendered inside a `SectionCard` (`Card` inside `Card`), with a 220px min-height. Removed the wrapping Card.
- Implemented Phase 1 (design tokens) in `admin/src/styles/global.css` and `admin/tailwind.config.js`.
- Implemented Phase 2 partial (Card primitive) and Phase 4 critical fixes (MetricCard, EmptyState, SectionCard).
- Migrated all `tone="dark"` / `tone="accent"` usages across pages to new semantic names (`emphasis` / `primary`).
- Removed legacy `soft-panel` utility and migrated remaining usages.
- `tsc -b` passes.

### 2026-05-06 — claude (session 1)
- Created feature doc.
- Captured reference direction from user-provided screenshots (Codename.com, sugarcrm).
- Phased the work into 5 phases: tokens → primitives → shell → domain components → pages.
- Listed 5 open questions for user — all blocking Phase 1.
