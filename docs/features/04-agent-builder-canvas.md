# Feature: Agent Builder Canvas (React Flow)

> **Status:** `in-progress`
> **Last updated:** 2026-05-06 by claude

---

## Overview

Build a visual representation of the **Generic Enterprise Agent Platform** vision (`docs/GENERIC-AGENT-PLATFORM-VISION.md`) on the admin AgentsPage. Users see the three-tier agent hierarchy as an interactive tree: Supervisor at the root, Department Heads underneath, and Specialist Sub-Agents at the leaves. Clicking a node opens a side drawer with the agent's full definition.

**Scope: stub UI.** No backend wiring. Mock data hardcoded inline based on the vision doc. The goal is to render the architecture so a non-engineer can see what the platform looks like before any backend exists.

---

## Plan

### Phase 1: Setup
- [ ] Install `@xyflow/react` in `admin/`
- [ ] Add minimal CSS overrides so React Flow inherits our design tokens (radius, shadow, colors)

### Phase 2: Custom node component
- [ ] `AgentNode` component — rectangular node, follows boxy aesthetic (rounded-lg, shadow-soft, bg-card)
- [ ] Three visual variants:
  - **Supervisor** (root) → `bg-emphasis` (black) — single hero
  - **Dept Head** → `bg-card` with maroon accent border or eyebrow
  - **Specialist** → `bg-card` smaller, no accent
- [ ] Each node shows: icon, name, slug pill, capability sentence (truncated), tool/sub-agent count badge

### Phase 3: Mock data
- [ ] Hardcode an `agentTree` object with realistic agents based on vision doc:
  - 1 Supervisor (root)
  - Dept heads: Finance Head, Sales Head, Media Head, Zoho Ops, Lark Ops, Google Ops, Context Agent
  - Specialists under Finance: Books Specialist, CRM Specialist
  - A few specialists under Lark Ops: Calendar Specialist, Base Specialist
- [ ] Hardcode tool registry mock with families (zoho, lark, google, context)

### Phase 4: Canvas page
- [ ] Replace stub `AgentsPage.tsx` with React Flow canvas
- [ ] PageHeader with "Agent platform" title + "Group Admin" eyebrow + company switcher pill on right
- [ ] React Flow with custom node, edges connecting parent → children, top-down layout
- [ ] Mini stat strip at top: total agents, dept heads, specialists, enabled count
- [ ] Controls: zoom, fit-view, mini-map (read-only)

### Phase 5: Side drawer
- [ ] Open `Sheet` (shadcn) when an agent node is clicked
- [ ] Show: name, slug, capability description, allowed tools (list with family icons), allowed sub-agents (list), system prompt sections (Role/Rules/Restrictions/Tone — collapsed), direct slug, default departments
- [ ] Footer buttons (visual only, no handlers): "Test this agent", "Save", "Enable/Disable"

### Out of scope
- Real CRUD (no save / no enable / no test)
- AI-assisted builder conversation flow (Phase 9 in vision doc)
- DAG validation when assigning sub-agents
- Drag-to-reparent

---

## Current State

<!-- AI: overwrite this entire section every session. Do not append. -->

**What is working:**
- `@xyflow/react@12.10.2` installed in admin
- Mock data file: `admin/src/pages/agents/agent-platform-data.ts`
  - 12 agents: 1 supervisor + 7 dept heads + 4 specialists
  - 10 tools across families (zoho/lark/google/context/internal)
  - Hierarchy mirrors vision doc §2.1 — Finance/Sales/Media heads, Lark/Google/Zoho ops, Context Agent; Books/CRM specialists under Finance, Calendar/Base specialists under Lark Ops
  - Each agent has full systemPromptSections, capability description, directSlug, defaultDepartments
- `AgentNode` (`admin/src/pages/agents/AgentNode.tsx`) — custom React Flow node, three visual variants:
  - Supervisor: `bg-emphasis` black card with crown icon
  - Dept-head: white card with maroon-tinted icon
  - Specialist: white card with neutral icon
  - Each shows: icon, name, slug, capability sentence (line-clamp-2), tool/sub-agent count, direct slug pill (if any), `off` chip when disabled
- `AgentDrawer` (`admin/src/pages/agents/AgentDrawer.tsx`) — Sheet-based side drawer:
  - Header with role label (maroon eyebrow), name, slug
  - Sections: Capability description, Allowed tools (with family color dot + action group chips), Sub-agents, System prompt (5 collapsed sections), Routing
  - Footer with Test/Enable/Save buttons (disabled — stub only)
- `AgentsPage.tsx` rewritten:
  - PageHeader with company switcher pill + New agent CTA (visual only)
  - 4 MetricCards: total / dept heads (accent maroon) / specialists / supervisor (emphasis black)
  - 640px tall React Flow canvas with custom nodes, smoothstep edges, Background dot grid, Controls and MiniMap
  - Tree layout computed from parent chain, depth-bucketed and horizontally centered
  - Click node → opens AgentDrawer with full details
- All visuals follow `docs/UI-DESIGN-SYSTEM.md`: floor/mat/card surfaces, design tokens, boxy frames (rounded-md/lg, no rounded-full on cards), maroon for accent, black for emphasis, compact typography
- `tsc -b` passes

