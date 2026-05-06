# Feature: Dynamic Agent Platform

> **Status:** `in-progress`
> **Last updated:** 2026-05-06 by codex

---

## Overview

Move Divo from a hardcoded supervisor-to-five-agents topology to a DB-configured dynamic agent platform. Agent definitions live in `AgentDefinition`, tools remain code-owned, the supervisor reads active child agents from the catalog, and runtime capability resolution maps DB `toolIds` to Vercel AI SDK tools.

---

## Plan

### Phase 1: Schema & Contracts
- [x] Add execution/display fields to `AgentDefinition`
- [x] Add `DynamicAgentDescriptor` DTO
- [x] Extend agent CRUD validation/service payloads
- [x] Update seed data with slugs and capability descriptions
- [x] Add Prisma migration

### Phase 2: DB-Backed Agent Catalog
- [x] Add catalog service that maps Prisma rows to descriptors
- [x] Add 5-minute cache with explicit invalidation
- [x] Make supervisor registry load active DB children when `companyId` is available
- [x] Keep legacy hardcoded catalog as fallback

### Phase 3: Tool Resolution By ID
- [x] Add resolver from DB `toolIds` to Vercel tool objects
- [x] Add filtered resolver intersecting agent tools with runtime permissions
- [x] Export resolver from Vercel tools module

### Phase 4: Generic Agent Runner + Hooks
- [x] Add `AgentHook` interface and registry
- [x] Add generic `runDynamicAgent`
- [x] Extract bespoke logic into hook adapters

### Phase 5: Agent-As-Tool Contract
- [x] Build child agents as Vercel tools
- [x] Add capability map builder with recursion safety

### Phase 6: Dynamic Supervisor Graph
- [x] Add dynamic graph state and nodes
- [x] Wire graph behind runtime feature flag
- [x] Add shadow parity path

### Phase 7: Admin UI Wiring
- [x] Read `docs/UI-DESIGN-SYSTEM.md`
- [x] Replace mock canvas data with live API hooks
- [x] Add create/edit/toggle/delete flows

### Out of scope
- Agent-level RBAC
- Audit log for agent CRUD
- Channel plugin system
- AI-assisted agent builder
- Agent test panel

---

## Current State

**What is working:**
- All implementation is in `advance-backend/`; the retired `backend/` tree was not touched.
- `AgentDefinition` has dynamic runtime fields: `slug`, `capabilityDescription`, `hookId`, `maxSteps`, `temperature`, and `@@unique([companyId, slug])`.
- Agent CRUD routes accept/pass through runtime fields; `AgentAdminService` auto-generates URL-safe slugs, validates slug format, and invalidates root-agent/catalog caches after create/update/delete/toggle.
- `DynamicAgentDescriptor`, `AgentCatalogService`, and `AgentCatalogCache` map active DB rows to runtime descriptors with a 5-minute in-memory TTL and explicit invalidation.
- `tool-resolver.ts` resolves DB `toolIds` against permitted app tools and exposes filtered resolution for the agent-tool/user-permission intersection.
- `runDynamicAgent` executes DB descriptors with Vercel AI SDK `generateText`, permission-filtered tools, max step/temperature config, structured success/failure, and hook pre/post support.
- `agent-as-tool.ts` exposes child agents as supervisor-callable Vercel dynamic tools with depth/cycle guards.
- `SupervisorAgent` uses dynamic DB capabilities when available and preserves legacy hardcoded dispatcher tools as fallback.
- `scripts/seed-dynamic-agents.ts` seeds `divo-supervisor` plus `lark-ops`, `google-ops`, `zoho-ops`, `context-agent`, and `workspace-agent` with production-oriented prompts and canonical `advance-backend` tool IDs.
- Hook adapters are now deeper but stateless: `zoho-read` parses source/limit/date/scope/operation context, `lark-doc` infers operation/edit strategy and cleans markdown, and `outreach-read` extracts DA/DR/price/country/niche filters and normalizes metrics.
- LangGraph is installed with only `@langchain/langgraph` and `@langchain/core`; no LangChain model provider packages were added.
- `dynamic-supervisor.graph.ts` implements `START -> think -> format -> END`; the think node loads the DB root agent, builds dynamic agent-as-tool capabilities, adds orchestration tools, and uses Vercel AI SDK `streamText`.
- `DYNAMIC_GRAPH_ENABLED=true` routes `SupervisorAgent` through LangGraph. `DYNAMIC_GRAPH_SHADOW=true` runs the graph in background while the existing supervisor path remains primary and logs parity metadata.
- Supervisor outputs now include `toolResults`; `core.ts` persists assistant turns as either plain reply text or a structured `[Actions]` + `[Reply]` history entry built from child-agent/tool results.
- `HistoryService.loadWindow()` now applies read-time compaction tiers before token budgeting: last 4 turns full, next 6 condensed, older turns minimal. `HISTORY_POLICY` now uses `MAX_TURNS=30` and `MAX_TOKEN_BUDGET=12_000`.
- Stale tests for removed domain-router/planner/executor/specialist modules were removed. Current hook, cache, and graph tests were added.
- Context-enrichment regression coverage lives in `tests/orchestration/context-enrichment.test.ts` for action-log formatting and compaction tiers.
- Full verification passes: `cd advance-backend && pnpm typecheck` and `pnpm test` (785/785).

**What is in progress:**
- Nothing actively in progress.

**What is not started:**
- End-to-end seeded-company harness validation with real DB/Lark/Gemini credentials.
- Agent test panel in drawer (live chat scoped to single agent).

**Blockers:**
- None.

