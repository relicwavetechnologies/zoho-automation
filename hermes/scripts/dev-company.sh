#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HERMES_ENV_FILE="${HERMES_ENV_FILE:-$HERMES_ROOT/.env}"
PYTHON_BIN="${HERMES_PYTHON:-$HERMES_ROOT/.venv/bin/python}"

if [[ ! -f "$HERMES_ENV_FILE" ]]; then
  echo "Missing Hermes env file: $HERMES_ENV_FILE" >&2
  exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Missing Hermes Python interpreter: $PYTHON_BIN" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$HERMES_ENV_FILE"
set +a

resolve_env_ref() {
  local value="${1:-}"
  if [[ "$value" =~ ^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$ ]]; then
    local ref_name="${BASH_REMATCH[1]}"
    printf '%s' "${!ref_name-}"
    return
  fi
  printf '%s' "$value"
}

export HERMES_DASHBOARD_LARK_APP_ID
HERMES_DASHBOARD_LARK_APP_ID="$(resolve_env_ref "${HERMES_DASHBOARD_LARK_APP_ID:-${LARK_APP_ID:-}}")"
export HERMES_DASHBOARD_LARK_APP_SECRET
HERMES_DASHBOARD_LARK_APP_SECRET="$(resolve_env_ref "${HERMES_DASHBOARD_LARK_APP_SECRET:-${LARK_APP_SECRET:-}}")"
export HERMES_DASHBOARD_LARK_API_BASE_URL
HERMES_DASHBOARD_LARK_API_BASE_URL="$(resolve_env_ref "${HERMES_DASHBOARD_LARK_API_BASE_URL:-${LARK_API_BASE_URL:-}}")"

if [[ -z "${HERMES_DASHBOARD_LARK_APP_ID:-}" || -z "${HERMES_DASHBOARD_LARK_APP_SECRET:-}" ]]; then
  echo "hermes/.env must define HERMES_DASHBOARD_LARK_APP_ID and HERMES_DASHBOARD_LARK_APP_SECRET." >&2
  exit 1
fi

export HERMES_LARK_CHANNEL_ENABLED
HERMES_LARK_CHANNEL_ENABLED="$(resolve_env_ref "${HERMES_LARK_CHANNEL_ENABLED:-true}")"
HERMES_LARK_CHANNEL_ENABLED_NORMALIZED="$(printf '%s' "$HERMES_LARK_CHANNEL_ENABLED" | tr '[:upper:]' '[:lower:]')"

