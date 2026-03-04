# V0 EMIAC Task Index

This folder breaks V0 into parallel-friendly tasks with strict ownership and progress tracking.

Canonical source plan:
- [docs/EMIAC-Architecture-Planning-v3.0.md](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/docs/EMIAC-Architecture-Planning-v3.0.md)

Self-contained execution rule:
- Each task folder context.md includes architecture slice, DTO baseline, sync rules, touchpoints, and validation so an agent can start from that folder alone.

Global guardrail baseline:
- V0 scope boundaries, mandatory architecture seams, and frozen status vocabulary are defined in [`00-v0-scope-and-guardrails/context.md`](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/tasks/v0-emiac/00-v0-scope-and-guardrails/context.md).
- All tasks 01-21 must treat that file as a non-optional constraint source in addition to their local context.

## Work Contract

1. Do not start coding in a task before claiming an item in that task's todo.md.
2. Every work session must update progress.md.
3. Keep context.md stable; change it only when scope/assumptions change.

## Execution Order (Updated)

- `00 -> 01 -> 02 -> 03 -> 13 -> 14 -> 15 -> 04 -> 05 -> 06 -> 07 -> 08 -> 09 -> 10 -> 11 -> 16 -> 17 -> 18 -> 19 -> 20 -> 21 -> 12`
- Task `03` is complete and `13/14/15` are explicit mediator tasks between `03` and `04`.

## Recommended Parallel Split

- Track A: 01, 02, 06, 07, 10, 16, 18, 19
- Track B: 03, 13, 14, 15, 04, 08, 09, 11, 17, 20
- Shared start/end: 00, 05, 21, 12

## Task List

| # | Folder | Purpose | Depends On |
|---|---|---|---|
| 00 | 00-v0-scope-and-guardrails | Lock V0 scope, interfaces, and non-goals | None |
| 01 | 01-repo-module-boundaries | Create scalable backend folder boundaries | 00 |
| 02 | 02-core-contracts-state-events | Define state/event contracts for orchestration runtime | 00,01 |
| 03 | 03-channel-abstraction-and-lark-adapter | Add channel adapter contract and Lark implementation | 01,02 |
| 13 | 13-company-onboarding-zoho-connect | Add Zoho connect in company onboarding and trigger async sync | 03 |
| 14 | 14-async-historical-zoho-to-vectordb | Backfill historical Zoho data to vector DB asynchronously | 13 |
| 15 | 15-delta-sync-and-onboarding-validation | Add delta sync and validate onboarding-to-vector lifecycle | 14 |
| 04 | 04-webhook-security-idempotency | Signature verification + idempotency + safe ingress | 15 |
| 05 | 05-bullmq-runtime-and-worker-control | Queue runtime with pause/resume/cancel primitives | 02 |
| 06 | 06-orchestrator-v0-routing-dispatch | V0 router/orchestrator dispatch logic (L1-L3) | 02,05 |
| 07 | 07-agent-registry-and-base-agent | Base agent contract + registry wiring | 02 |
| 08 | 08-zoho-read-agent-and-lark-response-agent | Implement minimal useful workers for V0 | 07,03 |
| 09 | 09-hitl-confirmation-timeout-flow | Human confirmation flow for write actions | 06,08 |
| 10 | 10-redis-checkpoint-recovery | Persist/resume orchestration state | 05,06 |
| 11 | 11-observability-retries-error-taxonomy | Basic telemetry, retries, error classes | 06,08 |
| 16 | 16-admin-auth-backend-foundation | Backend auth/session base for super-admin and company-admin | 13,04 |
| 17 | 17-react-admin-dashboard-foundation | Root React admin app with sidebar layout and backend auth setup | 16 |
| 18 | 18-admin-rbac-management-ui-and-api | Dynamic RBAC management APIs and dashboard screens | 16,17 |
| 19 | 19-admin-audit-logs-and-system-controls | Audit logs and admin control surfaces in dashboard | 18,11 |
| 20 | 20-company-admin-users-invites-and-onboarding-ui | Company-admin hub for users, invites, onboarding, and Zoho sync status | 17,18,13,14 |
| 21 | 21-e2e-admin-dashboard-validation | End-to-end validation for admin dashboard, RBAC, logs, and onboarding controls | 16,17,18,19,20 |
| 12 | 12-e2e-smoke-tests-and-v0-release-checklist | End-to-end validation and release readiness | 03-11,15,21 |
