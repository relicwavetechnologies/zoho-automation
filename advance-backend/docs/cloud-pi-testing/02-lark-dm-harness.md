# Direct harness to a Lark DM

Use this path for the fastest repeatable local test. It invokes cloud Pi
directly through the production runtime boundary and can render Pi's live
status plus final answer in a real Lark DM.

It does **not** simulate an inbound Lark webhook. Use
[03-live-lark-webhook.md](./03-live-lark-webhook.md) when webhook admission,
sign-in/approval cards, or inbound attachments are under test.

## Current code blocker

Do not present this harness as passing on the current code without fixing and
verifying its tenant binding first:

- `LarkPiRuntimeService.findActiveSession` requires both
  `runContext.tenantId` and `runContext.userExternalId`.
- `run-engine-harness.ts` currently supplies the open ID but not `tenantId`.
- The resulting `runtime_session_missing` is therefore expected even when the
  person has an active Lark session.

Until that wiring is corrected with a focused regression test, use the live
Lark webhook path for the authoritative E2E proof. The commands below remain
the intended direct-harness contract and are useful after that blocker is
fixed.

## Before running

Complete [01-setup-and-secrets.md](./01-setup-and-secrets.md). Confirm:

```bash
curl -fsS http://127.0.0.1:4317/health | jq .
curl -fsS http://127.0.0.1:8000/health | jq .
```

After the current tenant-binding blocker is fixed, the selected person must
already have:

- one unambiguous DB-linked Lark identity;
- an unrevoked Lark member session with more than five minutes remaining;
- permission to use the requested governed tools.

The harness does not bypass these requirements.

## Smallest Lark DM proof

From `advance-backend/`:

```bash
pnpm tsx scripts/run-engine-harness.ts \
  --model flash \
  "Reply with exactly: DIVO CLOUD PI LIVE"
```

The current default resolves Abhishek's DB identity and delivers to the
configured/default Abhishek-Divo DM. The container should start on demand,
deliver status updates and the final answer, then stop.

## Local-only proof

Use this when Lark delivery itself is not under test:

```bash
pnpm tsx scripts/run-engine-harness.ts \
  --model flash \
  --no-delivery \
  "Reply with exactly: LOCAL PI LIVE"
```

`--no-delivery` currently supports only the p2p harness path.

## Another named user or DM

Never guess or silently substitute an identity/chat. Ask for:

- exact email, exact display name, or Lark `open_id`;
- exact target Lark `chat_id`;
- explicit permission to run as that user and deliver to that chat.

The target chat must also be allowlisted:

```bash
HARNESS_LARK_ALLOWED_CHAT_IDS=oc_target \
pnpm tsx scripts/run-engine-harness.ts \
  --model flash \
  --fresh-context \
  --allow-impersonation \
  --user "person@example.com" \
  --chat-id oc_target \
  "Reply with exactly: NAMED USER PI LIVE"
```

`--fresh-context` creates a fresh conversation key and disables Mem0 for the
run. It does not erase the user's durable Docker workspace.

## Group harness

This seeds a real group thread and replies inside it:

```bash
pnpm tsx scripts/run-engine-harness.ts \
  --model flash \
  --group \
  "Reply with exactly: GROUP THREAD PI LIVE"
```

Continue a known seeded thread with:

```bash
pnpm tsx scripts/run-engine-harness.ts \
  --model flash \
  --group \
  --thread-root om_message_id \
  "Reply with exactly: GROUP FOLLOWUP PI LIVE"
```

Use live Lark traffic, not the group harness, to prove mention admission rules.

## Evidence to capture

A passing run has all of these:

- console says `runtime: cloud Pi (legacy AI SDK disabled)`;
- the resolved identity and principal are the intended person/company;
- the controller URL is `http://127.0.0.1:4317` unless deliberately changed;
- console reaches `piRuntime.run done`;
- console says the answer was delivered through the production
  status/final-card flow;
- the intended Lark chat receives the final response;
- controller health returns to `activeRuns: 0`;
- the user's Divo container is stopped, not deleted.

Inspect the controller and owned containers without mutation:

```bash
curl -fsS http://127.0.0.1:4317/health | jq .
docker ps -a \
  --filter label=dev.divo.profile \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
```

The harness writes the latest persisted lifecycle trace to:

```text
/tmp/divo-harness-latest.jsonl
```

Useful trace inspection:

```bash
rg -n 'model_call|tool_call|specialist|run_complete|run_failed' \
  /tmp/divo-harness-latest.jsonl
```

## Supported options that matter

- `--model flash`: the only cloud Pi model currently accepted.
- `--backend-url <url>`: defaults to local port `8000`.
- `--fresh-context`: fresh conversational context; durable workspace remains.
- `--no-trace`: skip persisted trace output.
- `--no-delivery`: print locally instead of sending to Lark.
- `--allow-impersonation --user <selector>`: explicit non-default DB identity.
- `--chat-id <allowed-id>`: explicit allowlisted destination.
- `--group`, `--thread-root`, `--group-mode`: group-thread harness controls.

`--model pro`, `--oauth-e2e`, `--full-debug`, and `--debug-sigs` are rejected
by the current direct cloud Pi harness. Do not document or report them as
working paths.
