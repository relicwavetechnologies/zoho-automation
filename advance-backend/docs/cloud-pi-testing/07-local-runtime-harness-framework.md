# Local Cloud-Pi runtime testing framework

Use this framework to exercise local Divo code through the real Cloud-Pi
runtime boundary and deliver its status and final answer to a controlled Lark
chat. The driver is [`scripts/run-engine-harness.ts`](../../scripts/run-engine-harness.ts).

This is not Agent Seat, a webhook simulation, or the retired Vercel AI SDK
engine. The lifecycle is:

```text
run-engine-harness.ts
  -> local backend (:8000)
  -> local private Pi controller (:4317)
  -> local divo-pi Docker container
  -> governed backend tools and server-owned provider credentials
  -> production Lark status/final renderer -> allowlisted test chat
```

## Safety boundary

- Read root `AGENTS.md`, `AGENTS.local.md`, and
  [`01-setup-and-secrets.md`](./01-setup-and-secrets.md) first.
- Operate only on Divo processes, containers, images, networks, and volumes.
  Never stop, restart, prune, or inspect Grind resources.
- Never print or commit credentials, database URLs, member tokens, chat IDs, or
  bulk provider rows.
- The harness can cause real provider and Lark side effects. A missing final
  card does not make a run side-effect-free.
- Announce the exact prompt before firing it. When a run exposes a defect,
  report the evidence and intended code correction before rerunning.

## Database modes

### Development: executable E2E mode

Development is the normal and only automatic harness target. The checked-in
`scripts/db-tunnel.sh` and local `.env` must resolve to `divo_dev`. Start it with:

```bash
cd advance-backend
pnpm dev:e2e
bash scripts/db-tunnel.sh status
```

It opens the Development tunnel and local Redis instances. It does not start
the backend. Reconcile skills or run migrations only against Development and
only when the current change requires it.

### Main/production: inspection-only mode

Main is not an executable harness target. Use a separately supplied,
read-only Main tunnel profile only to inspect traces, sanitize historical
prompts, or establish expected counts. Never point `pnpm dev`, workers,
reconciliation, Prisma writes, or `run-engine-harness.ts` at Main.

If a read-only profile is explicitly provided in `AGENTS.local.md`, isolate it
from Development with its own environment file, local port, and state directory:

```bash
DB_TUNNEL_ENV_FILE=/absolute/path/to/main-readonly.env \
DB_TUNNEL_STATE_DIR=/absolute/path/to/main-readonly-state \
bash advance-backend/scripts/db-tunnel.sh start
```

Verify that the database user is read-only before querying. Copy no raw prompt,
trace, row, token, email, or chat identifier into tracked fixtures. Sanitize the
prompt, close the Main tunnel, restore the Development environment, then replay
through the local harness. A mutating Main test requires a separate explicit
production-test authorization and is outside this framework.

## Start the local runtime

Use separate terminals so failures remain attributable.

```bash
# Terminal 1 — Development tunnel + Redis
cd advance-backend
pnpm dev:e2e

# Terminal 2 — rebuild after any divo-pi runtime/extension/skill change
cd divo-pi
docker build -t divo-pi-local:phase0 .
MAX_ACTIVE_RUNS=2 node divo/local-rpc-server.mjs

# Terminal 3 — backend + Google Workspace MCP sidecar
cd advance-backend
pnpm dev
```

Native backend skills are the default. `DIVO_PI_NATIVE_DB_SKILLS=false` is a
rollback switch, not a normal test setting; a native-skills test must show a
`native_skills.ready` controller event before Pi starts.

Preflight before every prompt:

```bash
curl -fsS http://127.0.0.1:4317/health | jq .
curl -fsS http://127.0.0.1:8000/health | jq .
```

Require backend health and controller `activeRuns: 0`. If a previous run was
interrupted, stop only the exact Divo-labelled test container; do not use broad
Docker cleanup commands.

## Fire a prompt

Show the human the literal prompt first, including the source account,
destination account, date range, completeness requirement, and verification
criterion when those facts matter. Then run from `advance-backend/`:

```bash
pnpm tsx scripts/run-engine-harness.ts \
  --model pro \
  --fresh-context \
  "<the exact prompt already shown to the human>"
```

Important controls:

- `--fresh-context` isolates the Pi conversation but keeps the user's durable
  container workspace.
- `--no-final-delivery` suppresses harness status/final cards only; governed
  tools can still mutate providers or send approval/review cards.
- A non-default principal requires explicit human authorization plus
  `--allow-impersonation --user <exact-selector> --chat-id <allowlisted-id>`.
- Use `--group` only to test the group harness. Use a real inbound Lark message
  to prove webhook admission and mention rules.
- Leave trace capture on unless the trace itself is the subject of a negative
  test.

## Evidence and acceptance

Capture the prompt, branch/SHA, image tag, runtime/model, selected principal,
trace ID, elapsed time, tool-call sequence, final answer, and artifact link.
The persisted lifecycle trace is `/tmp/divo-harness-latest.jsonl`.

A basic pass requires:

- `runtime: cloud Pi (legacy AI SDK disabled)`;
- the intended identity, RBAC, provider account, and Lark chat;
- typed governed tools rather than a removed compatibility surface;
- exact source/written/read-back counts for data movement;
- a real artifact link in both the trace/final answer and the intended Lark chat;
- no credentials or bulk rows in model context, logs, scripts, or artifacts;
- controller health returning to `activeRuns: 0` and no active run process.
  A private warm container/Pi process may remain by design for the same scoped
  runtime; do not mistake that for an active harness run.

Test in increasing scope: no-tool smoke, ambiguous request, fully specified
small request, 1/10/100/multi-page/capped/empty datasets, then permission,
approval, expiry, quota, timeout, retry, interruption, and resume behavior.

## Defect-to-rerun loop

1. Preserve the failed trace and identify the first wrong decision, not merely
   the final symptom.
2. Tell the human what failed, why, and the smallest correction being made.
3. Remove newly stale code or instructions; do not add a second authority or
   another exception paragraph.
4. Run the narrow unit/contract suites.
5. Reconcile Development skill rows if backend skill markdown changed.
6. Rebuild the image if container runtime, extensions, or bundled skills changed.
7. Start a fresh context and rerun the exact same prompt.
8. Record the before/after tool sequence, counts, latency, and context exposure.

## Shutdown

Stop foreground backend/controller processes with `Ctrl+C`, then:

```bash
cd advance-backend
pnpm stop
```

This stops local Redis and the Development tunnel without deleting Divo
containers, images, networks, or durable workspaces.
