# Divo Admin — UI Design System

> Read this end-to-end before writing or modifying any admin UI code.
> Every visual decision in `/admin/` should be traceable to a rule in this doc.
> If you need to break a rule, document why in `docs/features/02-admin-ui-redesign.md` under Key Decisions.

---

## TL;DR

- **Aesthetic**: sleek, compact, boxy frames with subtle curves, layered surfaces, two brand colors used sparingly.
- **Three-tier surface system**: Floor (page bg) → Mat (content panel) → Card (floating widgets).
- **Light + dark mode supported.** Dark mode adds a 4th implicit tier (emphasis = darkest), light adds it as the inverse (emphasis = darkest). Theme toggle in the TopBar.
- **One brand color** (maroon) split across two semantic tokens: `--primary` for action buttons + focus rings, `--accent` for visible brand accents (deltas, eyebrows, gradients). Both tokens hold the same maroon `350 72% 36%` so the brand reads unified.
- **Black-ish `--emphasis`** is the *third* hero color — used for one prominent surface per section (Best run tile, Details button, etc.). Stays dark in both themes (does NOT flip to white in dark).
- **Compact**: small text (`text-[11px]` to `text-[13px]`), tight padding (`p-3` to `p-4`), modest radius (`--radius: 0.5rem`).
- **Layout**: L-shape root with sidebar on left floor, navbar on top of right column, mat in bottom-right.
- **No scroll on the page itself** — only mat content scrolls.
- **shadcn first**. Build custom only if shadcn cannot achieve the look. Custom UI lives in `admin/src/components/admin/`.

---

## 1. Surface System (Floor / Mat / Card)

The admin uses three layered surfaces. Picking the right surface is the first design decision on every screen.

| Token | HSL (light) | HSL (dark) | Purpose | When to use |
|---|---|---|---|---|
| `--background` (Floor) | `24 14% 89%` warm grey | `222 32% 5%` near-black navy | Outer page surface — outside the mat | Sidebar background, navbar strip, gutters |
| `--mat` | `30 22% 96%` warm cream | `222 28% 9%` lifted dark | The big rounded content container | Holds the entire page content; widgets float on top |
| `--card` | `0 0% 100%` pure white | `222 22% 13%` lifted card | Floating widgets, list rows, person chips | Anything that should read as a discrete element on the mat |
| `--emphasis` | `222 34% 11%` near-black | `222 35% 3%` deepest near-black | The hero surface — darker than everything else | The single hero card per section |

**Visual hierarchy**: floor (darkest) → mat (medium) → card (lightest). The contrast between them is intentional; never blur this hierarchy with translucency tricks.

### L-shape layout rule

The root layout is an L. The mat occupies the bottom-right rectangle. Floor is visible:
- Top strip (where the navbar lives)
- Left column (where the sidebar lives)

```
┌──────┬─────────────────────────────────┐
│      │  NAVBAR (on floor)              │
│ SIDE ├─────────────────────────────────┤
│ BAR  │ ╭───────────────────────────────│
│ on   │ │  MAT (rounded top-left only)  │
│floor │ │  ┌─────────────────────────┐  │
│      │ │  │ scrollable content      │  │
│      │ │  └─────────────────────────┘  │
└──────┴───────────────────────────────  ┘
```

**Implementation lives in `admin/src/components/admin/admin-shell.tsx`.** Do not change this layout per-page.

The mat is only rounded at the top-left corner (`rounded-tl-2xl`, ~16px). Other corners flush with viewport edges.

### Scroll rule

The page itself NEVER scrolls. Root is `h-screen overflow-hidden`. Only the inner div inside the mat is `overflow-y-auto`. If you need to scroll something else (e.g. a list inside a card), give that element its own bounded container.

---

## 2. Color Tokens

All colors are CSS variables on `:root` in `admin/src/styles/global.css` and exposed via Tailwind in `admin/tailwind.config.js`.

