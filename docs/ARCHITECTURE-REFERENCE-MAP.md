# Architecture Reference Map (V0 Tasks -> Plan Sections)

Use this map so every agent can jump from a task to exact architecture sections.

| Task | Primary Plan Sections |
|---|---|
| 00-v0-scope-and-guardrails | 1, 4, 45, 47 |
| 01-repo-module-boundaries | 4, 15, 45 |
| 02-core-contracts-state-events | 7, 8, 15 |
| 03-channel-abstraction-and-lark-adapter | 2, 14, 17, 45 |
| 04-webhook-security-idempotency | 2, 16, 22 |
| 05-bullmq-runtime-and-worker-control | 25, 26 |
| 06-orchestrator-v0-routing-dispatch | 3, 4, 5, 6 |
| 07-agent-registry-and-base-agent | 7, 45 |
| 08-zoho-read-agent-and-lark-response-agent | 7, 14, 17 |
| 09-hitl-confirmation-timeout-flow | 12, 16, 17 |
| 10-redis-checkpoint-recovery | 16, 25 |
| 11-observability-retries-error-taxonomy | 10, 18, 46 |
| 12-e2e-smoke-tests-and-v0-release-checklist | 19, 20, 47 |

## Companion Context Docs

- Shared V0 context: `/tasks/v0-emiac/CONTEXT.md`
- V0 scope guardrails baseline: `/tasks/v0-emiac/00-v0-scope-and-guardrails/context.md`
- DTO/sync contracts: `/docs/V0-DTO-SYNC-CONTRACT.md`
- Master architecture: `/docs/EMIAC-Architecture-Planning-v3.0.md`
