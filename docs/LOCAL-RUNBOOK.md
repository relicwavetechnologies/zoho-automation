# Local runbook

Operational steps for running the local stack and the Agent Seat harness. Rules and architecture live in `AGENTS.md`; this file is procedure only. Read `AGENTS.local.md` at the repo root before using local credentials, and never copy its secrets into tracked files or output.

## Start the local stack

One command, from the repository root. Docker Desktop must be running.

```bash
scripts/dev-stack.sh
```

That brings up the tunnel, both Redis instances, the Pi controller, the backend with its Google Workspace MCP sidecar, and the admin UI, in that order, and it does not report a service as up until that service's own health check answers. First boot takes roughly 90 seconds, most of it the backend reconciling the tool and skill catalogue.

| Command | What it does |
| --- | --- |
| `scripts/dev-stack.sh` | Start everything and wait for it. Safe to re-run. |
| `scripts/dev-stack.sh status` | What is up right now, with URLs. |
| `scripts/dev-stack.sh logs` | Tail every service log at once. |
| `scripts/dev-stack.sh stop` | Stop the stack. Leaves containers, images and volumes alone. |

Re-running `start` is a repair, not a restart. Anything already healthy is left running and only the dead services are brought back, so when one service falls over you run the same command again rather than tearing the stack down. Each service writes to its own file under `.dev-stack/logs/`, which is what the four-terminal layout below was really buying. When a service fails to come up, the script prints the tail of that service's log and exits non-zero rather than reporting a stack that is not there.

### By hand, four terminals

Useful when you want a service in the foreground, or when you are changing one service repeatedly and want to restart just it. Same commands the script runs.

Use separate terminals so failures stay attributable. Docker Desktop must be running.

```bash
# Terminal 1 — Development tunnel + Redis (exits when infra is up)
cd advance-backend
pnpm dev:e2e
bash scripts/db-tunnel.sh status

# Terminal 2 — Pi controller (long-running)
# Rebuild only after a divo-pi runtime, extension, skill, or Dockerfile change:
#   cd divo-pi && docker build -t divo-pi-local:phase0 .
cd divo-pi
MAX_ACTIVE_RUNS=2 node divo/local-rpc-server.mjs

# Terminal 3 — backend + Google Workspace MCP sidecar (long-running)
cd advance-backend
pnpm dev

# Terminal 4 — admin UI (long-running)
cd admin
pnpm dev
```

Expected services:

```txt
backend HTTP:                  http://127.0.0.1:8000
admin UI:                      http://localhost:5173
Pi local RPC controller:       http://127.0.0.1:4317
Google Workspace MCP sidecar:  http://127.0.0.1:18000/mcp
Development Postgres tunnel:   127.0.0.1:15432
Redis queue / cache:           127.0.0.1:6380 / 127.0.0.1:6381
```

`pnpm dev:e2e` is a no-op for Redis or the tunnel when they are already up. The Cloud-Pi container is idle-stopped and starts on an admitted run; do not treat a stopped `divo-pi-local:*` container as a failed stack.

Preflight:

```bash
curl -fsS http://127.0.0.1:8000/health
curl -fsS http://127.0.0.1:4317/health
curl -fsS -o /dev/null -w "%{http_code}\n" http://localhost:5173/
```

Require backend `status: ok` and controller `activeRuns: 0`. Native-skills tests must show a `native_skills.ready` controller event before Pi starts.

Stop foreground backend, controller, and admin with Ctrl+C, then `cd advance-backend && pnpm stop` for Redis and the Development tunnel. That does not delete Divo containers, images, networks, or workspace volumes.

## Agent Seat harness (skill and tool testing without Pi)

Use Agent Seat when **you are the runtime agent**: load real skills from the gateway, invoke real tools under a named user's RBAC, and walk multi-turn flows **without** cloud Pi, Lark webhooks, or the Vercel orchestration engine.

This is the right path for validating **skill clarity**, **tool graphs**, RBAC, and one governed provider call before asking Pi to comply. It does not prove terminal/file workflows because Agent Seat does not run the Cloud-Pi container.

### References

