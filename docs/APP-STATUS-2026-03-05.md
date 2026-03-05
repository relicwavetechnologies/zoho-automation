# App Status Update (As of March 5, 2026)

## Executive Summary
The backend runtime is now operating with real Zoho OAuth/token lifecycle, real Zoho data read paths, external Qdrant vector storage, and retrieval-grounded `zoho-read` agent responses.

The Lark -> queue -> orchestration -> response loop remains active, with LangGraph as default engine and legacy rollback still available behind env flags.

## Current Working Architecture

### 1) Lark ingress/egress
- Ingress route: `POST /webhooks/lark/events`
- Verification modes:
  - token mode (`LARK_VERIFICATION_TOKEN`)
  - signature mode (`LARK_WEBHOOK_SIGNING_SECRET`)
- Event-id-first idempotency with message-id fallback.
- Outbound send/update uses tenant token auto-management from app id/secret with emergency static-token fallback.

Key files:
- `backend/src/company/channels/lark/lark.webhook.routes.ts`
- `backend/src/company/security/lark/lark-webhook-verifier.ts`
- `backend/src/company/channels/lark/lark-tenant-token.service.ts`
- `backend/src/company/channels/lark/lark.adapter.ts`

### 2) Queue and runtime orchestration
- BullMQ runtime queue with safety hardening (safe queue/job IDs, bounded enqueue retry, explicit 503 on queue unavailability).
- Worker timeout/stall controls from env.
- Runtime snapshots and trace metadata persisted.

Key files:
- `backend/src/company/queue/runtime/orchestration.queue.ts`
- `backend/src/company/queue/runtime/orchestration.worker.ts`
- `backend/src/company/queue/runtime/queue-safety.ts`

### 3) Orchestration engine
- Engine selection: `langgraph|legacy`
- Rollback contract: legacy fallback only for eligible LangGraph failures when enabled.
- Runtime/admin metadata expose configured vs effective engine and rollback reason.

Key files:
- `backend/src/company/orchestration/engine/index.ts`
- `backend/src/company/orchestration/engine/langgraph-orchestration.engine.ts`
- `backend/src/company/orchestration/engine/legacy-orchestration.engine.ts`

### 4) LangGraph flow
- Deterministic contracts for route, plan, HITL transitions, agent bridge, synthesis, and checkpoint recovery.
- Structured fallback behavior for invalid/absent model output.
- Recovery supports resume/requeue decisions with explicit metadata.

Key files:
- `backend/src/company/orchestration/langgraph/route-contract.ts`
- `backend/src/company/orchestration/langgraph/plan-contract.ts`
- `backend/src/company/orchestration/langgraph/hitl-state-machine.ts`
- `backend/src/company/orchestration/langgraph/agent-bridge.ts`
- `backend/src/company/orchestration/langgraph/synthesis-contract.ts`
- `backend/src/company/orchestration/langgraph/checkpoint-recovery.ts`

## Tasks 13–18 Implementation Status

### Task 13: Zoho OAuth token lifecycle
- Real OAuth code exchange implemented.
- Access/refresh tokens encrypted with AES-256-GCM envelope.
- Token refresh and force-refresh flows implemented with retry and classified errors.
- 401 retry-once behavior wired via Zoho data client.

Key files:
- `backend/src/company/integrations/zoho/zoho-token.service.ts`
- `backend/src/company/integrations/zoho/zoho-token.crypto.ts`
- `backend/src/company/integrations/zoho/zoho-http.client.ts`
- `backend/src/company/integrations/zoho/zoho.errors.ts`
- `backend/prisma/schema.prisma` (`ZohoConnection` token metadata fields)

### Task 14: Zoho historical sync real-read
- Synthetic historical adapter replaced with real paginated module reads (`contacts`, `deals`, `tickets`).
- Cursor checkpoint model implemented for deterministic continuation.
- Historical worker now ingests normalized real records.

Key files:
- `backend/src/company/integrations/zoho/zoho-data.client.ts`
- `backend/src/company/integrations/zoho/zoho-historical.adapter.ts`
- `backend/src/company/queue/workers/zoho-historical.worker.ts`

### Task 15: Zoho delta sync real events
- Delta worker fetches fresh source-of-truth record on create/update.
- Delete path removes vectors by source.
- Retry/failure classification and idempotency behavior preserved.

Key file:
- `backend/src/company/queue/workers/zoho-delta.worker.ts`

### Task 16: External Qdrant adapter
- Runtime vector path now uses external Qdrant HTTP adapter.
- Single collection model with payload tenant scoping (`companyId`) is active.
- Supports upsert/search/delete/count/health.

Key files:
- `backend/src/company/integrations/vector/vector-store.adapter.ts`
- `backend/src/company/integrations/vector/qdrant.adapter.ts`

### Task 17: Embedding provider + batching
- Embedding abstraction implemented with OpenAI + deterministic fallback providers.
- Batch embedding service added and integrated into historical/delta workers.
- Logs include provider, batch size, latency, and failures.

Key files:
- `backend/src/company/integrations/embedding/embedding-provider.ts`
- `backend/src/company/integrations/embedding/embedding.service.ts`

### Task 18: Retrieval grounding in Zoho agent
- `zoho-read` agent now resolves single active company context.
- Query embedding + Qdrant retrieval integrated.
- Agent response includes concise answer plus source references in metadata.
- Explicit failures for missing/ambiguous company context.

Key files:
- `backend/src/company/agents/support/company-context.resolver.ts`
- `backend/src/company/agents/support/zoho-retrieval.service.ts`
- `backend/src/company/agents/implementations/zoho-read.agent.ts`

## Control Plane Status
- Admin auth/RBAC/audit/runtime controls are active.
- Runtime task detail/trace APIs remain compatible with additive metadata fields.

## Validation Snapshot (March 5, 2026)

Automated checks currently passing:
- `pnpm -C backend build`
- `pnpm -C backend test:unit:lark`
- `pnpm -C backend test:unit:v1`
- `pnpm -C backend test:unit:zoho`

## Remaining Work
1. Execute live manual verification for Tasks 13–18 against real Zoho tenant and external Qdrant environment.
2. Continue next program tasks (19+): admin runtime observability controls, LangSmith tracing redaction, resilience suite, release gate, rollback drill.
