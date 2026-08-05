# Direct harness to a Lark DM

Use this path for the fastest repeatable local test. It invokes cloud Pi
directly through the production runtime boundary and can render Pi's live
status plus final answer in a real Lark DM.

It does **not** simulate an inbound Lark webhook. Use
[03-live-lark-webhook.md](./03-live-lark-webhook.md) when webhook admission,
sign-in/approval cards, or inbound attachments are under test.

## Before running

Complete [01-setup-and-secrets.md](./01-setup-and-secrets.md). Confirm:

```bash
curl -fsS http://127.0.0.1:4317/health | jq .
curl -fsS http://127.0.0.1:8000/health | jq .
```

The selected person must already have:

- one unambiguous DB-linked Lark identity;
- an unrevoked Lark member session with more than five minutes remaining;
- permission to use the requested governed tools.

The harness does not bypass these requirements.

## Smallest Lark DM proof

From `advance-backend/`:

```bash
pnpm tsx scripts/run-engine-harness.ts \
  --model luna \
  "Reply with exactly: DIVO CLOUD PI LIVE"
```

The current default resolves Abhishek's DB identity and delivers to the
configured/default Abhishek-Divo DM. The container should start on demand,
deliver status updates and the final answer, then stop.

## Suppress only status/final delivery

Use this only when the harness status/final cards are not under test. Governed
tools remain live and may still send review/approval cards or perform provider
side effects:

```bash
pnpm tsx scripts/run-engine-harness.ts \
  --model luna \
  --no-final-delivery \
  "Reply with exactly: LOCAL PI LIVE"
```

`--no-final-delivery` currently supports only the p2p harness path. The removed
`--no-delivery` spelling is rejected because it falsely implied a local-only,
side-effect-free run.

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

The harness requires `--chat-id` for every non-default principal, including
`--no-final-delivery` runs because a governed tool can still send an approval or
review card. Immediately before execution it also reads the live Lark chat
mode and membership. It refuses the run unless the configured audience matches
the provider (`p2p`, or `group` including topic-mode groups) and the selected
principal belongs to that exact chat.

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
- console reports the active model selected by the member's backend policy;
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

- `--model flash|pro|luna`: assert the model selected by the member's backend
  grant. This never overrides policy; omit it to accept whichever model the
  backend selects.
- `--backend-url <url>`: defaults to local port `8000`.
- `--fresh-context`: fresh conversational context; durable workspace remains.
- `--no-trace`: skip persisted trace output.
- `--no-final-delivery`: suppress only harness status/final cards. Tool,
  review, approval, and provider side effects remain enabled.
- `--allow-impersonation --user <selector>`: explicit non-default DB identity.
- `--chat-id <allowed-id>`: explicit allowlisted destination.
- `--group`, `--thread-root`, `--group-mode`: group-thread harness controls.

`--oauth-e2e`, `--full-debug`, and `--debug-sigs` are rejected by the current
direct cloud Pi harness. Do not document or report them as working paths.
