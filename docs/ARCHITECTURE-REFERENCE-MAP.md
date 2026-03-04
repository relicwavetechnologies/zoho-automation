# Architecture Reference Map (V0 Tasks -> Plan Sections)

Use this map so every agent can jump from a task to exact architecture sections.

Note:
- Historical task program folders were folded/removed from `tasks/`.
- This map is preserved as historical traceability for section mapping only.

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
| 13-company-onboarding-zoho-connect | 14, 33, 36 |
| 14-async-historical-zoho-to-vectordb | 35, 36 |
| 15-delta-sync-and-onboarding-validation | 37, 39 |
| 16-admin-auth-backend-foundation | 23, 24, 33 |
| 17-react-admin-dashboard-foundation | 24, 45 |
| 18-admin-rbac-management-ui-and-api | 23, 24 |
| 19-admin-audit-logs-and-system-controls | 23, 24, 46 |
| 20-company-admin-users-invites-and-onboarding-ui | 24, 36, 39 |
| 21-e2e-admin-dashboard-validation | 19, 20, 47 |
| 12-e2e-smoke-tests-and-v0-release-checklist | 19, 20, 47 |

# Architecture Reference Map (V1 LangGraph Direct Switch -> Plan Sections)

Use this map for V1 switch tasks so implementation stays aligned with the same architecture source.

| Task | Primary Plan Sections |
|---|---|
| 00-v1-scope-and-guardrails | 1, 4, 45, 47 |
| 01-engine-abstraction-and-feature-flags | 3, 4, 25, 47 |
| 02-langchain-openai-foundation | 3, 6, 10 |
| 03-langgraph-state-and-skeleton | 3, 5, 15 |
| 04-route-and-plan-nodes | 3, 5, 6 |
| 05-agent-bridge-node | 5, 7, 11 |
| 06-hitl-gate-node-integration | 12, 16, 17 |
| 07-checkpoint-bridge-and-recovery | 16, 25 |
| 08-synthesis-and-response-node | 3, 10, 17 |
| 09-admin-runtime-observability-upgrade | 23, 24, 46 |
| 10-rollout-safe-switch-and-rollback-drill | 19, 20, 47 |
| 11-e2e-langgraph-validation-and-release-gate | 19, 20, 47 |

# Architecture Reference Map (V1 Production Hardening -> Plan Sections)

Use this map for current V1 production-hardening execution tasks.

| Task | Primary Plan Sections |
|---|---|
| 00-v1-scope-and-guardrails | 1, 4, 45, 47 |
| 01-env-contract-and-bootstrap-health | 4, 10, 18 |
| 02-lark-ingress-contract-hardening | 2, 14, 17 |
| 03-lark-security-and-idempotency-hardening | 2, 16, 22 |
| 04-lark-delivery-observability | 10, 18, 46 |
| 05-bullmq-runtime-safety | 25, 26 |
| 06-engine-switch-and-rollback-contract | 3, 4, 25, 47 |
| 07-langgraph-route-node-determinism | 3, 5, 6 |
| 08-langgraph-plan-node-determinism | 3, 5, 6 |
| 09-langgraph-hitl-gate-state-machine | 12, 16, 17 |
| 10-agent-bridge-contract-and-retries | 5, 7, 11 |
| 11-synthesis-and-response-node-contract | 3, 10, 17 |
| 12-checkpoint-recovery-determinism | 16, 25 |
| 13-zoho-oauth-token-lifecycle-real | 14, 33, 36 |
| 14-zoho-historical-sync-real-read | 35, 36 |
| 15-zoho-delta-sync-real-read-events | 37, 39 |
| 16-qdrant-external-adapter | 35, 36, 45 |
| 17-embedding-provider-and-batching | 3, 7, 10 |
| 18-retrieval-grounding-in-zoho-agent | 7, 14, 35 |
| 19-admin-runtime-observability-and-controls | 23, 24, 46 |
| 20-langsmith-tracing-redaction | 10, 46 |
| 21-failure-injection-resilience-suite | 19, 20, 46 |
| 22-e2e-release-gate-matrix | 19, 20, 47 |
| 23-rollback-drill-and-ops-runbook | 19, 20, 47 |

## Companion Context Docs

- Current consolidated status: `/docs/APP-STATUS-2026-03-05.md`
- DTO/sync contracts: `/docs/V0-DTO-SYNC-CONTRACT.md`
- LangGraph runtime contract: `/docs/V1-LANGGRAPH-RUNTIME-CONTRACT.md`
- Master architecture: `/docs/EMIAC-Architecture-Planning-v3.0.md`