if [[ "$HERMES_LARK_CHANNEL_ENABLED_NORMALIZED" =~ ^(true|1|yes|on)$ ]]; then
  export HERMES_LARK_CHANNEL_APP_ID
  HERMES_LARK_CHANNEL_APP_ID="$(resolve_env_ref "${HERMES_LARK_CHANNEL_APP_ID:-${LARK_APP_ID:-}}")"
  export HERMES_LARK_CHANNEL_APP_SECRET
  HERMES_LARK_CHANNEL_APP_SECRET="$(resolve_env_ref "${HERMES_LARK_CHANNEL_APP_SECRET:-${LARK_APP_SECRET:-}}")"
  export HERMES_LARK_CHANNEL_DOMAIN
  HERMES_LARK_CHANNEL_DOMAIN="$(resolve_env_ref "${HERMES_LARK_CHANNEL_DOMAIN:-lark}")"
  export HERMES_LARK_CHANNEL_CONNECTION_MODE
  HERMES_LARK_CHANNEL_CONNECTION_MODE="$(resolve_env_ref "${HERMES_LARK_CHANNEL_CONNECTION_MODE:-webhook}")"
  HERMES_LARK_CHANNEL_CONNECTION_MODE="$(printf '%s' "$HERMES_LARK_CHANNEL_CONNECTION_MODE" | tr '[:upper:]' '[:lower:]')"
  export HERMES_LARK_CHANNEL_VERIFICATION_TOKEN
  HERMES_LARK_CHANNEL_VERIFICATION_TOKEN="$(resolve_env_ref "${HERMES_LARK_CHANNEL_VERIFICATION_TOKEN:-${LARK_VERIFICATION_TOKEN:-}}")"
  export HERMES_LARK_CHANNEL_ENCRYPT_KEY
  HERMES_LARK_CHANNEL_ENCRYPT_KEY="$(resolve_env_ref "${HERMES_LARK_CHANNEL_ENCRYPT_KEY:-${LARK_ENCRYPT_KEY:-}}")"
  export HERMES_LARK_CHANNEL_WEBHOOK_HOST
  HERMES_LARK_CHANNEL_WEBHOOK_HOST="$(resolve_env_ref "${HERMES_LARK_CHANNEL_WEBHOOK_HOST:-127.0.0.1}")"
  export HERMES_LARK_CHANNEL_WEBHOOK_PORT
  HERMES_LARK_CHANNEL_WEBHOOK_PORT="$(resolve_env_ref "${HERMES_LARK_CHANNEL_WEBHOOK_PORT:-8765}")"
  export HERMES_LARK_CHANNEL_WEBHOOK_PATH
  HERMES_LARK_CHANNEL_WEBHOOK_PATH="$(resolve_env_ref "${HERMES_LARK_CHANNEL_WEBHOOK_PATH:-/feishu/webhook}")"
  export HERMES_LARK_CHANNEL_ALLOW_ALL_USERS
  HERMES_LARK_CHANNEL_ALLOW_ALL_USERS="$(resolve_env_ref "${HERMES_LARK_CHANNEL_ALLOW_ALL_USERS:-true}")"
  export HERMES_LARK_CHANNEL_GROUP_POLICY
  HERMES_LARK_CHANNEL_GROUP_POLICY="$(resolve_env_ref "${HERMES_LARK_CHANNEL_GROUP_POLICY:-open}")"
  export HERMES_LARK_CHANNEL_REQUIRE_MENTION
  HERMES_LARK_CHANNEL_REQUIRE_MENTION="$(resolve_env_ref "${HERMES_LARK_CHANNEL_REQUIRE_MENTION:-true}")"

  if [[ -z "${HERMES_LARK_CHANNEL_APP_ID:-}" || -z "${HERMES_LARK_CHANNEL_APP_SECRET:-}" ]]; then
    echo "hermes/.env must define LARK_APP_ID/LARK_APP_SECRET or HERMES_LARK_CHANNEL_APP_ID/HERMES_LARK_CHANNEL_APP_SECRET." >&2
    exit 1
  fi

  if [[ "$HERMES_LARK_CHANNEL_CONNECTION_MODE" == "webhook" && -z "${HERMES_LARK_CHANNEL_VERIFICATION_TOKEN:-}" && -z "${HERMES_LARK_CHANNEL_ENCRYPT_KEY:-}" ]]; then
    echo "Lark channel webhook mode requires LARK_VERIFICATION_TOKEN/HERMES_LARK_CHANNEL_VERIFICATION_TOKEN or HERMES_LARK_CHANNEL_ENCRYPT_KEY." >&2
    exit 1
  fi

  # The native adapter still uses FEISHU_* internally. Company-mode config is
  # canonicalized above, then exported here so gateway auth and adapter startup
  # see one consistent Lark channel configuration.
  export FEISHU_APP_ID="${FEISHU_APP_ID:-$HERMES_LARK_CHANNEL_APP_ID}"
  export FEISHU_APP_SECRET="${FEISHU_APP_SECRET:-$HERMES_LARK_CHANNEL_APP_SECRET}"
  export FEISHU_DOMAIN="${FEISHU_DOMAIN:-$HERMES_LARK_CHANNEL_DOMAIN}"
  export FEISHU_CONNECTION_MODE="${FEISHU_CONNECTION_MODE:-$HERMES_LARK_CHANNEL_CONNECTION_MODE}"
  export FEISHU_VERIFICATION_TOKEN="${FEISHU_VERIFICATION_TOKEN:-$HERMES_LARK_CHANNEL_VERIFICATION_TOKEN}"
  export FEISHU_ENCRYPT_KEY="${FEISHU_ENCRYPT_KEY:-$HERMES_LARK_CHANNEL_ENCRYPT_KEY}"
  export FEISHU_WEBHOOK_HOST="${FEISHU_WEBHOOK_HOST:-$HERMES_LARK_CHANNEL_WEBHOOK_HOST}"
  export FEISHU_WEBHOOK_PORT="${FEISHU_WEBHOOK_PORT:-$HERMES_LARK_CHANNEL_WEBHOOK_PORT}"
  export FEISHU_WEBHOOK_PATH="${FEISHU_WEBHOOK_PATH:-$HERMES_LARK_CHANNEL_WEBHOOK_PATH}"
  export FEISHU_ALLOW_ALL_USERS="${FEISHU_ALLOW_ALL_USERS:-$HERMES_LARK_CHANNEL_ALLOW_ALL_USERS}"
  export FEISHU_GROUP_POLICY="${FEISHU_GROUP_POLICY:-$HERMES_LARK_CHANNEL_GROUP_POLICY}"
  export FEISHU_REQUIRE_MENTION="${FEISHU_REQUIRE_MENTION:-$HERMES_LARK_CHANNEL_REQUIRE_MENTION}"
