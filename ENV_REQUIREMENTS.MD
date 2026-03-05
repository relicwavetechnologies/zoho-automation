# Environment Requirements

This file lists environment variables needed to run the current codebase.

## Backend Required

```env
DATABASE_URL=postgresql://...
JWT_SECRET=your-jwt-secret
ADMIN_JWT_SECRET=your-admin-jwt-secret
REDIS_URL=redis://127.0.0.1:6379
CORS_ALLOWED_ORIGINS=http://localhost:5173
PORT=8000
```

Notes:
- `ADMIN_JWT_SECRET` is optional in code and falls back to `JWT_SECRET`, but it is recommended to set it explicitly.
- Config is now schema-validated at bootstrap; invalid values fail startup before server listen.
- `CORS_ALLOWED_ORIGINS` must contain at least one valid `http://` or `https://` origin.
- `REDIS_URL` must start with `redis://` or `rediss://`.
- In `NODE_ENV=production`, at least one webhook verification mode must be configured:
  - `LARK_VERIFICATION_TOKEN`, or
  - `LARK_WEBHOOK_SIGNING_SECRET`.

## Backend Optional Tuning

```env
NODE_ENV=development
ADMIN_SESSION_TTL_MINUTES=480
ORCHESTRATION_WORKER_CONCURRENCY=2
ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS=3
ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS=200
ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS=120000
ORCHESTRATION_QUEUE_LOCK_DURATION_MS=60000
ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS=30000
ORCHESTRATION_QUEUE_MAX_STALLED_COUNT=1
ORCHESTRATION_ENGINE=langgraph
ORCHESTRATION_LEGACY_ROLLBACK_ENABLED=true
LOG_LEVEL=info
LOG_SUCCESS_SAMPLE_RATE=0.25
LOG_INCLUDE_STACK=true
```

## V1 LangGraph + OpenAI Runtime

```env
OPENAI_API_KEY=sk-...
OPENAI_ROUTER_MODEL=gpt-4o-mini
OPENAI_PLANNER_MODEL=gpt-4o-mini
OPENAI_SYNTHESIS_MODEL=gpt-4o-mini
OPENAI_TEMPERATURE=0.1
LANGSMITH_TRACING=
LANGSMITH_API_KEY=
```

Notes:
- `OPENAI_API_KEY` enables model-backed route/planning/synthesis in LangGraph runtime.
- If `OPENAI_API_KEY` is not set, runtime falls back to deterministic routing/planning/synthesis heuristics.
- `ORCHESTRATION_ENGINE=langgraph` is the V1 default; use `legacy` for manual rollback mode.
- Keep `ORCHESTRATION_LEGACY_ROLLBACK_ENABLED=true` during first release cycle.
- Engine rollback contract:
  - `ORCHESTRATION_ENGINE` selects configured engine deterministically.
  - `ORCHESTRATION_LEGACY_ROLLBACK_ENABLED` only enables fallback for eligible LangGraph runtime failures.
  - Non-eligible failures (for example auth/config/programming contract errors) fail fast and do not fallback.
- Queue runtime safety knobs:
  - `ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS` and `ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS` control enqueue retry for transient Redis/network errors.
  - `ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS` caps per-job processing runtime.
  - `ORCHESTRATION_QUEUE_LOCK_DURATION_MS`, `ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS`, and `ORCHESTRATION_QUEUE_MAX_STALLED_COUNT` harden worker stall/recovery behavior.
- If `OPENAI_API_KEY` is set, all three model ids must be non-empty:
  - `OPENAI_ROUTER_MODEL`
  - `OPENAI_PLANNER_MODEL`
  - `OPENAI_SYNTHESIS_MODEL`

## V1 Zoho + Qdrant + Retrieval Runtime (Tasks 13–18 Implemented)

```env
QDRANT_URL=http://127.0.0.1:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=zoho_automation_docs
QDRANT_TIMEOUT_MS=5000
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REDIRECT_URI=
ZOHO_ACCOUNTS_BASE_URL=https://accounts.zoho.com
ZOHO_API_BASE_URL=https://www.zohoapis.com
ZOHO_TOKEN_ENCRYPTION_KEY=
EMBEDDING_PROVIDER=openai
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
LANGSMITH_PROJECT=
```

Notes:
- `QDRANT_URL` must be a valid `http://` or `https://` URL.
- `QDRANT_COLLECTION` and `QDRANT_TIMEOUT_MS` are active runtime settings for vector index/search paths.
- Zoho OAuth connect flow now uses real code exchange and encrypted token storage.
- If any Zoho OAuth variable is set, these should be set together:
  - `ZOHO_CLIENT_ID`
  - `ZOHO_CLIENT_SECRET`
  - `ZOHO_REDIRECT_URI`
  - `ZOHO_TOKEN_ENCRYPTION_KEY` (strongly recommended; warning when missing)
- `EMBEDDING_PROVIDER` supports `openai` and `fallback`.
- If `EMBEDDING_PROVIDER=openai` without `OPENAI_API_KEY`, runtime logs a warning and falls back deterministically.
- `LANGSMITH_PROJECT` is additive metadata only for now; tracing rollout remains optional.

## Lark Integration (Only Needed For Real Lark Webhooks/Messaging)

```env
LARK_API_BASE_URL=https://open.larksuite.com
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_BOT_TENANT_ACCESS_TOKEN=...
LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS=180
LARK_TENANT_TOKEN_FETCH_MAX_RETRIES=3
LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS=250
LARK_VERIFICATION_TOKEN=...
LARK_ENCRYPT_KEY=...
LARK_WEBHOOK_SIGNING_SECRET=...
LARK_WEBHOOK_MAX_SKEW_SECONDS=300
```

Notes:
- Preferred mode is automatic tenant token lifecycle using `LARK_APP_ID` + `LARK_APP_SECRET`.
- `LARK_BOT_TENANT_ACCESS_TOKEN` remains optional as emergency fallback override for local/dev recovery.
- For webhook verification in the UI mode you shared, set `LARK_VERIFICATION_TOKEN` (and `LARK_ENCRYPT_KEY` only if encryption is enabled).
- `LARK_WEBHOOK_SIGNING_SECRET` is optional alternate mode for signature-header verification; use this if your Lark app/webhook sends `x-lark-signature`.
- `LARK_API_BASE_URL` is optional and defaults to `https://open.larksuite.com`.

## Frontend Admin

```env
VITE_API_BASE_URL=http://localhost:8000
```

## Currently Not Required For Active Flow

These may exist in your `.env`, but are not required for the currently active backend/admin runtime paths:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_REDIRECT_URI`
- `API_KEY_MASTER_SECRET`
- `APP_BASE_URL`
- `SESSION_SECRET`
