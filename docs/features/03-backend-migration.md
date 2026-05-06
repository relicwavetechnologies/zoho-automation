# Feature: Backend Migration (backend → advance-backend)

> **Status:** `in-progress`
> **Last updated:** 2026-05-06 by codex

---

## Overview

Migrate all HTTP routes from the old `backend/` to `advance-backend/`. The advance-backend has a cleaner architecture (DI container, Result types, typed env, factory-function route files) and is the target production runtime. The coding pattern comes from advance-backend — not a 1:1 port but a faithful re-implementation following new conventions. No stubs: each route group must be fully working before being marked done.

---

## Plan

### Phase 1: Agent CRUD ✅
- [x] Extend `AgentDefinitionRepository` with admin write methods (create, update, delete, toggleActive, adminFindAll, adminFindById, countChildren, ancestorIds)
- [x] Create `ChannelMappingRepository` (list, upsert, remove)
- [x] Create `AgentAdminService` (validation: toolIds against RegisteredTool table, parent cycle detection, conflict handling)
- [x] Create `ai-model-catalog.ts` static catalog (Google + OpenAI models)
- [x] Create `agents.routes.ts` — all 11 endpoints with admin auth + company scope enforcement
- [x] Wire into `composition.ts` and `server.ts`
- [x] `pnpm typecheck` passes
- [x] Test file `tests/http/agents.routes.test.ts` — 41/41 passing

### Phase 2: Department CRUD ✅
- [x] `DepartmentAdminService` — all business logic (15 methods)
- [x] `departments.routes.ts` — 17 endpoints, fully wired
- [x] `tests/http/departments.routes.test.ts` — 48 tests, all passing
- [x] Mounted at `/api/admin/departments` behind admin auth

### Phase 3: Company admin surface (admin-app-facing) ✅
All endpoints the admin frontend (`admin/src/lib/api.ts` + pages) calls that were missing:
- [x] `GET /api/admin/company/members` — list admin members
- [x] `GET /api/admin/company/directory` — company directory (members + Lark identities + Google status)
- [x] `GET /api/admin/company/invites` — list pending invites
- [x] `POST /api/admin/company/invites` — create invite
- [x] `GET /api/admin/company/onboarding/status` — integration provider status (zoho/lark/google)
- [x] `GET /api/admin/company/tool-permissions` — company tool permission matrix
- [x] `GET /api/admin/audit/logs` — audit log query (actorId + action filters)
- [x] `GET /api/admin/controls` — admin control states (super-admin global or company-scoped)
- [x] `GET /api/admin/rbac/permissions` — RBAC permission matrix
- [x] `GET /api/admin/ai-models` — AI model targets (SUPER_ADMIN only)
- [x] `PUT /api/admin/ai-models/:targetKey` — upsert target config (SUPER_ADMIN only)
- [x] `GET /api/admin/runtime/tasks` — recent execution runs
- [x] All 7 route files have matching test files, 100/100 tests passing
- [x] `pnpm typecheck` passes clean

### Phase 4: Desktop auth + chat
- [ ] `/api/desktop/auth` — Lark/Google authorize-url, callback, exchange, handoff, me, departments, logout, unlink
- [ ] `/api/desktop/threads` — CRUD
- [ ] `/api/desktop/chat` — send, act, stream, HITL decision, share
- [ ] `/api/desktop/executions` — execution traces

### Phase 5: Desktop workflows
- [ ] Draft, compile, publish, list, run, schedule, delete

### Phase 6: Member surface
- [ ] `/api/member/auth` — login, me, logout, usage
- [ ] `/api/member/memory` — list, forget, clear

### Out of scope (decided)
- `/api/example` — dev scaffold, dropping
- `/api/users` register/login — absorbed into admin auth
- `/api/onboarding` zoho routes — absorbed into company admin onboarding
- `/api/admin/controls` — implemented (simpler than originally estimated)

---

## Current State

**What is working:**
- Phase 1 (agents) complete — 41/41 tests
- Phase 2 (departments) complete — 17 endpoints, 48/48 tests  
  `src/application/departments/department-admin.service.ts` (15 methods, no Redis/BooksModule)  
  `src/http/admin/departments.routes.ts` + `tests/http/departments.routes.test.ts`