### Brand & emphasis

| Token | Value (light) | Tailwind | When to use |
|---|---|---|---|
| `--primary` | `350 72% 36%` bloody maroon (unified with `--accent`) | `bg-primary` `text-primary` | Action buttons (Button default variant), focus rings (via `--ring`). Functionally the same color as `--accent` — the brand reads as a single color across the app. |
| `--accent` | `350 72% 36%` bloody maroon | `bg-accent` `text-accent` | The brand color across the dashboard: positive deltas, eyebrow labels, hero pills, gradient corners, KPI emphasis. |
| `--emphasis` | `222 34% 11%` near-black (light) / `222 35% 3%` deepest dark | `bg-emphasis` `text-emphasis-foreground` | One hero surface per section. Stays dark in both themes — never flips to white in dark mode (would create harsh contrast). In dark mode the emphasis surface reads as a "deeper hole" than the regular cards. |

**Decision rule**: when adding visual weight to an element, ask:
1. Is this the *single hero* of its section? → `bg-emphasis` (black)
2. Is this an action CTA (button, primary CTA pill)? → `bg-primary` (maroon) — usually via the default `Button` variant
3. Is this a brand accent / positive metric / eyebrow / non-button highlight? → `bg-accent` (maroon) or `text-accent`
4. Otherwise → no color, use `bg-card` or default text

**Note**: `--primary` and `--accent` are intentionally the same maroon. Two tokens, one color — keeps semantic distinction (primary = actions, accent = brand accents) while presenting one brand color. If we ever introduce a second brand color again, just change `--primary` and the action buttons follow.

### Neutrals

| Token | Tailwind | Use |
|---|---|---|
| `--foreground` | `text-foreground` | Default body text |
| `--muted-foreground` | `text-muted-foreground` | Secondary text, helper text, table headers |
| `--secondary` | `bg-secondary` | Subtle inline pills (percent badges, tool counts) |
| `--border` | `border` | Card outlines (rare — most cards use `border-transparent` and rely on shadow) |

### Status

| Token | Tailwind | Use |
|---|---|---|
| `--success` | `bg-success text-success-foreground` | Confirmed/healthy status |
| `--warning` | `bg-warning text-warning-foreground` | Pending/degraded status |
| `--destructive` | `bg-destructive text-destructive-foreground` | Error/destructive action |

### Domain palette (for integrations / data categories)

When you need many distinct colors (charts, integration logos, avatar tones), use Tailwind's default palette in muted tints. Established convention:

| Domain | Color |
|---|---|
| Zoho | `bg-orange-500` |
| Lark | `bg-blue-500` |
| Google | `bg-emerald-500` |
| Web search | `bg-violet-500` |
| Other | hatched border (`border-2 border-dashed border-border/60 bg-secondary/40`) |

For avatar tones use light backgrounds with dark text:
`bg-blue-100 text-blue-700`, `bg-purple-100 text-purple-700`, `bg-emerald-100 text-emerald-700`, `bg-amber-100 text-amber-700`. Reference: `toneClasses` in `admin/src/pages/OverviewPage.tsx`.

---

## 3. Geometry: Radius & Shadow

### Radius

`--radius: 0.5rem` (8px). Tailwind aliases derived in `tailwind.config.js`:

| Class | Pixels | Use |
|---|---|---|
| `rounded-sm` | 4px | Tiny chips, small badges |
| `rounded-md` | 6px | Sidebar nav items, list rows, filter buttons |
| `rounded-lg` | 8px | **Default**. Cards, panels, dialogs |
| `rounded-xl` / `rounded-2xl` | 12 / 16px | Larger framed regions, mat top-left |
| `rounded-full` | pill | Person chips, status pills, action CTAs (Details button) |

**Rule**: Boxy first, pills only for chips and CTAs. Don't over-curve. If something is between "big card" and "tiny chip", default to `rounded-lg`.

