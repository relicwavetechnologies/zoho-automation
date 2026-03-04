# V0 EMIAC Task Index

This folder breaks V0 into parallel-friendly tasks with strict ownership and progress tracking.

Canonical source plan:
- [docs/EMIAC-Architecture-Planning-v3.0.md](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/docs/EMIAC-Architecture-Planning-v3.0.md)

Self-contained execution rule:
- Each task folder context.md includes architecture slice, DTO baseline, sync rules, touchpoints, and validation so an agent can start from that folder alone.

Global guardrail baseline:
- V0 scope boundaries, mandatory architecture seams, and frozen status vocabulary are defined in [`00-v0-scope-and-guardrails/context.md`](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/tasks/v0-emiac/00-v0-scope-and-guardrails/context.md).
- All tasks 01-12 must treat that file as a non-optional constraint source in addition to their local context.

## Work Contract

1. Do not start coding in a task before claiming an item in that task's todo.md.
2. Every work session must update progress.md.
3. Keep context.md stable; change it only when scope/assumptions change.

## Recommended Parallel Split

- Track A: 01, 02, 06, 07, 10
- Track B: 03, 04, 05, 08, 09, 11
- Shared start/end: 00, 12

## Task List

| # | Folder | Purpose | Depends On |
|---|---|---|---|
| 00 | 00-v0-scope-and-guardrails | Lock V0 scope, interfaces, and non-goals | None |
| 01 | 01-repo-module-boundaries | Create scalable backend folder boundaries | 00 |
| 02 | 02-core-contracts-state-events | Define state/event contracts for orchestration runtime | 00,01 |
| 03 | 03-channel-abstraction-and-lark-adapter | Add channel adapter contract and Lark implementation | 01,02 |
| 04 | 04-webhook-security-idempotency | Signature verification + idempotency + safe ingress | 03 |
| 05 | 05-bullmq-runtime-and-worker-control | Queue runtime with pause/resume/cancel primitives | 02 |
| 06 | 06-orchestrator-v0-routing-dispatch | V0 router/orchestrator dispatch logic (L1-L3) | 02,05 |
| 07 | 07-agent-registry-and-base-agent | Base agent contract + registry wiring | 02 |
| 08 | 08-zoho-read-agent-and-lark-response-agent | Implement minimal useful workers for V0 | 07,03 |
| 09 | 09-hitl-confirmation-timeout-flow | Human confirmation flow for write actions | 06,08 |
| 10 | 10-redis-checkpoint-recovery | Persist/resume orchestration state | 05,06 |
| 11 | 11-observability-retries-error-taxonomy | Basic telemetry, retries, error classes | 06,08 |
| 12 | 12-e2e-smoke-tests-and-v0-release-checklist | End-to-end validation and release readiness | 03-11 |