| What | Where |
| --- | --- |
| CLI entry | `advance-backend/scripts/agent-seat.ts` |
| Service + session | `advance-backend/src/application/agent-seat/` |
| Slim container (skips Lark init) | `advance-backend/src/application/agent-seat/agent-seat-container.ts` |
| Delivery chat resolution | `advance-backend/src/application/agent-seat/agent-seat-delivery-chat.ts` |
| Full harness doc | `advance-backend/docs/cloud-pi-testing/06-agent-seat.md` |
| Cloud-Pi harness comparison | `advance-backend/docs/cloud-pi-testing/02-lark-dm-harness.md` |

### Prerequisites

1. Read `AGENTS.local.md` for local DB tunnel and secrets (never commit it).
2. Set `AGENT_SEAT_DELIVERY_CHAT_ID` in `advance-backend/.env` (your Lark DM with Divo or a test group) **or** pass `--chat-id` on `init`.
3. Start infra: `cd advance-backend && pnpm dev:e2e` (Development DB on `127.0.0.1:15432` + Redis).
4. Pi controller and `pnpm dev` are **not** required — Agent Seat calls `GatewayDispatcher` in-process.

### Session rules

- **No default user.** Always `init --user <email|name|open_id>` first.
- **No default delivery chat.** Set `AGENT_SEAT_DELIVERY_CHAT_ID` in local `advance-backend/.env` or pass `init --chat-id <oc_…>`. Use your own Lark DM with Divo or a test group — **never commit personal chat ids to git**. The bound `chatId` is stored in gitignored `.agent-seat/session.json`.
- Session state: `advance-backend/.agent-seat/session.json` (gitignored).
- One CLI command = one Node process (\~1–3s boot). Progress on **stderr**(`[agent-seat] container ready …`); JSON on stdout. Commands exit immediately after work (do not chain with `tail` expecting streaming).

### Think like the agent (manual seat workflow)

Do **not** improvise tool calls from memory. Follow the same steps Pi should:

1. `init --user …` — bind a real Development identity and RBAC.
2. `turn begin` — new turn + trace id before each simulated user prompt.
3. `skill research-router` — route to the specialist skill slug.
4. `skill <specialist>` — read instructions and tool recipe (e.g. `divo-semrush-seo-research` for Semrush).
5. `invoke <toolId> '<json>'` — one governed call matching the skill; use preflight mentally (schema + skill limits) before invoking.
6. **Answer shy** — keep bounded provider previews honest and never present a partial page as a complete dataset.
7. `note "…"` — record skill gaps, schema surprises, or provider blocks for the next engineer.

### Semrush comparison (what Agent Seat can prove)

For Semrush comparison prompts:

- **Do:** one `backlinks_comparison` with all targets the user named (within schema max).
- **Do not:** fan out `domain_overview` per domain.
- **Do not:** claim complete coverage when the operation exposes no truthful continuation. Use the Cloud-Pi harness for terminal/file workflow proof.

Skill sources of truth:

- `divo-semrush-seo-research` — operations, cost rules (`backlinks_comparison`= one web request for all targets), export follow-up copy.
- `research-router` — Semrush vs web-search vs OMS routing.

### Performance and failure modes (learned in practice)

| Symptom | Cause | What to do |
| --- | --- | --- |
| Shell hangs after JSON | Old CLI left BullMQ Redis sockets open | Fixed: forced exit after `shutdownAgentSeatContainer()` |
| `turn begin && invoke` feels 2× slow | Each subcommand cold-starts the gateway | Run one command at a time; accept \~1–3s boot |
| `invoke semrush` slow | One web request per op (15s timeout default) | Normal; watch stderr timing |
| `invalid_args` targets max 10 | Tool schema caps `backlinks_comparison` at 10 domains | Split batch, drop a domain, or tell the member — do not silently omit |
| `blocked` / auth errors | Missing or expired `SEMRUSH_WEB_COOKIE` / `SEMRUSH_WEB_API_KEY` | Refresh web session in backend env |

### Example commands

```bash
cd advance-backend
# once per machine: AGENT_SEAT_DELIVERY_CHAT_ID=oc_... in .env
pnpm tsx scripts/agent-seat.ts init --user "you@company.com"
pnpm tsx scripts/agent-seat.ts turn begin
pnpm tsx scripts/agent-seat.ts skill divo-semrush-seo-research
pnpm tsx scripts/agent-seat.ts invoke semrush '{"operation":"backlinks_comparison","targets":["a.com","b.com"]}'
```

Automated tests for the harness: `advance-backend/tests/application/agent-seat.service.test.ts`.
