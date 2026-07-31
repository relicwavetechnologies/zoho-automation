# P2 — Company Pi can bypass the desktop session with environment credentials

**Verdict:** confirmed, runtime-reachable split session authority.

## Evidence

- `jan/src-tauri/src/core/divo/commands.rs:59-79` makes the stored `DivoSession` the desktop's session source: it writes `backend_url`, `member_token`, and department to `pi-agent/divo.env`; when no session remains it deletes that file.
- `jan/src-tauri/src/core/pi/mod.rs:31-40` starts Company mode and only calls that synchronization; it does not require a stored session.
- `jan/src-tauri/src/core/pi/manager.rs:1697-1707` then launches the Company Pi child through `apply_divo_gateway_env`.
- `jan/src-tauri/src/core/pi/env.rs:72-96` gives inherited process variables first precedence for `DIVO_BACKEND_URL`, `DIVO_MEMBER_TOKEN`, and `DIVO_DEPARTMENT_ID`. Among files, the generated `pi-agent/divo.env` actually overwrites `jan/.env` because it is merged second (`:72-77`, `:271-290`), despite the nearby precedence comment stating the reverse.
- `jan/pi-extensions/divo-gateway/gateway-client.ts:142-159,420-427` uses those selected values directly as the backend URL and Bearer member token for governed calls. The LLM extension uses the same captured config for `/api/llm/v1`.

## Call path

`pi_start(runtimeMode="company")` → `divo_sync_pi_env()` → `PiManager::spawn_slot()` → `apply_divo_gateway_env()` → Pi `divo-gateway` / `divo-llm` → backend member-authenticated gateway or LLM proxy.

## Concrete impact

An inherited `DIVO_MEMBER_TOKEN`/`DIVO_BACKEND_URL` silently wins over the
signed-in desktop session. After disconnect, `sync_pi_divo_env` deletes the
generated session file but does not clear inherited variables; at that point a
`jan/.env` credential also becomes the file fallback. Company Pi can therefore
start and make calls as the externally supplied token's member while the
desktop reports no session. The displayed desktop identity, selected
department, logout state, audit principal, and actual authority can diverge.

## Smallest correction

For Company mode, build the child credential environment only from the stored
desktop session (the generated `divo.env` is sufficient), explicitly remove
inherited `DIVO_BACKEND_URL`, `DIVO_MEMBER_TOKEN`, and `DIVO_DEPARTMENT_ID`,
and do not merge `jan/.env` gateway credentials. If developer injection is
needed, make it an explicit dev-only path that cannot coexist with a saved
session or bypass logout.

## Regression tests

1. With a saved session and conflicting process values, assert the spawned Company Pi receives the saved backend URL, token, and department.
2. With no saved session and injected process or `jan/.env` Divo credentials, assert Company Pi fails to start or receives no Divo gateway credentials.
3. After `divo_clear_session`, assert a subsequent Company-mode launch cannot call `/api/gateway` or `/api/llm` using prior environment credentials.