fi

export HERMES_HOME="${HERMES_HOME:-/tmp/hermes-divo-oauth}"
export HERMES_DASHBOARD_PUBLIC_URL="${HERMES_DASHBOARD_PUBLIC_URL:-http://127.0.0.1:9119}"
export HERMES_DESKTOP_REMOTE_URL="${HERMES_DESKTOP_REMOTE_URL:-http://127.0.0.1:9119}"
export HERMES_DESKTOP_REMOTE_AUTH_MODE="${HERMES_DESKTOP_REMOTE_AUTH_MODE:-oauth}"
DEFAULT_DESKTOP_USER_DATA_DIR="$HERMES_HOME/desktop-profile"
LEGACY_DESKTOP_USER_DATA_DIR="/tmp/hermes-desktop-oauth-profile"
DESKTOP_USER_DATA_DIR_FROM_ENV="${HERMES_DESKTOP_USER_DATA_DIR:-}"
export HERMES_DESKTOP_USER_DATA_DIR="${DESKTOP_USER_DATA_DIR_FROM_ENV:-$DEFAULT_DESKTOP_USER_DATA_DIR}"
export API_SERVER_ENABLED="${API_SERVER_ENABLED:-false}"

if [[ "${1:-}" == "--check" ]]; then
  "$PYTHON_BIN" -m enterprise.readiness --company-dev --check-database
  echo "Company dev env OK"
  echo "  HERMES_ENV_FILE=$HERMES_ENV_FILE"
  echo "  HERMES_HOME=$HERMES_HOME"
  echo "  HERMES_DASHBOARD_PUBLIC_URL=$HERMES_DASHBOARD_PUBLIC_URL"
  echo "  HERMES_DESKTOP_REMOTE_URL=$HERMES_DESKTOP_REMOTE_URL"
  echo "  HERMES_DESKTOP_USER_DATA_DIR=$HERMES_DESKTOP_USER_DATA_DIR"
  echo "  HERMES_ENTERPRISE_POSTGRES=${HERMES_ENTERPRISE_POSTGRES:-unset}"
  echo "  HERMES_DASHBOARD_LARK_APP_ID=present(len=${#HERMES_DASHBOARD_LARK_APP_ID})"
  echo "  HERMES_DASHBOARD_LARK_APP_SECRET=present(len=${#HERMES_DASHBOARD_LARK_APP_SECRET})"
  echo "  HERMES_LARK_CHANNEL_ENABLED=$HERMES_LARK_CHANNEL_ENABLED"
  if [[ "$HERMES_LARK_CHANNEL_ENABLED_NORMALIZED" =~ ^(true|1|yes|on)$ ]]; then
    echo "  HERMES_LARK_CHANNEL_CONNECTION_MODE=$HERMES_LARK_CHANNEL_CONNECTION_MODE"
    echo "  HERMES_LARK_CHANNEL_WEBHOOK_LOCAL=http://${HERMES_LARK_CHANNEL_WEBHOOK_HOST}:${HERMES_LARK_CHANNEL_WEBHOOK_PORT}${HERMES_LARK_CHANNEL_WEBHOOK_PATH}"
  fi
  exit 0
fi

"$PYTHON_BIN" -m enterprise.migration_runner --apply
"$PYTHON_BIN" -m enterprise.readiness --company-dev --check-database

if [[ -z "$DESKTOP_USER_DATA_DIR_FROM_ENV" && "${HERMES_DESKTOP_RESET_PROFILE:-0}" != "1" && ! -e "$HERMES_DESKTOP_USER_DATA_DIR" && -d "$LEGACY_DESKTOP_USER_DATA_DIR" ]]; then
  mkdir -p "$(dirname "$HERMES_DESKTOP_USER_DATA_DIR")"
  mv "$LEGACY_DESKTOP_USER_DATA_DIR" "$HERMES_DESKTOP_USER_DATA_DIR"