### Shadow

| Token | Tailwind | Use |
|---|---|---|
| `--shadow-soft` | `shadow-soft` | All `Card` primitives by default; floating chips on the mat |
| `--shadow-elevated` | `shadow-elevated` | Modals, popovers, overlays — anything explicitly hovering |

Cards on the mat get `shadow-soft` automatically. A nested card *inside* a mat panel that already has its own contrast can drop shadow with `shadow-none`.

### Gradient (the "glassy" feel)

Every untinted page-level surface (`SectionCard` default, `MetricCard` default, the React Flow canvas wrapper) carries a subtle accent gradient:
```
bg-gradient-to-br from-card via-card to-accent/[0.05]
```
This gives a faint maroon dust in the bottom-right corner and is what makes the dashboard feel layered and "glassy" rather than flat. It's almost invisible on its own but consistent across the app.

For a stronger hero treatment (the right-rail card on the home page, occasional emphasis surfaces), use `from-accent/15 via-card to-card`. Available as `<SectionCard hero>` or hand-rolled.

**Tinted surfaces (`bg-emphasis`, `bg-accent`, `bg-primary`) skip the gradient** — solid color is the point. The MetricCard rule: `!isTinted && "bg-gradient-to-br from-card via-card to-accent/[0.05]"`.

When you build a new card-level surface anywhere in the admin, mirror this pattern so the page reads consistently.

---

## 4. Typography Scale

Default font stack: Inter, system-ui, sans-serif. The admin uses a **compact** scale.

| Class | Size | Use |
|---|---|---|
| `text-[9px]` to `text-[10px]` | 9–10px | Microlabels, table headers, tiny meta text |
| `text-[11px]` | 11px | Detail text under stat tiles, captions, subtitles |
| `text-[12px]` / `text-xs` | 12px | List rows, button labels, form labels |
| `text-[13px]` / `text-sm` | 13–14px | Body text, sidebar nav items |
| `text-base` | 16px | Used sparingly — only for paragraph copy |
| `text-lg` to `text-xl` | 18–20px | Card titles, section labels |
| `text-2xl` | 24px | Stat tile values, page titles |
| `text-3xl` | 30px | Faded page label ("Operations dashboard") |
| `text-4xl` | 36px | Hero metrics (e.g. total executions) |

**Weight**: `font-medium` is the new default for nav/labels (not `font-semibold`). Use `font-semibold` for values, headlines, and CTAs only.

**Tracking**: keep tight. `tracking-tight` on big numbers. Avoid `uppercase tracking-[0.2em]` enterprise-y treatment except on tiny eyebrow labels (`text-[10px]` to `text-[11px]`).

---

## 5. Spacing & Density

### Padding

| Class | Use |
|---|---|
| `p-2` | Inside chips, very small inline panels |
| `p-3` | Default for cards and panels in OverviewPage |
| `p-4` | Slightly more breathing room (right-rail card, hero panels) |
| `p-5` / `p-6` | Reserved for marketing/auth surfaces, not the dashboard |

Use asymmetric padding (`p-3 pt-0`, `pl-1 pr-2.5`) when a chip has an avatar on one side and text on the other.

### Stack & gap

| Class | Use |
|---|---|
| `space-y-1.5` | Inside a small card, between label/value/detail |
| `space-y-3` | Inside a section card |
| `space-y-5` | Between major sections on a page |
| `gap-1.5` to `gap-2` | Pill rows, small chip groups |
| `gap-3` | Grid sections (default for `grid` containers) |
| `gap-4` to `gap-5` | Hero zones with breathing room |

**Rule**: never use `space-y-8` or `gap-6+` on the dashboard. Density beats whitespace here.

---

## 6. Component Patterns

The admin uses **shadcn primitives** (`admin/src/components/ui/`) as the foundation, with a domain layer (`admin/src/components/admin/`) on top.