**What is in progress:**
- Nothing — clean stop.

**What is not started:**
- Real CRUD — every footer button is `disabled`. No save/test/enable wiring.
- AI-assisted builder conversation flow (vision doc §6.1)
- DAG validation when picking sub-agents
- Drag-to-reparent
- Backend API integration when AgentRegistry lands (vision doc §3.2)

**Blockers:**
- None.

**Next action:**
> Spin up `cd admin && pnpm dev`, navigate to `/agents`. Verify:
> 1. Three tiers visible top-down (Supervisor → 7 dept heads → 4 specialists under their parents)
> 2. Supervisor node is black, dept heads are white with maroon accents, specialists are smaller white cards
> 3. Disabled agents (zoho-ops, base-specialist) render at 50% opacity with "off" chip
> 4. Clicking any node opens the right-side drawer with capability/tools/sub-agents/system prompt/routing
> 5. MiniMap + zoom controls work; pan/zoom feels smooth
>
> If the user wants editability, the next chunk of work is wiring drawer fields to local state + adding a "Save draft" affordance. Backend integration waits for the AgentRegistry from the vision doc to land.

---

## Key Decisions

| Decision | Why |
|---|---|
| Stub only, no backend wiring | Vision is large; UI proves the architecture concept first. Backend will land later (vision doc §9). |
| `@xyflow/react` (modern rebrand of react-flow) | Active maintenance, MIT, smaller bundle than v11 of `reactflow` |
| Custom AgentNode using design tokens, not React Flow's default styles | Match the sleek/boxy aesthetic. Default React Flow nodes look generic. |
| Top-down layout | Mirrors the architecture doc's visual hierarchy (Supervisor → Heads → Specialists) |
| Side drawer for details, not inline edit | Cleaner; matches the vision's "Node click → Side Drawer" specification |

---

## Open Questions

- [ ] Should the canvas be horizontally or vertically scrollable when there are many agents? (Default: React Flow's pan/zoom handles it; viewport is fixed.)
- [ ] Should the company switcher actually filter mock data, or just be cosmetic? (Cosmetic for stub.)

---

## Reference

- `docs/GENERIC-AGENT-PLATFORM-VISION.md` § 2 (Three-Tier Hierarchy), § 3 (Capability Registry), § 6 (Admin UI Vision)
- `docs/UI-DESIGN-SYSTEM.md` — every visual rule

---

## Progress Log

### 2026-05-06 — claude (session 3)
- User feedback: drawer felt stub, fonts too small, opening was blunt. Also asked for the drawer to be resizable.
- Updated shadcn `Sheet` primitive (`admin/src/components/ui/sheet.tsx`) with proper `data-[state=open]:animate-in` / `data-[state=closed]:animate-out` classes and side-specific `slide-in-from-right` / `slide-out-to-right`. Open uses `cubic-bezier(0.22,1,0.36,1)` (ease-out-quart) at 420ms; close uses `cubic-bezier(0.55,0,0.7,0.2)` at 260ms. Overlay fades at matching duration.
- Rebuilt `AgentDrawer` with much richer content:
  - Hero: 11×11 role icon block (emphasis for supervisor, accent-tinted for others), bigger name (`text-lg`), role eyebrow, status pill (Live/Off in emerald or grey)
  - 3-cell stats strip (Runs / Last active / Avg latency) — mock data via `mockStats(id)` so different agents show different numbers
  - Tools list with bigger family-color tile + tool name (text-[13px]) + description + action chips
  - Sub-agents list with consistent visual rhythm
  - System prompt now in an outlined card with row dividers (5 sections: Role / Can do / Cannot do / Rules / Tone)
  - Routing card with key-value rows
  - Sticky footer with Test / Enable / Save buttons
  - Body fonts bumped from text-[10px]/[11px] to text-[12px]/[13px]; capability text now `text-[13px] leading-6`
- Drawer is now **resizable**:
  - Drag handle on the left edge with `cursor-ew-resize` and a center grip indicator that fades in on hover
  - `localStorage` persistence (`divo_admin_agent_drawer_width`) so user width survives reload
  - Min 360px, max 900px
  - While dragging, body cursor + user-select are locked
- `tsc -b` passes.

### 2026-05-06 — claude (session 2)
- Installed `@xyflow/react@12.10.2`.
- Built mock data (`agent-platform-data.ts`) covering 1 supervisor + 7 dept heads + 4 specialists with full system prompt sections, tool assignments, direct slugs.
- Built `AgentNode` custom React Flow node with three role variants (supervisor=emphasis, dept-head=card+accent icon, specialist=card+neutral). Disabled agents render at 50% with "off" chip.
- Built `AgentDrawer` Sheet showing capability, tools (with family color dots + action group chips), sub-agents, system prompt sections, routing config.
- Replaced stub AgentsPage with full canvas: PageHeader + 4 MetricCards (one accent, one emphasis) + 640px React Flow canvas + drawer.
- All visuals trace back to `docs/UI-DESIGN-SYSTEM.md`.
- `tsc -b` passes.

### 2026-05-06 — claude (session 1)
- Created feature doc.
- Phased the work into 5 phases: setup → custom node → mock data → canvas page → side drawer.
- Decision recorded: stub only, no backend; `@xyflow/react`; custom nodes for design token compliance.
