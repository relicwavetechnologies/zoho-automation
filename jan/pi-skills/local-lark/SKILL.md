---
name: local-lark
description: Use only when the user explicitly asks to use their personal/local Lark account on this desktop. Company, shared, admin, RBAC, approval, or ambiguous Lark work must use the Divo gateway first.
---

# Local Lark

Use the bundled desktop `lark-cli` for personal Lark work only when the user clearly wants their local Lark account. Do not use this skill for company-owned/shared connections, admin-managed accounts, approvals/RBAC, or ambiguous SaaS requests; use the `divo-gateway` skill first in those cases.

## Runtime

- Prefer `DIVO_LARK_CLI` if set; otherwise call `lark-cli` from `PATH`.
- The desktop puts an isolated `lark-cli` wrapper first in `PATH`. Never call `/Users/.../.local/bin/lark-cli` or any user-global install directly.
- The isolated local home is exposed as `DIVO_LARK_CLI_HOME`.
- Use `--json` whenever the command supports it.

## Before Acting

Run:

```bash
lark-cli auth status --json
```

If the result says `not_configured`, `unauthorized`, or missing scopes, tell the user to open `Plugins -> Lark Personal` and finish setup/authorization. Do not ask for app secrets or tokens in chat.

## Working Method

1. Confirm the request is personal/local Lark work.
2. Check auth status.
3. Use the most specific `lark-cli` command/domain for the task.
4. Put temporary files, downloaded attachments, and scratch output under `DIVO_RUN_DIR` when available.
5. Summarize important structured fields from JSON responses instead of pasting raw payloads.

## Boundaries

- For company/shared Lark mail, docs, calendar, approvals, departments, or policy-sensitive actions, use `divo_gateway`.
- Never move tokens, app secrets, or exported auth files into the workspace.
- Never treat local Lark access as backend permission.
