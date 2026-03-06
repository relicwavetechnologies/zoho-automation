# V1 Release Gate Matrix

This matrix defines automated release checks and waiver policy for V1 production hardening.

## Automated Scenarios

| Scenario ID | Category | Command | Required | Purpose |
|---|---|---|---|---|
| `build_backend` | Build | `pnpm -C backend build` | yes | Type-check and build distributable runtime |
| `unit_lark` | Unit | `pnpm -C backend test:unit:lark` | yes | Lark ingress/security/observability contract regressions |
| `unit_v1` | Unit | `pnpm -C backend test:unit:v1` | yes | LangGraph orchestration contract and recovery regressions |
| `unit_zoho` | Unit | `pnpm -C backend test:unit:zoho` | yes | Zoho/Qdrant/embedding contract regressions |
| `resilience_tests` | Resilience | `pnpm -C backend run test:resilience` | yes | Fault injection tests for Redis/Qdrant/Zoho/OpenAI |
| `resilience_drill` | Resilience | `node backend/scripts/validate-v1-resilience.cjs` | yes | Scenario-level local resilience drill report |
| `core_smoke` | Smoke | `node backend/scripts/validate-v0-core-smoke.cjs` | yes | Core orchestration/HITL/retry runtime smoke |
| `admin_e2e` | E2E | `node backend/scripts/validate-admin-e2e.cjs` | yes | Admin auth/RBAC/runtime controls end-to-end |

## Manual Scenarios (record in release notes)

1. Company-admin runtime visibility and controls in Controls UI.
2. Lark inbound -> orchestration -> outbound response path with real app credentials.
3. Manual fault drill: stop Redis, restore Redis, verify health transitions.
4. Engine rollback drill (`langgraph -> legacy -> langgraph`) with task processing validation.

## Release Result Policy

1. `PASS`: all required automated scenarios pass.
2. `PASS_WITH_WAIVERS`: failed required scenarios are fully covered by valid non-expired waivers.
3. `FAIL`: any required scenario fails without valid waiver, or waiver file is invalid.

## Evidence Artifacts

Release gate runner writes timestamped artifacts to `docs/evidence/`:

1. `v1-release-gate-<timestamp>.json`
2. `v1-release-gate-<timestamp>.md`

Artifacts include per-scenario command, exit code, duration, status, and waiver linkage.
