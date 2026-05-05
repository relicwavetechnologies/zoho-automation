# Feature: Admin UI Redesign

> **Status:** `in-progress`
> **Last updated:** 2026-05-06 by claude

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
- **Dark mode + theme toggle**:
  - `useTheme()` hook in `admin/src/lib/use-theme.ts` — `light | dark | system` with localStorage persistence (`divo_admin_theme`) and live `prefers-color-scheme` listener
  - `<ThemeToggle />` in `admin/src/components/admin/theme-toggle.tsx` — Sun/Moon/Monitor icon swap, mounted in TopBar
  - No-flash inline init script in `admin/index.html` reads localStorage synchronously and applies `.dark` before React mounts
  - Dark tokens refined in `global.css`: floor `222 32% 5%` → mat `222 28% 9%` → card `222 22% 13%` (proper hierarchy preserved)
  - **Emphasis stays dark in both themes** (`222 35% 3%` in dark, `222 34% 11%` in light) — does NOT flip to white. White-on-dark would be harsh; the deeper-than-floor "void" effect is the dark-mode hero treatment
  - Accent (maroon) brightens to `350 70% 52%` in dark for readability
  - Shadow recipe in dark uses hairline ring + soft drop (drop alone disappears on dark surfaces)
  - Avatar tone classes in `OverviewPage.toneClasses` and AgentDrawer status pills now have `dark:` variants (light tint vs `bg-{color}-500/15 dark:text-{color}-300`)
  - StatTile chevron circle and AgentNode icon containers use `bg-emphasis-foreground/15` instead of hardcoded `bg-white/15` so they adapt to token semantics
- All TopBar icon buttons standardized to h-8 with shadow-soft, matching the new ThemeToggle visual weight
- **L-shape root layout** in `admin-shell.tsx`:
  - Outer container is `h-screen overflow-hidden` — page itself never scrolls
  - Top strip (`TopBar`, h-16) sits on the floor — full width across the top
  - Below the strip: sidebar on the left (floor) + mat on the right
  - Mat is `flex-1 bg-mat lg:rounded-tl-[2rem]` — only the top-left corner is rounded (the L-corner), other edges are flush with viewport
  - Mat has `overflow-hidden` and contains a `h-full overflow-y-auto` scroller — only mat content scrolls, never the page
  - On `<lg` screens the sidebar collapses into Sheet (mobile menu in TopBar)
- **TopBar redesign**: no longer sticky, no special bg — just a thin strip that sits on the floor surface
- **Sidebar redesign**: `bg-transparent` (lets floor show through), no border-r, smaller header (h-12 vs h-20), active nav items now render as white-pill-on-floor (`bg-card shadow-soft`) instead of black blob
- **Floor + Mat + Card 3-tier surface system** in `admin/src/styles/global.css`:
  - `--background` (floor): warm grey `24 14% 89%` — outer page surface, sidebar sits on this
  - `--mat`: warmer cream `30 22% 96%` — large rounded container holding all main content
  - `--card`: pure white `0 0% 100%` — floating widgets on the mat
- `tailwind.config.js` exposes `mat` colour group
- `admin-shell.tsx` wraps content in a `rounded-3xl bg-mat` container with floor padding around it (the "mat on floor" effect)
- `top-bar.tsx` is now transparent over mat (was `bg-background/80`)
- **OverviewPage rewritten from scratch** to match Codename.com reference layout:
  - User-chip row at top (PersonChip helper inlined — pill-shaped chip with avatar + name)
  - Faded large page title ("Operations dashboard")
  - Hero with `text-6xl` total executions number + pink primary pill (+12.4%) + outline pink pill (+342 runs) + subtitle
  - 5 stat tiles in a horizontal scroll row: Top agent / Best run (BLACK emphasis with chevron) / Members / Cost (outlined primary border) / Success
  - Person stat pill row (3 long pills + black "Details" CTA)
  - 3-column grid: channel breakdown card / vertical bar chart card / right-rail leaderboard with gradient pink-to-white
  - Bottom card: pink hero panel + bar chart with peak labels
- All cards use shadcn `Card` + `CardContent` primitives (no custom card shells)
- `tsc -b` passes
- Data wiring: pulls live counts from `/api/admin/executions`, `/api/admin/members`, `/api/admin/departments` with sensible fallback values when empty

**What is in progress:**
- Nothing — clean stop. Awaiting visual feedback.

**What is not started:**
- Sidebar visual refresh (still uses old style — looks fine on the floor but not redesigned to match references)
- Other pages (Members, Departments, Agents, AiOps, Settings) — still use old layout
- Real data wiring for the placeholder numbers (top agent, best run cost, KPI numbers, percentage breakdowns). Currently shows realistic-looking placeholders — backend endpoints for these don't exist yet.
- Bar chart and "sales dynamic" line chart are CSS placeholders, not real charts — would need `recharts` or similar for proper rendering
- Brand logos for integrations are colored circles with letters — could be replaced with real SVG logos later

**Blockers:**
- None.

**Next action:**
> Spin up `cd admin && pnpm dev`, open `/home`. Confirm:
> 1. Floor + mat layering is visible (rounded warm-cream container on slightly darker warm-grey floor)
> 2. Hero number is huge with pink delta pill
> 3. Black "Best run" tile stands out among the 5 stat tiles
> 4. Person pill rows render correctly with avatars
> 5. 3-column grid breaks on smaller screens but keeps card identity
> 6. Bottom pink hero panel + bar chart card renders
>
> Once user approves the visual, replace placeholder numbers with real data sources (will need backend endpoints for top-agent / cost-per-run / kpi).
> Then move to other pages (Members, Departments, etc.) using the same patterns.

---

## Key Decisions

| Decision | Why |
|---|---|
| Stay on shadcn unless blocked | Accessibility + Radix correctness; build custom only with documented reason |
| Custom layer lives in `components/admin/` | Already established pattern — keep it |
| Token-driven recolour, never hardcoded | Future palette swaps stay one-file changes |
| Light theme is default | All reference screenshots are light-first; dark mode stays supported but secondary |

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