fi

if [[ "${HERMES_DESKTOP_RESET_PROFILE:-0}" == "1" ]]; then
  rm -rf "$HERMES_DESKTOP_USER_DATA_DIR"
fi

GATEWAY_VERBOSE_ARGS=()
if [[ "${HERMES_DEV_VERBOSE:-}" == "1" ]]; then
  GATEWAY_VERBOSE_ARGS=(--verbose)
fi

cat <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Hermes company-mode dev stack
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Services starting:
   • Gateway (Python)${HERMES_DEV_VERBOSE:+ — verbose logs enabled}
   • Dashboard  →  ${HERMES_DASHBOARD_PUBLIC_URL}
   • Desktop app (Electron + Vite)
   • Lark channel → ${HERMES_LARK_CHANNEL_ENABLED}

 Before you sign in (expected):
   • Desktop shows the company auth gate (Lark sign-in)
   • Terminal should NOT show fatal boot errors for this state

 After desktop Lark login:
   • Desktop unblocks; profile appears in the sidebar footer
   • Sign out returns you to the auth gate

 Web admin (separate browser session):
   • Employees  →  ${HERMES_DASHBOARD_PUBLIC_URL}/employees
   • Sign in in the browser — desktop OAuth does not auto-auth the web UI

 Lark channel webhook:
   • Local listener → http://${HERMES_LARK_CHANNEL_WEBHOOK_HOST:-127.0.0.1}:${HERMES_LARK_CHANNEL_WEBHOOK_PORT:-8765}${HERMES_LARK_CHANNEL_WEBHOOK_PATH:-/feishu/webhook}
   • Console URL    → ${HERMES_LARK_CHANNEL_PUBLIC_WEBHOOK_URL:-https://<your-tunnel-domain>${HERMES_LARK_CHANNEL_WEBHOOK_PATH:-/feishu/webhook}}

Stop:  pnpm dev:company:stop
Profile: ${HERMES_DESKTOP_USER_DATA_DIR}
         (persistent; set HERMES_DESKTOP_RESET_PROFILE=1 only when you want a fresh login)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
echo

pids=()

cleanup() {
  trap - INT TERM EXIT
  if [[ "${#pids[@]}" -gt 0 ]]; then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

(
  cd "$HERMES_ROOT"
  if ((${#GATEWAY_VERBOSE_ARGS[@]})); then
    "$PYTHON_BIN" -m gateway.run "${GATEWAY_VERBOSE_ARGS[@]}"
  else
    "$PYTHON_BIN" -m gateway.run
  fi
) &
pids+=("$!")
gateway_pid=${pids[0]}

restart_dashboard() {
  (
    cd "$HERMES_ROOT"
    "$PYTHON_BIN" -m hermes_cli.main dashboard --host 0.0.0.0 --port 9119 --no-open --skip-build
  ) &
  dashboard_pid=$!
  pids[1]="$dashboard_pid"
}

restart_dashboard

(
  cd "$HERMES_ROOT/apps/desktop"
  export PATH="$HERMES_ROOT/node_modules/.bin:$PATH"
  # Cursor/CI agents often set ELECTRON_RUN_AS_NODE=1, which makes `electron .`
  # execute main.cjs under Node (app is undefined). Unset before dev launch.
  unset ELECTRON_RUN_AS_NODE
  npm run dev
) &
desktop_pid=$!
pids+=("$desktop_pid")

while true; do
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    wait "$gateway_pid" 2>/dev/null || true
    echo "Hermes gateway exited; stopping company dev stack." >&2
    cleanup
    exit 1
  fi

  if ! kill -0 "$dashboard_pid" 2>/dev/null; then
    wait "$dashboard_pid" 2>/dev/null || true
    echo "Hermes dashboard exited; restarting dashboard (desktop stays open)…" >&2
    restart_dashboard
    sleep 1
    continue
  fi

  if [[ -n "${desktop_pid:-}" ]] && ! kill -0 "$desktop_pid" 2>/dev/null; then
    wait "$desktop_pid" 2>/dev/null || true
    echo "Desktop dev exited (gateway + dashboard still running)." >&2
    echo "  Restart desktop: cd apps/desktop && unset ELECTRON_RUN_AS_NODE && npm run dev" >&2
    desktop_pid=""
  fi

  sleep 1
done
