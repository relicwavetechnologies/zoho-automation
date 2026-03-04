# V1 LangGraph Direct Switch - Shared Context

## Objective
Move orchestration runtime from rule-based service execution to LangGraph + LangChain (OpenAI-only first) with safe rollback support.

## Locked Decisions
- Direct V1 switch target
- OpenAI-only models in this phase
- LangGraph default runtime path
- Legacy rollback path retained for one release cycle

## Non-Negotiable Rules
1. Existing DTO contracts remain backward compatible (additive changes only).
2. Backend authorization is source of truth for all runtime/admin controls.
3. Existing HITL and checkpoint repositories remain authoritative.
4. Worker remains BullMQ-driven.
5. No frontend-only access control.

## Program-Level Acceptance
1. `ORCHESTRATION_ENGINE=langgraph` path is production-usable.
2. `ORCHESTRATION_ENGINE=legacy` or emergency rollback path is functional.
3. Admin runtime APIs expose engine and graph metadata.
4. E2E release checklist captures pass/fail across LangGraph runtime + rollback.

## Documentation Contract
- Every task folder must keep `context.md`, `todo.md`, and `progress.md` updated.
- Before coding in a task: claim `todo.md` owner/status.
- After each work session: append `progress.md` timestamped entry.
