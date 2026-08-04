# AGENTS.md
> Shared working rules for AI coding agents in this workspace.

## Local operational context

If `AGENTS.local.md` exists at the repository root, read it before starting
local infrastructure, using local credentials, or running cloud-Pi/Lark E2E
tests. It is intentionally ignored and contains local-only operational context;
never copy its secrets into tracked files or output. New teammates: copy
`AGENTS.local.example.md` to `AGENTS.local.md`, then fill secrets from a team
lead and `advance-backend/.env.example`.

## Prime Directive

Code quality is the priority. Do not rush wiring that creates dead code, unclear ownership, duplicated flows, conflicting comments, or hidden security gaps. Reason from the existing code structure before editing.

This workspace contains several structured codebases:

- `advance-backend/` — Divo backend and company capability gateway candidate.
- `jan/` — current desktop app target.
- `pi/` — vendored Pi agent harness source.
- `pi-bridge/` — local experiment; do not treat it as the target architecture unless explicitly asked.

## Current Architecture Direction

Divo should integrate with Pi through a backend-owned capability gateway:

```txt
Desktop: Jan auths with advance-backend -> bundled Pi runs locally
Lark: webhook admission -> LarkPiRuntimeService -> private controller
  -> isolated per-user Divo container -> Pi runtime
Both: Pi calls one Divo tool with op + payload
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

- Add one Divo gateway tool extension.
- Tool input should be `{ op, departmentId?, payload }`.
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

This is the right path for validating **skill clarity**, **tool graphs**, shy
answer behavior, and export planning before asking Pi to comply.

### References

| What | Where |
| --- | --- |
| CLI entry | `advance-backend/scripts/agent-seat.ts` |
| Service + session | `advance-backend/src/application/agent-seat/` |
| Slim container (skips Lark init) | `advance-backend/src/application/agent-seat/agent-seat-container.ts` |
| Delivery chat resolution | `advance-backend/src/application/agent-seat/agent-seat-delivery-chat.ts` |
| Full harness doc | `advance-backend/docs/cloud-pi-testing/06-agent-seat.md` |
| Shy Semrush + export scenario | `advance-backend/scenarios/agent-seat/shy-semrush-export.yaml` |
| Export orchestration spec | `plans/ai-controlled-data-export-orchestration.md` |
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
6. **Answer shy** — one main table in chat; at most 25 preview rows; soft
   export follow-up only when `exportCandidate` exists and the member did not
   refuse export.
7. **Turn 2 (e.g. "excel")** — `invoke dataExport` with `op=list_candidates`
   only when unsure, then `op=plan` with one dataset. Never show candidate
   UUIDs or picker tables to the member.
8. **`note "…"`** — record skill gaps, schema surprises, or provider blocks for
   the next engineer.

### Shy answer + model-planned export (what we are proving)

For Semrush comparison prompts:

- **Do:** one `backlinks_comparison` with all targets the user named (within
  schema max).
- **Do not:** fan out `domain_overview` per domain.
- **Do not:** rerun Semrush after the member picks a format — `dataExport`
  `op=plan` owns pagination and artifact creation.

Skill sources of truth:

- `divo-semrush-seo-research` — operations, cost rules (`backlinks_comparison`
  = one billed request **per target**), export follow-up copy.
- `research-router` — Semrush vs web-search vs OMS routing.

### Performance and failure modes (learned in practice)

| Symptom | Cause | What to do |
| --- | --- | --- |
| Shell hangs after JSON | Old CLI left BullMQ Redis sockets open | Fixed: forced exit after `shutdownAgentSeatContainer()` |
| `turn begin && invoke` feels 2× slow | Each subcommand cold-starts the gateway | Run one command at a time; accept ~1–3s boot |
| `invoke semrush` takes minutes | N targets ⇒ N **sequential** Semrush API calls (15s timeout each) | Normal; watch stderr timing |
| `invalid_args` targets max 10 | Tool schema caps `backlinks_comparison` at 10 domains | Split batch, drop a domain, or tell the member — do not silently omit |
| `provider_insufficient_units` | Dev Semrush key/web session out of units | Report `blocked` honestly per skill; fix env or use web path |

### Example commands (shy Semrush export scenario)

```bash
cd advance-backend
# once per machine: AGENT_SEAT_DELIVERY_CHAT_ID=oc_... in .env
pnpm tsx scripts/agent-seat.ts init --user "you@company.com"
pnpm tsx scripts/agent-seat.ts turn begin
pnpm tsx scripts/agent-seat.ts skill divo-semrush-seo-research
pnpm tsx scripts/agent-seat.ts invoke semrush '{"operation":"backlinks_comparison","targets":["a.com","b.com"]}'
# turn 2:
pnpm tsx scripts/agent-seat.ts turn begin
pnpm tsx scripts/agent-seat.ts invoke dataExport '{"op":"list_candidates","scope":"run"}'
pnpm tsx scripts/agent-seat.ts invoke dataExport '{"op":"plan","datasets":[{"candidateId":"..."}],"destination":{"format":"xlsx","title":"..."},"userIntent":"explicit_export"}'
pnpm tsx scripts/agent-seat.ts scenario show shy-semrush-export
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
