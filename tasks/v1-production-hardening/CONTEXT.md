# V1 Production Hardening Context

## Why This Program Exists
The current runtime is functional in development but still has production gaps: scaffolded Zoho integration, Prisma-only vector fallback behavior, incomplete resilience testing, and partial observability maturity. This program closes those gaps using minimal, additive, test-driven increments.

## Architecture Constraints
1. Preserve separation: `channels -> orchestration -> agents -> integrations`.
2. Keep backend authz as source of truth; no frontend-only access decisions.
3. Use adapters/interfaces to isolate third-party dependencies.
4. Keep rollback to legacy orchestrator available through one release cycle.
5. Prefer narrow, task-scoped changes over broad refactors.

## Scope In
1. Lark ingress hardening and webhook security.
2. BullMQ runtime stability and deterministic recovery.
3. LangGraph node determinism, retries, and HITL state integrity.
4. Real Zoho OAuth + historical/delta read sync pipeline.
5. External Qdrant integration and embedding provider abstraction.
6. Retrieval-grounded Zoho response path.
7. Admin runtime health/trace/control improvements (ShadCN for new UI).
8. LangSmith tracing with redaction controls.
9. Failure-injection resilience validation.
10. Final e2e release gate and rollback drill.

## Scope Out
1. Zoho write-back operations.
2. Multi-provider orchestration model stack beyond OpenAI-first.
3. Large UI redesign outside required admin runtime controls.
4. Cross-program architectural rewrites not required by acceptance criteria.

## Non-Functional Requirements
1. Clear operational logs with correlation identifiers.
2. Redaction of secrets/tokens/PII from logs and traces.
3. Deterministic error classification for retry/fail decisions.
4. Explicit health visibility for key dependencies.

## Shared Acceptance Rules
For each task:
1. `todo.md` owner/status is maintained.
2. `progress.md` includes timestamp, changes, blockers, next step.
3. Automated tests added/updated and executed.
4. Manual verification executed with pass/fail notes.

## Target Runtime Outcome
1. Lark message processing stable and traceable.
2. Real Zoho read data ingested and indexed in external Qdrant.
3. Retrieval-grounded responses via Zoho agent.
4. Admin runtime provides safe operational controls.
5. Rollback path validated and runbook ready.