### Shared primitives (use directly from shadcn)
- `Button`, `Card`, `Avatar`, `Badge`, `Dialog`, `Select`, `Input`, `Label`, `Tabs`, `Sheet`, `Tooltip`, `ScrollArea`, `Separator`, `Skeleton`, `Switch`, `Checkbox`

### Domain components

| Component | File | Use when |
|---|---|---|
| `AdminShell` | `admin-shell.tsx` | Root layout — never replace |
| `AdminSidebar` | `admin-sidebar.tsx` | Sidebar nav |
| `TopBar` | `top-bar.tsx` | Top floor strip |
| `PageHeader` | `page-header.tsx` | Top of every page (eyebrow + title + description + actions) |
| `MetricCard` | `metric-card.tsx` | Square KPI cards in the metric strip below page header |
| `SectionCard` | `section-card.tsx` | Wrapping container for a section with title + description + content |
| `DataTable` | `data-table.tsx` | Tabular data with loading + empty states |
| `EmptyState` | `empty-state.tsx` | Inline empty state (used inside SectionCard / DataTable) |
| `StatusBadge` | `status-badge.tsx` | Status pill with semantic mapping |
| `AuthCard` | `auth-card.tsx` | Two-column auth shell (login, signup, invite-accept) |

### Page-level inline patterns

These are not extracted as reusable components yet — they live inline in pages. Reference them in `admin/src/pages/OverviewPage.tsx`:

- `PersonChip` — `h-7` rounded-full pill with `h-5` Avatar + name (chips row at top of dashboard)
- `StatTile` — `w-[136px]` square with label + big value + detail; supports `tone="emphasis"` (black) and `tone="outlined"` (maroon border)
- Person stat pill — long `rounded-full bg-card shadow-soft` row with avatar + name + value + percentage
- Channel row — `h-9 rounded-md bg-card shadow-soft` row with colored dot + name + value + percentage chip
- Bar chart — colored `rounded-md` bars in flex-end, with hatched dashed border for "Other" bucket

Extract these to `components/admin/` only when reused on a second page.

---

## 7. MetricCard tones

The `MetricCard` component supports four tones:

| `tone` | Visual | Use |
|---|---|---|
| `default` (no tone) | White card, neutral icon | Standard metric |
| `accent` | Maroon card, white text | Brand-emphasis metric (positive primary signal) |
| `emphasis` | Black card, white text | The *one* hero metric in a row |
| `primary` | Orange card, white text | Reserved — currently unused on dashboard |

**Composition rule**: in a row of 3–5 metric cards, at most one is `emphasis` and at most one is `accent`. The rest are default. Never have two `emphasis` cards next to each other.

---

## 8. Layout patterns per page

### Standard page structure

```tsx
<>
  <PageHeader eyebrow="..." title="..." description="..." actions={...} />
  <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
    <MetricCard ... />
    <MetricCard ... tone="accent" />
    <MetricCard ... tone="emphasis" />
    <MetricCard ... />
  </section>
  <SectionCard title="..." description="...">
    <DataTable ... />
  </SectionCard>
</>
```

### Dashboard / overview page

OverviewPage breaks the standard pattern with a richer hero. It is the *only* page that should have a custom hero structure. Other pages should stick to PageHeader + MetricCards + SectionCards.

### Auth pages

All login / signup / invite-accept screens use `<AuthCard>`. Two-column layout: marketing on the left (hidden on small screens), form on the right.

---

## 8a. Dark mode

Dark mode is supported and fully token-driven. Most components flip for free without per-component overrides. The user-facing toggle lives in the TopBar (`<ThemeToggle />`); state is `light | dark | system` and persists in `localStorage` under `divo_admin_theme`. To prevent a flash of light theme on first paint, an inline script in `admin/index.html` reads localStorage synchronously before React mounts.

### Surface hierarchy in dark

The same Floor → Mat → Card → Emphasis hierarchy applies, but everything is dark. Crucially:

