# Cloud Pi testing router

Use this folder when testing Divo's isolated, containerized Pi runtime. Do not
route a test through the retired Vercel AI SDK agent and do not add a fallback
agent when Pi fails. A visible Pi failure is a valid test result.

## Read first

1. Read [01-setup-and-secrets.md](./01-setup-and-secrets.md) before starting
   processes or connecting to the development database.
2. Choose exactly one entry path:
   - [06-agent-seat.md](./06-agent-seat.md) for Cursor/human-in-the-loop skill
     and gateway testing without cloud Pi.
   - [02-lark-dm-harness.md](./02-lark-dm-harness.md) for a fast local Pi run
     whose status and final answer are delivered to a Lark DM.
   - [03-live-lark-webhook.md](./03-live-lark-webhook.md) for a real message
     sent by a user inside Lark.
3. Use [04-acceptance-matrix.md](./04-acceptance-matrix.md) for the prompts and
   evidence required to call a behavior working.
4. Use [05-troubleshooting-and-vps.md](./05-troubleshooting-and-vps.md) only
   after recording the exact failing command, HTTP status, and error code.

## Non-negotiable agent rules

- Ask for any missing password, token, SSH key, user identity, or chat ID.
  Never guess one or copy one from old chat history.
- Never put a secret in a command argument, Markdown file, Git diff, log, or
  screenshot. Use the supported environment variable or secret store.
- Prefer SSH key authentication. If password authentication is required, ask
  for the password and provide it without echoing through
  `DB_TUNNEL_SSH_PASSWORD` or `SSHPASS`.
- Treat every VPS action as read-only unless the user explicitly authorizes a
  deployment, restart, or other mutation. Resolve exact container names before
  acting.
- On the shared VPS, inspect only Divo development resources. Never stop,
  remove, restart, exec a mutating command in, or otherwise touch Grind
  containers, images, networks, volumes, files, or processes.
- Do not delete Pi containers or volumes during a normal test. A stopped
  per-user container is expected; its Docker volume is the durable workspace.
- Do not use `--allow-impersonation` unless the human explicitly names the test
  user and destination chat.
- Do not test external writes, sends, deletes, approvals, or OAuth revocation
  without explicit scope from the human.

## Know which path you are proving

| Path | What it proves | What it deliberately bypasses |
| --- | --- | --- |
| Agent Seat | Real DB identity, RBAC, skill markdown, and gateway tool execution while a human/Cursor simulates the model | Cloud Pi model, Lark delivery, webhook admission |
| Direct harness | Intended to prove DB identity, active member session, runtime lease, Pi controller, isolated container, Divo Gateway, status renderer, and final Lark delivery | Lark webhook verification, ingress receipt, queue admission, inbound Lark media |
| Live Lark message | The complete path from Lark ingress through Pi and back to Lark, including sign-in cards, group routing, attachments, approvals, status, and final delivery | Nothing in the user-facing channel path |

## Current source of truth

Verify instructions against these files when behavior changes:

- [`run-engine-harness.ts`](../../scripts/run-engine-harness.ts)
- [`agent-seat.ts`](../../scripts/agent-seat.ts)
- [`lark-pi-runtime.service.ts`](../../src/application/runtime/lark-pi-runtime.service.ts)
- [`lark.webhook.routes.ts`](../../src/infrastructure/channels/lark/lark.webhook.routes.ts)
- [`local-rpc-server.mjs`](../../../divo-pi/divo/local-rpc-server.mjs)
- [`local-rpc-controller.mjs`](../../../divo-pi/divo/local-rpc-controller.mjs)
- [`Dockerfile`](../../../divo-pi/Dockerfile)
- [`docker-compose.dev.yml`](../../../docker-compose.dev.yml)
- [`ci.yml`](../../../.github/workflows/ci.yml)
