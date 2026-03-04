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

## Backend Optional Tuning

```env
NODE_ENV=development
ADMIN_SESSION_TTL_MINUTES=480
ORCHESTRATION_WORKER_CONCURRENCY=2
ORCHESTRATION_ENGINE=langgraph
ORCHESTRATION_LEGACY_ROLLBACK_ENABLED=true
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