- **Floor**: `222 32% 5%` — deepest layer, near-black navy
- **Mat**: `222 28% 9%` — slightly lifted from floor
- **Card**: `222 22% 13%` — lifted again, the floating layer
- **Emphasis**: `222 35% 3%` — *deeper* than the floor, "void" effect

**Emphasis stays dark.** It does NOT flip to white. A pure white card on a dark background is harsh and breaks the surface rhythm. Instead, in dark mode the emphasis surface is the deepest possible — a small "hole" in the screen that reads as the strongest visual focus.

### Brand colors in dark

- **`--accent` (maroon)** brightens to `350 70% 52%` — vivid enough to read on dark surfaces without losing identity.
- **`--primary` (maroon, unified with accent)** brightens to `350 70% 52%` in dark.
- **`--emphasis-foreground`** is white in both themes (since emphasis is dark in both).

### Shadow recipe in dark

Solid drop shadows mostly disappear on dark surfaces. The dark `--shadow-soft` adds a hairline ring (`0 0 0 1px hsl(...)`) plus a smaller drop shadow:
```
--shadow-soft: 0 0 0 1px hsl(222 18% 24% / 0.5), 0 2px 6px -2px hsl(0 0% 0% / 0.4);
```
This gives card edges definition without trying to fake shadow depth that the dark surface won't show.

### Avatar & status tone overrides

Tailwind's default light tints (`bg-blue-100 text-blue-700`) look harsh on dark cards. Use a `dark:` variant pattern:
```ts
blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
```
Established in `admin/src/pages/OverviewPage.tsx` (`toneClasses`) and the AgentDrawer status pill. Apply the same pattern wherever you use light Tailwind tints.

### Things that flip for free (verified)

- All shadcn primitives (`Card`, `Button`, `Dialog`, `Sheet`, `Tabs`, `Input`, etc.) — they consume tokens.
- `MetricCard`, `SectionCard`, `DataTable`, `EmptyState`, `StatusBadge`, `PageHeader`, `AuthCard`, `AdminSidebar`, `TopBar`, `AdminShell`.
- React Flow canvas (`Background`, `Controls`, `MiniMap`) and the custom `AgentNode` — all use `hsl(var(--*))`.
- Drawer hero icon block, stat strip, tool rows, sub-agent rows, system prompt rows, routing rows.

### Things that need explicit dark variants (because they use raw Tailwind tints)

- `OverviewPage.tsx` `toneClasses` — already has `dark:` variants
- AgentDrawer status pill (`Live`/`Off`) — already has `dark:` variant
- Sub-agent active dot (`text-emerald-700`) — already has `dark:text-emerald-400`

If you add new surfaces with `bg-{color}-100 text-{color}-700`, always pair with `dark:bg-{color}-500/15 dark:text-{color}-300`.

### Theme toggle

`<ThemeToggle />` (`admin/src/components/admin/theme-toggle.tsx`):
- Cycles `light → dark → system → light` on click
- Sun / Moon / Monitor icon swap with rotate + scale + opacity transition
- Lives in `TopBar` between the search field and the shield/notification buttons

### Hook

`useTheme()` (`admin/src/lib/use-theme.ts`):
- Returns `{ theme, resolved, setTheme, toggle }`
- `theme`: stored preference (`light | dark | system`)
- `resolved`: actual rendered theme (`light | dark`)
- Listens to `prefers-color-scheme` when `theme === "system"` and updates live

---

## 9. Anti-patterns (do not do)

