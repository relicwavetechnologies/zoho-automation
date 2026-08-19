# AGENTS.md
> Shared working rules for AI coding agents in this workspace.

## Local operational context

If `AGENTS.local.md` exists at the repository root, read it before starting
local infrastructure, using local credentials, or running cloud-Pi/Lark E2E
tests. It is intentionally ignored and contains local-only operational context;
never copy its secrets into tracked files or output. New teammates: copy
`AGENTS.local.example.md` to `AGENTS.local.md`, then fill secrets from a team
lead and `advance-backend/.env.example`.

For local backend + controller + Dockerized Cloud-Pi runs delivered to Lark,
follow [`advance-backend/docs/cloud-pi-testing/07-local-runtime-harness-framework.md`](advance-backend/docs/cloud-pi-testing/07-local-runtime-harness-framework.md).
It defines the executable Development path, inspection-only Main boundary,
prompt disclosure, evidence, rerun, and Divo-only cleanup rules.

## Start the local stack

Use separate terminals so failures stay attributable. Docker Desktop must be
running. Read `AGENTS.local.md` first; do not put secrets in this file.

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

`pnpm dev:e2e` is a no-op for Redis or the tunnel when they are already up. The
Cloud-Pi container is idle-stopped and starts on an admitted run; do not treat
a stopped `divo-pi-local:*` container as a failed stack.

Preflight:

```bash
curl -fsS http://127.0.0.1:8000/health
curl -fsS http://127.0.0.1:4317/health
curl -fsS -o /dev/null -w "%{http_code}\n" http://localhost:5173/
```

Require backend `status: ok` and controller `activeRuns: 0`. Native-skills
tests must show a `native_skills.ready` controller event before Pi starts.

Stop foreground backend, controller, and admin with Ctrl+C, then
`cd advance-backend && pnpm stop` for Redis and the Development tunnel. That
does not delete Divo containers, images, networks, or workspace volumes.

## Prime Directive

Code quality is the priority. Do not rush wiring that creates dead code, unclear ownership, duplicated flows, conflicting comments, or hidden security gaps. Reason from the existing code structure before editing.

This workspace contains several structured codebases:

- `advance-backend/` — Divo backend and company capability gateway candidate.
- `admin/` — admin control dashboard (`pnpm dev` on port 5173).
- `jan/` — current desktop app target.
- `pi/` — vendored Pi agent harness source.
- `pi-bridge/` — local experiment; do not treat it as the target architecture unless explicitly asked.

## Current Architecture Direction

Divo should integrate with Pi through a backend-owned capability gateway:

```txt
Desktop: Jan auths with advance-backend -> bundled Pi runs locally
Lark: webhook admission -> LarkPiRuntimeService -> private controller
  -> isolated per-user Divo container -> Pi runtime
Both: the Divo extension registers typed Pi tools from backend contracts
  -> every call crosses one backend capability gateway
  -> advance-backend authenticates, resolves user/departments, enforces RBAC/HITL, executes tool
```

Do not move RBAC, SaaS credentials, OAuth ownership, or enterprise policy into Pi. Pi is the agent/runtime layer. `advance-backend` is the authority for identity, permissions, tools, approvals, auditing, and external integrations.

Lark agent turns use the isolated cloud-Pi path only. Never route them through
the Vercel AI SDK orchestration engine, and never hide a Pi failure by falling
back to that engine. User-facing Lark copy says **Divo**, not Pi.

## Non-Negotiable Engineering Rules

1. Inspect before editing.
   Read the relevant files and tests before changing code. Do not guess the shape of an API, service, route, or extension point.

2. Keep changes small and phase-based.
   Prefer a working vertical slice over a large rewrite. Each phase should have a clear behavior change and tests where practical.

3. No silent dead code.
   If a change makes old code unused, conflicting, or misleading, stop and ask: "This code is now dead; should we remove it?" Do not leave garbage behind silently.

4. No conflicting comments.
   Comments must describe current behavior. Remove or update comments that become stale.

5. No duplicate authority.
   There must not be two independent places deciding auth, RBAC, tool access, or approval policy. Backend owns these decisions.

6. Use existing patterns first.
   Match the local service, route, test, and type patterns before adding new abstractions.

7. Do not modify vendored Pi core unless explicitly necessary.
   Prefer a Divo-owned Pi extension and configuration. Core Pi source changes require a clear reason.

8. Do not expose admin APIs to Pi.
   Pi should call one constrained gateway surface, not internal admin routes.

9. Do not give Pi direct SaaS credentials.
   Zoho, Lark, Google, Meta Ads, and future integration tokens stay server-side.

10. Ask before destructive cleanup.
    Do not delete intentional legacy code, routes, or data paths without explicit confirmation.

## Backend Standards

All new backend work should stay inside `advance-backend/` unless the task explicitly touches desktop or Pi.

Follow the existing layering:

```txt
http -> application -> domain <- infrastructure
```

Gateway work should prefer:

- `application/gateway/*` for dispatch/execution services.
- `http/gateway/*` for Express routes.
- Existing `PermissionService` for RBAC.
- Existing `ToolRegistry` and tool contracts for execution.
- Existing member auth/session concepts for user identity.

Do not flatten tool results into LLM string envelopes for the external gateway. Return structured JSON.

## Pi Integration Standards

Pi integration should be additive:

- Use one Divo gateway extension that registers one typed Pi tool per reachable
  backend contract.
- Generate tool inputs from the backend `argsSchema`; do not recreate the
  removed mega-tool `{ op, payload }` envelope.
