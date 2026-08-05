# Local Divo operations (copy to AGENTS.local.md)

> Copy this file to `AGENTS.local.md` at the repo root and fill in the
> placeholders. `AGENTS.local.md` is gitignored (`*.local.md`). **Never commit
> real passwords, keys, or API secrets.**

Get the full `advance-backend/.env` from a teammate who already has local dev
working (secure channel: 1Password, encrypted DM, etc.). Password-only tunnel
auth is enough to reach Postgres; Lark/Google/API keys still come from `.env`.

## Authority and safety

- Lark turns use **isolated cloud Pi only**. Never fall back to the legacy
  Vercel AI SDK engine.
- Backend owns identity, OAuth, RBAC, provider credentials, HITL, export queue,
  artifact delivery, and auditing.
- Development and Main are separate databases. Local tunnel always targets
  Development (`divo_dev`).
- The shared VPS also hosts unrelated Grind work. Stay within Divo targets only.

## Development database tunnel

```txt
VPS:           103.172.92.187
SSH user:      deploy          (not root — root SSH is disabled/wrong password)
Local port:    127.0.0.1:15432
Remote port:   127.0.0.1:15433 (Postgres sidecar on VPS)
Database:      divo_dev
```

### Option A — SSH key (if you were given a deploy key)

In `advance-backend/.env`:

```txt
DB_TUNNEL_SSH_HOST=103.172.92.187
DB_TUNNEL_SSH_USER=deploy
DB_TUNNEL_SSH_IDENTITY_FILE=/absolute/path/to/your/private/key
DB_TUNNEL_LOCAL_PORT=15432
DB_TUNNEL_REMOTE_HOST=127.0.0.1
DB_TUNNEL_REMOTE_PORT=15433
DB_TUNNEL_DB_NAME=divo_dev
```

### Option B — VPS password (no SSH key)

Requires `sshpass` (`brew install sshpass` on macOS).

In `advance-backend/.env` (local only):

```txt
DB_TUNNEL_SSH_HOST=103.172.92.187
DB_TUNNEL_SSH_USER=deploy
DB_TUNNEL_SSH_PASSWORD=<ask team lead — deploy user password, not root panel password>
DB_TUNNEL_LOCAL_PORT=15432
DB_TUNNEL_REMOTE_HOST=127.0.0.1
DB_TUNNEL_REMOTE_PORT=15433
DB_TUNNEL_DB_NAME=divo_dev
```

Do **not** set `DB_TUNNEL_SSH_IDENTITY_FILE` when using password auth.

Verify:

```bash
cd advance-backend
bash scripts/db-tunnel.sh start
bash scripts/db-tunnel.sh status
```

## Start local stack

```bash
cd advance-backend
pnpm dev:e2e   # tunnel + Redis queue/cache
pnpm dev       # backend + Google Workspace MCP sidecar
```

Expected services:

```txt
backend HTTP:                  http://127.0.0.1:8000
Pi local RPC controller:       http://127.0.0.1:4317  (start separately — see cloud-pi-testing docs)
Development Postgres tunnel:   127.0.0.1:15432
Redis queue:                   127.0.0.1:6380
Redis cache:                   127.0.0.1:6381
```

Health checks:

```bash
curl -fsS http://127.0.0.1:8000/health
./scripts/db-tunnel.sh status
redis-cli -p 6380 ping
```

## Agent Seat harness (optional)

Use Agent Seat when you are the runtime agent testing skills and tools without
cloud Pi. Each tester binds **their own** Lark delivery target:

1. Open Lark → DM with Divo (or create a dedicated test group).
2. Copy the chat id (`oc_…`) from an existing harness script, Lark dev tools,
   or ask a teammate how your team resolves chat ids locally.
3. In `advance-backend/.env` (local only, never commit):

```txt
AGENT_SEAT_DELIVERY_CHAT_ID=oc_your_chat_id_here
```

4. Initialize:

```bash
cd advance-backend
pnpm dev:e2e
pnpm tsx scripts/agent-seat.ts init --user "you@company.com"
# or: init --user "..." --chat-id oc_your_chat_id_here
```

Full walkthrough: `advance-backend/docs/cloud-pi-testing/06-agent-seat.md` and
the **Agent Seat harness** section in root `AGENTS.md`.

## Further reading (tracked in git)

- `advance-backend/docs/cloud-pi-testing/AGENTS.md` — cloud-Pi E2E router
- `advance-backend/docs/cloud-pi-testing/01-setup-and-secrets.md` — full stack startup
- `advance-backend/.env.example` — all env key names and non-secret defaults