**Next action (be specific):**
> Run a real multi-step conversation against `advance-backend` and inspect the stored `RuntimeConversationMessage` assistant turn. Confirm it contains `[Actions]` / `[Reply]`, then send a follow-up retry-style prompt (for example, "try in lark meeting please") and verify the supervisor uses the enriched history instead of replanning from scratch.

---

## Key Decisions

| Decision | Why |
|---|---|
| Keep hardcoded supervisor catalog as fallback while adding DB catalog | Existing orchestration callsites do not always pass `companyId`; fallback prevents a partial migration from breaking production routing. |
| Use canonical `advance-backend` tool IDs in runtime descriptors | `advance-backend` validates `toolIds` against `RegisteredTool` and the in-process `ToolRegistry`; examples are `zohoCrm`, `larkTask`, `googleGmail`, `contextSearch`, not old backend aliases such as `zoho-read`. |
| Implement dynamic platform in `advance-backend` architecture instead of porting old `backend/src/company/*` paths | The migration doc marks `advance-backend` as the target runtime; it already has `AgentDefinitionRepository`, `AgentAdminService`, `ToolRegistry`, and `SupervisorAgent`, so the plan was adapted to those boundaries. |
| Use the existing supervisor path before introducing LangGraph | This gives DB-configured agent/tool capabilities now while keeping the legacy dispatcher fallback and avoiding a second graph runtime before seeded data and harness parity exist. |
| Generic runner uses the already-injected Vercel `LanguageModel` for now | `advance-backend` has a container-level model factory/fallback stack. Per-agent `provider/modelId` fields are stored and exposed, but need a model resolver before they can override the injected runtime model safely. |
| Keep hooks stateless | Hooks parse intent/strategy and clean outputs, but data fetching remains in tools so service calls are not duplicated between hooks and tool implementations. |
| Gate LangGraph with env flags | `DYNAMIC_GRAPH_ENABLED` provides primary cutover and `DYNAMIC_GRAPH_SHADOW` provides parity logging while the existing supervisor remains primary. |
| Use shorter seeded slugs | Seeded slugs use concise admin-facing names such as `google-ops`; tool names become stable `agent_<slug_with_underscores>` handles such as `agent_google_ops`. |
| AI model target reads are SUPER_ADMIN only | Model routing is global runtime configuration, so both GET and PUT on `/api/admin/ai-models` are gated to SUPER_ADMIN. |
| Lark task update fields are sent as query parameters | The Lark task client now matches the established API/test contract: update fields in query, patch body containing only changed task fields, and complete via `/complete`. |
| Persist assistant history with `[Actions]` / `[Reply]` markers and compact only at read time | The stored turn needs enough execution detail for follow-up retries, but compaction should stay schema-free and reversible, so the DB keeps the enriched text while `HistoryService` derives condensed/minimal views on load. |

---

## Open Questions

- [ ] Should per-agent `provider/modelId` override the injected runtime model in the dynamic runner, and if so should that use the existing container fallback stack or a dedicated model resolver?

---

## Progress Log

### 2026-05-06 — codex
- Created feature doc for the dynamic agent platform from the implementation plan.
- Started backend foundation work.

### 2026-05-06 — codex
- Implemented dynamic agent platform foundation in `advance-backend`: schema/migration, CRUD field plumbing, descriptor/catalog/cache, tool resolver, generic runner/hooks, agent-as-tool capability map, and supervisor dynamic capability fallback.
- Added focused tests for dynamic tool/capability resolution and extended agent route tests for runtime fields.
- Verified `pnpm prisma:generate`, `pnpm typecheck`, and focused tests pass; documented full-suite pre-existing failures under Blockers.

### 2026-05-06 — codex
- Implemented the remaining backend dynamic-agent phases from the attached plan: default dynamic-agent seed script, stale test cleanup, deeper stateless hook adapters, LangGraph supervisor graph, env-gated graph cutover, and shadow parity logging.
- Added tests for hook parsing/post-processing, catalog cache invalidation, and dynamic supervisor graph capability construction.
- Removed obsolete tests for removed planner/executor/specialist/domain-router modules and fixed stale/incorrect assertions around permissions, AI model admin gating, and Lark task/calendar clients.
- Verified `cd advance-backend && pnpm typecheck` and `pnpm test` pass cleanly (777/777).

### 2026-05-06 — claude
- Wired admin UI agents page to backend API (Phase 7).
- Created `use-agent-data.ts` hook: fetches agents + tools from API, maps backend shape to UI `AgentDef`/`ToolDef` types, provides CRUD mutations (toggle, update, create, delete).
- Rewrote `AgentsPage.tsx` to consume live data via `useAgentData()` instead of mock imports. Added loading/error states.
- Updated `AgentDrawer.tsx`: enabled Edit (inline capabilityDescription + systemPrompt editing), Save (PUT), Toggle (POST toggle), Delete (with confirmation) buttons. Removed mock stats.
- Created `CreateAgentDialog.tsx`: form with name, parent select, capability description, system prompt, tool multi-select. Calls POST create endpoint.
- Verified `cd admin && pnpm exec tsc -b` and `pnpm build` pass cleanly.

### 2026-05-06 — codex
- Verified the conversation-context enrichment plan is implemented in `advance-backend`: `SupervisorOutput.toolResults`, action-log persistence in `core.ts`, tiered read-time compaction in `history.ts`, and policy budget updates in `history-policy.ts`.
- Confirmed focused regression coverage in `tests/orchestration/context-enrichment.test.ts`.
- Re-ran `cd advance-backend && pnpm typecheck` and the full `pnpm test` suite successfully (785/785).
