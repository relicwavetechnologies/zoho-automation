# Agent Seat harness

Use this path when **you** are the model and Cursor is sitting in the runtime
agent seat: read real skills, invoke real gateway tools under a named user's
RBAC, and walk multi-turn scenarios without spinning up cloud Pi.

Pi Docker is **not** required for Agent Seat v1.

## When to use which harness

| Path | Who decides tool calls | Proves |
| --- | --- | --- |
| **Agent Seat** (`agent-seat.ts`) | Human + Cursor reading skills | Skill clarity, tool graphs, RBAC, export planning |
| **Direct Pi harness** ([02-lark-dm-harness.md](./02-lark-dm-harness.md)) | Cloud Pi model | Model compliance with skills |
| **Live Lark** ([03-live-lark-webhook.md](./03-live-lark-webhook.md)) | Cloud Pi model | Full ingress and delivery |

## Prerequisites

Complete [01-setup-and-secrets.md](./01-setup-and-secrets.md):

```bash
cd advance-backend
pnpm dev:e2e   # Development DB tunnel + Redis
```

Agent Seat talks to the database and gateway **in-process** via
`buildAgentSeatContainer()` (full gateway wiring; skips Lark bot-identity init).
It does not need the Pi controller on `:4317` or `pnpm dev` for tool invokes.

### Delivery chat (per tester)

Export candidates and Lark-scoped runtime context need a **chat id** (`oc_…`).
Each teammate uses their own DM with Divo or a dedicated test group.

**Do not commit personal chat ids to git.**

1. Add to local `advance-backend/.env` only:

```bash
AGENT_SEAT_DELIVERY_CHAT_ID=oc_your_lark_chat_id_here
```

2. Or pass on every `init`:

```bash
pnpm tsx scripts/agent-seat.ts init --user "you@company.com" --chat-id oc_your_lark_chat_id_here
```

The chosen id is stored in gitignored `.agent-seat/session.json` for later
commands (`invoke`, `turn begin`, etc.).

See also `AGENTS.local.example.md` → **Agent Seat harness**.

## Rules

- **No default user.** Every session requires `init --user <email|name|open_id>`.
- **No default chat.** `AGENT_SEAT_DELIVERY_CHAT_ID` or `init --chat-id` required.
- **Full gateway access** for the selected user's RBAC (same tools Pi would see).
- Session state lives in gitignored `.agent-seat/session.json`.

## Quick start

```bash
cd advance-backend

pnpm tsx scripts/agent-seat.ts init --user "you@company.com"
pnpm tsx scripts/agent-seat.ts whoami
pnpm tsx scripts/agent-seat.ts bootstrap
pnpm tsx scripts/agent-seat.ts skill research-router
pnpm tsx scripts/agent-seat.ts skill divo-semrush-seo-research
pnpm tsx scripts/agent-seat.ts turn begin
pnpm tsx scripts/agent-seat.ts invoke semrush '{"operation":"backlinks_comparison","targets":["a.com","b.com"]}'
pnpm tsx scripts/agent-seat.ts note "Skill gap: ..."
pnpm tsx scripts/agent-seat.ts state
```

## Multi-turn export testing

1. `turn begin` before each user prompt you simulate.
2. Run Semrush (or other source) on turn 1 — this mints `exportCandidate` rows
   scoped to the session `runtimeRunId`.
3. On turn 2 ("excel"), call:

```bash
pnpm tsx scripts/agent-seat.ts invoke dataExport '{"op":"list_candidates","scope":"run"}'
pnpm tsx scripts/agent-seat.ts invoke dataExport '{"op":"plan","datasets":[{"candidateId":"..."}],"destination":{"format":"xlsx","title":"..."},"userIntent":"explicit_export"}'
```

Use `list_candidates` only when unsure which candidate matches the table you
showed. Never surface candidate IDs to the member in real product copy.

## Scenarios

Bundled walkthrough guides live under `scenarios/agent-seat/`:

```bash
pnpm tsx scripts/agent-seat.ts scenario list
pnpm tsx scripts/agent-seat.ts scenario show shy-semrush-export
```

v1 scenarios are **manual** checklists. Automated `scenario verify` may come
later.

## Performance expectations

Each `agent-seat` command is a **separate Node process** that boots the gateway
in-process (`buildAgentSeatContainer`). Expect:

| Phase | Typical time |
| --- | --- |
| Container boot | ~1–3s first run; often faster on warm machine |
| `whoami` / `turn begin` | Milliseconds after boot |
| `invoke semrush` `backlinks_comparison` with N domains | **N sequential Semrush API calls** (up to `SEMRUSH_TIMEOUT_MS` each, default 15s) |

`backlinks_comparison` accepts at most **10 targets** per call (tool schema).

Progress lines go to **stderr** (`[agent-seat] container ready …`) so JSON on
stdout stays pipe-friendly. The CLI **exits immediately** after each command;
do not chain with `tail` expecting streaming output mid-run.

**Tips**

- Run one command at a time; avoid `cmd1 && cmd2` unless you accept double boot.
- Skip redundant `turn begin` when you only need `invoke`.
- For long Semrush pulls, watch stderr timing and backend logs.

## Commands

| Command | Purpose |
| --- | --- |
| `init --user … [--chat-id …] [--department …]` | Resolve DB identity and create session |
| `whoami` | Principal summary (includes bound `chatId`) |
| `bootstrap` | `capabilities.get` + router `skills.list` |
| `skill <slug>` | Full skill markdown via `skills.get` |
| `skill search <query>` | Router search |
| `invoke <toolId> '<json>'` | `tools.invoke` with session run context |
| `gateway '<json>'` | Raw gateway op |
| `turn begin` | New turn + trace id |
| `state` | Session + last invoke hint |
| `note "…"` | Append finding to session notes |
| `scenario list` / `scenario show` | Bundled scenario guides |

## Source of truth

- [`scripts/agent-seat.ts`](../../scripts/agent-seat.ts)
- [`src/application/agent-seat/`](../../src/application/agent-seat/)
- [`scenarios/agent-seat/README.md`](../../scenarios/agent-seat/README.md)
- Root [`AGENTS.md`](../../../../AGENTS.md) — Agent Seat section for teammates
