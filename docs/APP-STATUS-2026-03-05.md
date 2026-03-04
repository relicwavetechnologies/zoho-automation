# App Status Update (As of March 5, 2026)

## Executive Summary
The core Lark-to-AI runtime is working end-to-end in development:
- Lark webhook receives events
- events enqueue into BullMQ
- orchestration executes (LangGraph default)
- responses are posted back to Lark

Admin control-plane foundations are in place (auth, RBAC, runtime controls, audit logs), and the system has structured logging for debugging.

## Current Live Architecture

### 1) Channel Ingress and Egress (Lark)
- Ingress route: `POST /webhooks/lark/events`
- Verification supports:
  - verification-token mode (`LARK_VERIFICATION_TOKEN`)
  - signature mode (`LARK_WEBHOOK_SIGNING_SECRET`)
  - graceful fallback to token mode if signature headers exist but signing secret is not configured
- Idempotency guard prevents duplicate message processing.
- Outbound send/update uses Lark API with tenant token auto-fetch/refresh.

Key implementation paths:
- `backend/src/company/channels/lark/lark.webhook.routes.ts`
- `backend/src/company/security/lark/lark-webhook-verifier.ts`
- `backend/src/company/channels/lark/lark.adapter.ts`
- `backend/src/company/channels/lark/lark-tenant-token.service.ts`

### 2) Runtime Queue + Worker
- BullMQ runtime queue is active for orchestration tasks.
- Safe job ID generation fixed (`:` issue resolved).
- Worker processes tasks per-user deterministically and writes runtime snapshots.

Key implementation paths:
- `backend/src/company/queue/runtime/orchestration.queue.ts`
- `backend/src/company/queue/runtime/orchestration.worker.ts`
- `backend/src/company/queue/runtime/index.ts`

### 3) Orchestration Engine
- Engine abstraction implemented with runtime switching:
  - `langgraph` (default)
  - `legacy` (rollback path)
- Rollback behavior: if LangGraph execution fails and rollback flag is enabled, execution can fall back to legacy engine.

Key implementation paths:
- `backend/src/company/orchestration/engine/index.ts`
- `backend/src/company/orchestration/engine/langgraph-orchestration.engine.ts`
- `backend/src/company/orchestration/engine/legacy-orchestration.engine.ts`

### 4) LangGraph + LangChain
- LangGraph node flow implemented:
  - route -> plan -> hitl gate -> agent dispatch -> retry classify -> synthesis -> response send -> finalize
- LangChain OpenAI integrations present for router/planner/synthesis.
- Deterministic fallback remains available if OpenAI invocation is unavailable/fails.

Key implementation paths:
- `backend/src/company/orchestration/engine/langgraph-orchestration.engine.ts`
- `backend/src/company/orchestration/langchain/openai-models.ts`
- `backend/src/company/orchestration/langchain/json-output.ts`

### 5) HITL + Checkpoint + Recovery
- HITL pending/confirm/cancel/expire lifecycle works.
- Redis checkpoint persistence at orchestration boundaries is active.
- Runtime recovery endpoint requeues from checkpoint state.

Key implementation paths:
- `backend/src/company/state/hitl/*`
- `backend/src/company/state/checkpoint/*`
- `backend/src/modules/admin-runtime/*`

### 6) Admin Dashboard / Control Plane
- Implemented baseline admin stack:
  - admin auth/session
  - RBAC management APIs/UI
  - audit logs
  - system controls
  - runtime task controls and trace view
  - company admin invite/onboarding flow

Key implementation paths:
- `backend/src/modules/admin-auth/*`
- `backend/src/modules/rbac/*`
- `backend/src/modules/audit/*`
- `backend/src/modules/admin-controls/*`
- `backend/src/modules/admin-runtime/*`
- `admin/src/pages/*`

### 7) Logging and Observability
- Structured JSON logs with severity levels.
- Request ID middleware and request lifecycle logs.
- Sampled success logs and full error logs.
- Process-level unhandled error logging.

Key implementation paths:
- `backend/src/utils/logger.ts`
- `backend/src/middlewares/request-logging.middleware.ts`
- `backend/src/middlewares/error.middleware.ts`
- `backend/src/server.ts`

## Feature Status Matrix

### Working Now
- Lark webhook ingest + normalization
- token/signature verification logic
- idempotent ingress handling
- BullMQ orchestration runtime
- LangGraph default orchestration execution
- legacy rollback switch
- HITL confirmation flow
- checkpoint persistence and runtime recovery
- admin runtime controls + trace visibility
- structured backend logging

### Partially Implemented / Demo-Simulated
- Zoho integration uses adapter scaffolding and synthetic historical data in current runtime path.
- Zoho sync producer/workers are DB-job driven and invoked in-process; they are not full externalized queue workers yet.
- Vector pipeline is implemented as Prisma-backed vector-document storage with pseudo embeddings.

### Not Fully Wired Yet
- Real external vector DB (Qdrant service usage) is not active despite adapter naming.
- LangSmith tracing env flags exist but no full runtime tracing integration pipeline is wired.
- Full production-grade E2E validation gate and rollback drill completion remains pending.

## Zoho and Vector Details

### Zoho
- Connection adapter currently returns connected/failed based on provided input shape (scaffold behavior).
- Historical adapter currently emits synthetic records for ingestion flow testing.
- Delta/historical workers maintain sync-job/event lifecycle in DB and update vector documents.

Key files:
- `backend/src/company/integrations/zoho/zoho-connection.adapter.ts`
- `backend/src/company/integrations/zoho/zoho-historical.adapter.ts`
- `backend/src/company/queue/producer/zoho-sync.producer.ts`
- `backend/src/company/queue/workers/zoho-historical.worker.ts`
- `backend/src/company/queue/workers/zoho-delta.worker.ts`

### Vector
- `QdrantAdapter` currently persists vectors into Prisma `VectorDocument` table.
- Embeddings are pseudo-generated hash vectors for current workflow continuity.

Key files:
- `backend/src/company/integrations/vector/qdrant.adapter.ts`
- `backend/prisma/schema.prisma` (model `VectorDocument`)

## Configuration Snapshot
Important runtime flags currently used:
- `ORCHESTRATION_ENGINE=langgraph`
- `ORCHESTRATION_LEGACY_ROLLBACK_ENABLED=true`
- `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_VERIFICATION_TOKEN`
- optional `LARK_WEBHOOK_SIGNING_SECRET`
- `OPENAI_API_KEY` (optional but used for model path)
- logging flags: `LOG_LEVEL`, `LOG_SUCCESS_SAMPLE_RATE`, `LOG_INCLUDE_STACK`

## Recent Critical Fixes
1. BullMQ job ID formatting issue fixed (`:` removed/sanitized) to prevent enqueue 500 errors.
2. Webhook verifier updated to fall back to token mode when signing secret is not configured.
3. Logging layer upgraded to prevent silent failures during testing and rollout.

## Recommended Next Engineering Phase
1. Complete final E2E validation matrix in live-like environment.
2. Replace Zoho scaffolding with real OAuth + real data pulls.
3. Decide vector DB target mode (Prisma-only vs external Qdrant) and finalize retrieval path.
4. Wire LangSmith tracing (or remove dormant flags until implemented).
5. Finalize release gate with rollback drill evidence.
