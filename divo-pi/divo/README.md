# Divo Pi

This directory turns the pinned Pi source tree into Divo's standalone company
agent. It owns browser authentication, runtime layout, Divo extensions, trusted
skills, prompts, and the terminal launcher. The upstream Pi packages remain
under `packages/`.

## Install

Pi requires Node.js 22.19 or newer.

```bash
npm ci --ignore-scripts
```

## Verify browser authentication

For a deployed backend whose Lark callback is already registered:

```bash
npm run divo:login -- --backend https://backend.example.com
```

For a local backend, use the public ngrok HTTPS URL as `--backend`. Configure
the same public origin as the backend public URL and register this callback in
the Lark developer console:

```text
https://YOUR-NGROK-HOST/api/desktop/auth/lark/callback
```

The temporary Phase 0 login returns a normal desktop member session. The token
stays in process memory and is never written to the repository, runtime state,
workspace, session transcript, command line, or logs.

## Run

```bash
npm run divo:start -- --backend https://backend.example.com
```

Run one non-interactive prompt:

```bash
npm run divo:start -- \
  --backend https://backend.example.com \
  --print "List my available Divo capabilities."
```

For local parity testing only, an existing Desktop member session can be
validated and reused without another browser login:

```bash
npm run divo:start -- \
  --session-env "/path/to/desktop/pi-agent/divo.env" \
  --print "List my available Divo capabilities."
```

The file is parsed without shell evaluation. Its token remains in process
memory and is validated against `/api/desktop/auth/me` before Pi starts.

Useful options:

- `--department <id-or-name>` selects a department; otherwise the first
  available department is used, matching Desktop.
- `--workspace <path>` changes the isolated workspace.
- `--thread <id>` opens a separate durable Pi session.
- `--session-env <path>` reuses and validates a Desktop member session for
  local parity testing.
- `--no-browser` prints the OAuth URL without opening it.

Generated local state is stored under `.divo-state/` and ignored by Git.

## Security boundary

- Model inference must use the Divo `/api/llm` proxy.
- Company capabilities must use `/api/gateway`.
- Direct model-provider credentials are removed from the Pi child environment.
- SaaS credentials remain in the backend.
- The member token is captured by the Divo extensions and removed from the
  environment before ordinary Bash/Python children are started.

The desktop OAuth endpoints are a temporary local-parity mechanism. Production
cloud Pi will use a short-lived, instance-bound runtime lease issued by the
runtime controller after Lark identity resolution.
