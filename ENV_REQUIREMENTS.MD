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
```

## Lark Integration (Only Needed For Real Lark Webhooks/Messaging)

```env
LARK_API_BASE_URL=https://open.larksuite.com
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_BOT_TENANT_ACCESS_TOKEN=...
LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS=180
LARK_TENANT_TOKEN_FETCH_MAX_RETRIES=3
LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS=250
LARK_WEBHOOK_SIGNING_SECRET=...
LARK_WEBHOOK_MAX_SKEW_SECONDS=300
```

Notes:
- Preferred mode is automatic tenant token lifecycle using `LARK_APP_ID` + `LARK_APP_SECRET`.
- `LARK_BOT_TENANT_ACCESS_TOKEN` remains optional as emergency fallback override for local/dev recovery.
- `LARK_API_BASE_URL` is optional and defaults to `https://open.larksuite.com`.

## Frontend Admin

```env
VITE_API_BASE_URL=http://localhost:8000
```

## Currently Not Required For Active Flow

These may exist in your `.env`, but are not required for the currently active backend/admin runtime paths:

- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_REDIRECT_URI`
- `API_KEY_MASTER_SECRET`
- `APP_BASE_URL`
- `SESSION_SECRET`
