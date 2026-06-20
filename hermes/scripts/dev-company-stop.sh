#!/usr/bin/env bash
set -euo pipefail

REQUIRED_HERMES_ROOT="${HERMES_TOOL_UNION_ROOT:-/Users/abhishekverma/conductor/workspaces/divo/tool-union-parallel-lead-agent/hermes}"
PHYSICAL_HERMES_ROOT="$(cd "$REQUIRED_HERMES_ROOT" && pwd -P)"
HERMES_COMPANY_INSTANCE_ID="${HERMES_COMPANY_INSTANCE_ID:-divo-oauth}"
HERMES_COMPANY_HOME="${HERMES_COMPANY_HOME:-/tmp/hermes-${HERMES_COMPANY_INSTANCE_ID}}"
if [[ "${HERMES_COMPANY_ALLOW_EXTERNAL_HOME:-0}" == "1" ]]; then
  HERMES_HOME="${HERMES_HOME:-$HERMES_COMPANY_HOME}"
else
  HERMES_HOME="$HERMES_COMPANY_HOME"
fi
HERMES_COMPANY_DEV_PID_FILE="${HERMES_COMPANY_DEV_PID_FILE:-$HERMES_HOME/company-dev.pid}"

terminate_tree() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  [[ "$pid" != "$$" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  local child
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    terminate_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)

  kill -TERM "$pid" 2>/dev/null || true
}

force_kill_tree() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  [[ "$pid" != "$$" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  local child
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    force_kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)

  kill -KILL "$pid" 2>/dev/null || true
}

if [[ -f "$HERMES_COMPANY_DEV_PID_FILE" ]]; then
  company_dev_pid="$(cat "$HERMES_COMPANY_DEV_PID_FILE" 2>/dev/null || true)"
  if [[ "$company_dev_pid" =~ ^[0-9]+$ ]]; then
    terminate_tree "$company_dev_pid"
    sleep 1
    force_kill_tree "$company_dev_pid"
  fi
  rm -f "$HERMES_COMPANY_DEV_PID_FILE"
fi

stop_matching() {
  local pattern="$1"
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    [[ "$pid" != "$$" ]] || continue
    terminate_tree "$pid"
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
}

stop_matching "bash scripts/dev-company.sh$"
stop_matching "pnpm dev:company$"
stop_matching "$REQUIRED_HERMES_ROOT/node_modules/.bin/concurrently"
stop_matching "$PHYSICAL_HERMES_ROOT/node_modules/.bin/concurrently"
stop_matching "$REQUIRED_HERMES_ROOT/.venv/bin/python -m gateway.run"
stop_matching "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m gateway.run"
stop_matching "$REQUIRED_HERMES_ROOT/.venv/bin/python -m hermes_cli.main gateway run"
stop_matching "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m hermes_cli.main gateway run"
stop_matching "$REQUIRED_HERMES_ROOT/.venv/bin/hermes gateway run"
stop_matching "$PHYSICAL_HERMES_ROOT/.venv/bin/hermes gateway run"
stop_matching "$REQUIRED_HERMES_ROOT/.venv/bin/python -m hermes_cli.main dashboard"
stop_matching "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m hermes_cli.main dashboard"
stop_matching "$REQUIRED_HERMES_ROOT/node_modules/.bin/wait-on http://127.0.0.1:"
stop_matching "$PHYSICAL_HERMES_ROOT/node_modules/.bin/wait-on http://127.0.0.1:"
stop_matching "$REQUIRED_HERMES_ROOT/node_modules/.bin/cross-env"
stop_matching "$PHYSICAL_HERMES_ROOT/node_modules/.bin/cross-env"
stop_matching "$REQUIRED_HERMES_ROOT/node_modules/electron/dist/Electron.app"
stop_matching "$PHYSICAL_HERMES_ROOT/node_modules/electron/dist/Electron.app"
stop_matching "$REQUIRED_HERMES_ROOT/node_modules/.bin/electron ."
stop_matching "$PHYSICAL_HERMES_ROOT/node_modules/.bin/electron ."
stop_matching "$REQUIRED_HERMES_ROOT/node_modules/.bin/vite --host 127.0.0.1 --port"
stop_matching "$PHYSICAL_HERMES_ROOT/node_modules/.bin/vite --host 127.0.0.1 --port"
stop_matching "$REQUIRED_HERMES_ROOT/apps/desktop/node_modules/.bin/vite --host 127.0.0.1 --port"
stop_matching "$PHYSICAL_HERMES_ROOT/apps/desktop/node_modules/.bin/vite --host 127.0.0.1 --port"

sleep 1

stop_matching "$REQUIRED_HERMES_ROOT/.venv/bin/python -m gateway.run"
stop_matching "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m gateway.run"
stop_matching "$REQUIRED_HERMES_ROOT/.venv/bin/python -m hermes_cli.main gateway run"
stop_matching "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m hermes_cli.main gateway run"
stop_matching "$REQUIRED_HERMES_ROOT/.venv/bin/hermes gateway run"
stop_matching "$PHYSICAL_HERMES_ROOT/.venv/bin/hermes gateway run"
stop_matching "$REQUIRED_HERMES_ROOT/.venv/bin/python -m hermes_cli.main dashboard"
stop_matching "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m hermes_cli.main dashboard"

PROFILE_DIR="${HERMES_DESKTOP_USER_DATA_DIR:-${HERMES_HOME:-/tmp/hermes-divo-oauth}/desktop-profile}"
echo "Stopped Hermes company dev processes."
echo "  Desktop profile preserved at: ${PROFILE_DIR}"
echo "  Next dev:company start reuses this profile unless HERMES_DESKTOP_RESET_PROFILE=1"