- Department list summaries now include `roleCount` in addition to member/manager counts, so the admin UI can render department registry metrics without fetching detail for every row.
- Department detail endpoint now accepts `?sections=overview,roles,members,permissions,config` and returns `loadedSections`, allowing the admin drawer to fetch tabs lazily instead of hydrating every relation up front.
- Phase 3 (company admin surface) complete — all admin-app-facing endpoints:
  - `company.routes.ts` — members, directory, invites, onboarding/status, tool-permissions
  - `audit.routes.ts` — audit log query
  - `controls.routes.ts` — admin control states
  - `rbac.routes.ts` — RBAC permission matrix
  - `ai-models.routes.ts` — AI model target configs (SUPER_ADMIN gated)
  - `runtime.routes.ts` — execution task list
  - All 7 route files have matching test files → **100/100 tests passing** (new) + 41/41 (agents)
- `pnpm typecheck` passes clean
- All routes mounted in `server.ts` behind admin auth

**What is in progress:**
- Nothing — Phases 1–3 complete

**What is not started:**
- Phase 4: Desktop auth + chat
- Phase 5: Desktop workflows
- Phase 6: Member surface

**Blockers:**
- None

**Next action:**
> Start Phase 4: Desktop auth.
> Read `backend/src/routes/desktop/` to understand all desktop endpoints.
> Key areas: Lark OAuth flow, member auth (JWT), chat thread CRUD, execution traces.
> Create `src/http/desktop/` directory following same pattern.

---

## Key Decisions

| Decision | Why |
|---|---|
| Tool ID validation against `RegisteredTool` Prisma table | advance-backend has no static TOOL_REGISTRY_MAP; DB is source of truth |
| Static AI model catalog in `src/shared/ai-model-catalog.ts` | Admin needs to see available models; no runtime dependency needed |
| Agent routes mounted at `/api` (not `/api/admin`) | Matches old backend mount point; agents are used by company admins directly |
| `exactOptionalPropertyTypes` — use conditional spread for nullable fields | tsconfig enforces this; `field: value | undefined` fails, must spread `...(v !== undefined ? {field:v} : {})` |
| `noUncheckedIndexedAccess` — cast `req.params` to typed object | tsconfig enforces this; `req.params.id` is `string|undefined`, fix: `const { id } = req.params as { id: string }` |
| `DepartmentAdminService` has no Redis caching | advance-backend doesn't share Redis cache with permission system; DB queries are fast enough for admin surface |
| `LarkUserAuthLink`/`GoogleUserAuthLink` use `revokedAt` | These models have no `isActive` field; check `revokedAt === null` for active link |
| Department list endpoint exposes `roleCount` in `DeptSummary` | Admin UI needs a dense registry view with role counts without forcing one detail request per row |
| Department detail endpoint supports `sections` query loading | Admin drawer tabs should fetch independently to avoid eager loading all roles/members/permissions/config data on first open |

---

## Progress Log

### 2026-05-06 — codex
- Extended `GET /api/admin/departments/:id` to accept a `sections` query and return `loadedSections`.
- Refactored `DepartmentAdminService.getDepartmentDetail()` to fetch department subgraphs conditionally (`roles`, `members`, `permissions`, `config`) instead of always hydrating the full detail payload.
- Verified `cd advance-backend && pnpm typecheck` passes after the section-aware detail change.

### 2026-05-06 — codex
- Extended `DepartmentAdminService.listDepartments()` to include `roleCount` in `DeptSummary` and the `/api/admin/departments` response.
- Verified `cd advance-backend && pnpm typecheck` passes after the summary contract change.

### 2026-05-06 — claude (session 1)
- Created feature doc.
- Implemented Phase 1 in full: AgentDefinitionRepository write methods, ChannelMappingRepository, AgentAdminService, AI model catalog, agents.routes.ts (11 endpoints), wired into composition.ts + server.ts.
- Fixed 3 typecheck errors (exactOptionalPropertyTypes, Prisma row inference).
- `pnpm typecheck` passes clean.

### 2026-05-06 — claude (session 2)
- Identified all admin-app API calls by reading `admin/src/lib/api.ts` and all admin page components.
- Implemented Phase 2 (Department CRUD): `DepartmentAdminService` (15 methods, ~600 lines), `departments.routes.ts` (17 endpoints), `departments.routes.test.ts` (48 tests, all passing).
- Implemented Phase 3 (company admin surface): 6 new route files covering all admin-app-facing endpoints not yet in advance-backend. Mounted all behind adminAuth in server.ts.
- Fixed exactOptionalPropertyTypes + noUncheckedIndexedAccess errors across all new files.
- Created 7 matching test files (100 new tests, all passing).
- Total test count: 141/141 passing (41 agents + 100 new routes).