- ❌ Hardcoded `<html class="dark">` — theme is controlled by `useTheme()` and the inline script in `index.html`. Don't force it.
- ❌ Making `--emphasis` flip to white in dark mode — keep it dark in both themes; a white card on dark is harsh and breaks the surface rhythm.
- ❌ Using `bg-white/15` or hardcoded white-tints on emphasis surfaces — use `bg-emphasis-foreground/15` or a token-driven equivalent so it adapts when token semantics change.
- ❌ Hardcoded color hexes in components. Always use tokens (`bg-primary`, `text-accent`, etc.).
- ❌ `bg-foreground` / `text-background` for emphasis surfaces. Use the `--emphasis` token instead — it flips correctly between themes.
- ❌ `tone="dark"` / `tone="accent"` (old MetricCard tone names). Use the new semantic names: `emphasis`, `accent`, `primary`.
- ❌ Wrapping an `EmptyState` inside an explicit `Card`. `EmptyState` is plain inline content; the surrounding `SectionCard` already provides the surface.
- ❌ `soft-panel` utility — removed. Use `rounded-2xl shadow-soft` directly.
- ❌ Generous spacing (`space-y-8`, `gap-6+`, `p-8`) on the dashboard. Density beats whitespace.
- ❌ Re-introducing orange (or any second brand color) without updating both `--primary` and `--accent` together. The two tokens are intentionally the same maroon; if you split them, document the why.
- ❌ Font weight `font-bold`. The heaviest the admin goes is `font-semibold`.
- ❌ Uppercase `tracking-[0.25em]` enterprise label treatment on body text. Reserve for tiny eyebrow labels only.
- ❌ Importing raw provider SDKs (`@anthropic-ai/sdk`, `openai`) — see global rule in AGENTS.md, not UI-specific.

---

## 10. File map

```
admin/
├── index.html                            ← <html> tag, no `class="dark"`
├── tailwind.config.js                    ← exposes color tokens to Tailwind
└── src/
    ├── styles/global.css                 ← all CSS variables (colors, radius, shadows)
    ├── app/App.tsx                       ← routing
    ├── components/
    │   ├── ui/                           ← shadcn primitives (do NOT modify per-page; modify primitives instead)
    │   └── admin/                        ← domain layer
    │       ├── admin-shell.tsx           ← L-shape root layout
    │       ├── admin-sidebar.tsx         ← Sidebar nav (floor)
    │       ├── top-bar.tsx               ← Top strip (floor)
    │       ├── page-header.tsx           ← <PageHeader>
    │       ├── metric-card.tsx           ← <MetricCard>
    │       ├── section-card.tsx          ← <SectionCard>
    │       ├── data-table.tsx            ← <DataTable>
    │       ├── empty-state.tsx           ← <EmptyState>
    │       ├── status-badge.tsx          ← <StatusBadge>
    │       ├── auth-card.tsx             ← <AuthCard> for login/signup
    │       ├── logo-mark.tsx             ← Brand mark
    │       ├── error-callout.tsx
    │       ├── use-api-list.ts           ← data hook
    │       └── types.ts
    └── pages/                            ← one .tsx per route; uses domain layer
```

---

## 11. Workflow for an AI agent making UI changes

1. **Read this doc end-to-end.**
2. **Read the feature doc** in `docs/features/` for the work you're doing.
3. **Skim the OverviewPage** (`admin/src/pages/OverviewPage.tsx`) — it's the canonical example of dashboard composition.
4. **Reach for shadcn primitives first.** If there isn't one, reach for the domain layer in `components/admin/`. If there isn't one there, build it inline; only extract to `components/admin/` once it's reused.
5. **Stay token-driven.** Never hardcode hex colors or px sizes that should derive from radius / shadow tokens.
6. **Run `pnpm build` (or `tsc -b`)** before stopping — type check must pass.
7. **Update the feature doc** Current State + Progress Log per the rule in AGENTS.md.

---

## 12. When to break a rule

This doc is a default, not a prison. If a screen genuinely needs to break a rule (e.g. a marketing splash needs `space-y-8`), do it — but record the deviation in the relevant feature doc's **Key Decisions** table with the *why*.

If you find yourself breaking the same rule repeatedly across features, the rule is wrong. Update this doc.