- Skills/instructions may be loaded from backend responses, but enforcement remains backend-side.
- Pi should not know implementation details of Zoho/Lark/Google tools beyond what backend capabilities expose.

## Desktop Standards

Jan/Desktop should own local user experience:

- Start auth.
- Store the backend member session securely.
- Start or connect to bundled Pi.
- Provide the Divo gateway tool configuration/token path.
- Surface departments as user-selectable context, not as a complex policy engine in V1.

## Database Environment Rules

Development and Main use separate PostgreSQL containers, databases, users,
networks, and Docker volumes. Never treat them as a shared database.

- Local `advance-backend/.env` and `scripts/db-tunnel.sh` target the live
  Development database only (`localhost:15432` -> VPS `127.0.0.1:15433` ->
  `divo_dev`). A local `prisma db push` never promotes schema or data to Main.
- Main's schema source of truth is the `schema.prisma` committed on the `main`
  branch. Main deployment's `divo-schema-sync` applies that checked-in schema
  to `divo_main` before the backend starts.
- A successful Main schema sync means Main matches the Main branch schema; it
  does not mean Main matches Development. Schema changes must be committed and
  merged to `main` before deploying Main.
- Deployments synchronize schema only. They do not copy application rows,
  Hindsight memory, Redis state, or files. Development-to-Main data cloning is
  a separate, explicit, destructive, manual operation that requires a verified
  Main backup and rollback path.

## Testing Expectations

Backend gateway work needs focused tests:

- Missing/invalid auth.
- Unknown `op`.
- Unknown `toolId`.
- Invalid tool args.
- Permission denied.
- Allowed invocation.
- Skills/tools filtered by RBAC.
- HITL pending response when approval is required.

Run the narrowest relevant tests first. Broaden only when the blast radius warrants it.

## Agent Seat harness (skill and tool testing without Pi)

Use Agent Seat when **you are the runtime agent**: load real skills from the
gateway, invoke real tools under a named user's RBAC, and walk multi-turn flows
**without** cloud Pi, Lark webhooks, or the Vercel orchestration engine.

This is the right path for validating **skill clarity**, **tool graphs**, RBAC,
and one governed provider call before asking Pi to comply. It does not prove
terminal/file workflows because Agent Seat does not run the Cloud-Pi container.

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
2. Set **`AGENT_SEAT_DELIVERY_CHAT_ID`** in `advance-backend/.env` (your Lark
   DM with Divo or a test group) **or** pass `--chat-id` on `init`.
3. Start infra: `cd advance-backend && pnpm dev:e2e` (Development DB on
   `127.0.0.1:15432` + Redis).
4. Pi controller and `pnpm dev` are **not** required — Agent Seat calls
   `GatewayDispatcher` in-process.

### Session rules

- **No default user.** Always `init --user <email|name|open_id>` first.
- **No default delivery chat.** Set `AGENT_SEAT_DELIVERY_CHAT_ID` in local
  `advance-backend/.env` or pass `init --chat-id <oc_…>`. Use your own Lark DM
  with Divo or a test group — **never commit personal chat ids to git**. The
  bound `chatId` is stored in gitignored `.agent-seat/session.json`.
- Session state: `advance-backend/.agent-seat/session.json` (gitignored).
- One CLI command = one Node process (~1–3s boot). Progress on **stderr**
  (`[agent-seat] container ready …`); JSON on stdout. Commands exit immediately
  after work (do not chain with `tail` expecting streaming).

### Think like the agent (manual seat workflow)

Do **not** improvise tool calls from memory. Follow the same steps Pi should:

1. **`init --user …`** — bind a real Development identity and RBAC.
2. **`turn begin`** — new turn + trace id before each simulated user prompt.
3. **`skill research-router`** — route to the specialist skill slug.
4. **`skill <specialist>`** — read instructions and tool recipe (e.g.
   `divo-semrush-seo-research` for Semrush).
5. **`invoke <toolId> '<json>'`** — one governed call matching the skill; use
   preflight mentally (schema + skill limits) before invoking.
6. **Answer shy** — keep bounded provider previews honest and never present a
   partial page as a complete dataset.
7. **`note "…"`** — record skill gaps, schema surprises, or provider blocks for
   the next engineer.

### Semrush comparison (what Agent Seat can prove)

For Semrush comparison prompts:

- **Do:** one `backlinks_comparison` with all targets the user named (within
  schema max).
- **Do not:** fan out `domain_overview` per domain.
- **Do not:** claim complete coverage when the operation exposes no truthful
  continuation. Use the Cloud-Pi harness for terminal/file workflow proof.

Skill sources of truth:

- `divo-semrush-seo-research` — operations, cost rules (`backlinks_comparison`
  = one web request for all targets), export follow-up copy.
- `research-router` — Semrush vs web-search vs OMS routing.

### Performance and failure modes (learned in practice)

| Symptom | Cause | What to do |
| --- | --- | --- |
| Shell hangs after JSON | Old CLI left BullMQ Redis sockets open | Fixed: forced exit after `shutdownAgentSeatContainer()` |
| `turn begin && invoke` feels 2× slow | Each subcommand cold-starts the gateway | Run one command at a time; accept ~1–3s boot |
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

Automated tests for the harness:
`advance-backend/tests/application/agent-seat.service.test.ts`.

## When In Doubt

Pause and ask before:

- Removing old runtime code.
- Changing auth/session shape.
- Changing permission semantics.
- Modifying Pi core.
- Exposing new backend routes to the desktop or agent.
- Creating a second way to invoke company tools.
