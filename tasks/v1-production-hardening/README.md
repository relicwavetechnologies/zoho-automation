# V1 Production Hardening Program

## Objective
Deliver a production-grade V1 runtime that is simple, robust, and architecturally clean while preserving additive compatibility.

## Locked Decisions
1. External Qdrant is the production vector target.
2. Zoho scope for V1 is real read-only sync (OAuth + historical + delta).
3. Every task must include automated tests and manual verification evidence.

## Program Files
- `CONTEXT.md`: shared assumptions, constraints, and non-goals.
- `NN-*/context.md`: task intent, scope, dependencies, acceptance.
- `NN-*/todo.md`: owner + status tracked checklist.
- `NN-*/progress.md`: append-only session log with blockers and next step.

## Execution Order
1. `00-v1-scope-and-guardrails`
2. `01-env-contract-and-bootstrap-health`
3. `02-lark-ingress-contract-hardening`
4. `03-lark-security-and-idempotency-hardening`
5. `04-lark-delivery-observability`
6. `05-bullmq-runtime-safety`
7. `06-engine-switch-and-rollback-contract`
8. `07-langgraph-route-node-determinism`
9. `08-langgraph-plan-node-determinism`
10. `09-langgraph-hitl-gate-state-machine`
11. `10-agent-bridge-contract-and-retries`
12. `11-synthesis-and-response-node-contract`
13. `12-checkpoint-recovery-determinism`
14. `13-zoho-oauth-token-lifecycle-real`
15. `14-zoho-historical-sync-real-read`
16. `15-zoho-delta-sync-real-read-events`
17. `16-qdrant-external-adapter`
18. `17-embedding-provider-and-batching`
19. `18-retrieval-grounding-in-zoho-agent`
20. `19-admin-runtime-observability-and-controls`
21. `20-langsmith-tracing-redaction`
22. `21-failure-injection-resilience-suite`
23. `22-e2e-release-gate-matrix`
24. `23-rollback-drill-and-ops-runbook`

## Global Quality Gates
1. Additive changes only (no breaking public API/type changes).
2. Backend authorization remains source of truth.
3. No silent failures; structured logs required for error paths.
4. Each task completion requires:
   - automated test evidence,
   - manual verification evidence,
   - updated `todo.md` and `progress.md`.

## Completion Criteria
Program complete when:
1. All task `todo.md` items are `done` or explicitly deferred.
2. Manual + automated evidence exists for every task.
3. E2E release gate passes with traceable artifacts.
4. Rollback drill is executed and runbook finalized.
