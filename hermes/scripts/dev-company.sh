#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_HERMES_ROOT="${HERMES_TOOL_UNION_ROOT:-/Users/abhishekverma/conductor/workspaces/divo/tool-union-parallel-lead-agent/hermes}"
INVOCATION_PWD="$(pwd -L)"

case "$INVOCATION_PWD" in
  "$REQUIRED_HERMES_ROOT"|"$REQUIRED_HERMES_ROOT"/*) ;;
  *)
    cat >&2 <<EOF
dev:company must be run from the tool-union workspace path.

Current path:
  $INVOCATION_PWD

Run:
  cd $REQUIRED_HERMES_ROOT
  pnpm dev:company
EOF
    exit 1
    ;;
esac

HERMES_ROOT="$REQUIRED_HERMES_ROOT"
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

port_is_free() {
  local host="$1"
  local port="$2"
  "$PYTHON_BIN" - "$host" "$port" <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind((host, port))
    sock.listen(1)
except OSError:
    sys.exit(1)
finally:
    sock.close()
PY
}

port_owner() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sed -n '2,4p' || true
}

wait_for_port_free() {
  local host="$1"
  local port="$2"
  local attempts="${3:-20}"
  local delay="${4:-0.25}"
  local i

  for ((i = 0; i < attempts; i++)); do
    if port_is_free "$host" "$port"; then
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

choose_port() {
  local var_name="$1"
  local default_port="$2"
  local host="$3"
  local label="$4"
  local current="${!var_name:-}"
  local candidate="${current:-$default_port}"
  local max_port=$((candidate + 50))

  while [[ "$candidate" -le "$max_port" ]]; do
    if port_is_free "$host" "$candidate"; then
      printf -v "$var_name" '%s' "$candidate"
      export "$var_name"
      return 0
    fi
    candidate=$((candidate + 1))
  done

  echo "Could not find a free $label port starting at ${current:-$default_port} on $host." >&2
  echo "Port owner near the preferred port:" >&2
  port_owner "${current:-$default_port}" >&2
  exit 1
}

url_host() {
  "$PYTHON_BIN" - "$1" <<'PY'
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
print(parsed.hostname or "")
PY
}

url_port() {
  "$PYTHON_BIN" - "$1" <<'PY'
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
if parsed.port is not None:
    print(parsed.port)
elif parsed.scheme == "https":
    print(443)
elif parsed.scheme == "http":
    print(80)
else:
    print("")
PY
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local timeout_seconds="${3:-60}"
  local start
  start="$(date +%s)"

  while true; do
    if "$PYTHON_BIN" - "$url" <<'PY'
import sys
import urllib.request

url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=2) as response:
        if 200 <= int(response.status) < 500:
            sys.exit(0)
except Exception:
    pass
sys.exit(1)
PY
    then
      return 0
    fi

    if (( $(date +%s) - start >= timeout_seconds )); then
      echo "Timed out waiting for $label at $url" >&2
      return 1
    fi
    sleep 1
  done
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

fi

export HERMES_COMPANY_INSTANCE_ID
HERMES_COMPANY_INSTANCE_ID="$(resolve_env_ref "${HERMES_COMPANY_INSTANCE_ID:-divo-oauth}")"
export HERMES_COMPANY_HOME
HERMES_COMPANY_HOME="$(resolve_env_ref "${HERMES_COMPANY_HOME:-/tmp/hermes-${HERMES_COMPANY_INSTANCE_ID}}")"

# Company dev must be isolated from any other Hermes project running on the
# machine. The generic .env may contain shared Hermes desktop settings, so the
# company stack owns its runtime home/profile/URLs unless explicitly told not
# to. This keeps auth cookies, connection.json, sessions, logs, PID files, and
# OAuth state out of ~/.hermes and out of other worktrees.
if [[ "${HERMES_COMPANY_ALLOW_EXTERNAL_HOME:-0}" == "1" ]]; then
  export HERMES_HOME="${HERMES_HOME:-$HERMES_COMPANY_HOME}"
else
  export HERMES_HOME="$HERMES_COMPANY_HOME"
fi

seed_company_provider_env() {
  "$PYTHON_BIN" - "$HERMES_HOME" "${HOME:-}/.hermes/.env" <<'PY'
import ast
import json
import os
import sys
from pathlib import Path

target_home = Path(sys.argv[1])
fallback_env = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None
target = target_home / ".env"

provider_keys = [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
]


def parse_env(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}

    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            try:
                value = ast.literal_eval(value)
            except Exception:
                value = value[1:-1]
        values[key] = value
    return values


target_home.mkdir(parents=True, exist_ok=True)
existing = parse_env(target)
fallback = parse_env(fallback_env) if fallback_env and fallback_env != target else {}

additions: list[tuple[str, str]] = []
for key in provider_keys:
    if key in existing:
        continue
    value = (os.environ.get(key) or "").strip() or fallback.get(key, "").strip()
    if value:
        additions.append((key, value))

if additions:
    with target.open("a", encoding="utf-8") as fh:
        if target.exists() and target.stat().st_size > 0:
            fh.write("\n")
        fh.write("# Seeded by pnpm dev:company so company-mode desktops never ask users for model API keys.\n")
        for key, value in additions:
            fh.write(f"{key}={json.dumps(value)}\n")
    target.chmod(0o600)
elif not target.exists():
    target.touch(mode=0o600)
PY
}

seed_company_provider_env

export HERMES_DASHBOARD_PORT
HERMES_DASHBOARD_PORT="$(resolve_env_ref "${HERMES_DASHBOARD_PORT:-${HERMES_COMPANY_DASHBOARD_PORT:-9119}}")"
export HERMES_DESKTOP_RENDERER_PORT
HERMES_DESKTOP_RENDERER_PORT="$(resolve_env_ref "${HERMES_DESKTOP_RENDERER_PORT:-${HERMES_COMPANY_RENDERER_PORT:-5174}}")"
HERMES_COMPANY_REGISTERED_LARK_REDIRECT_BASE_URL="$(resolve_env_ref "${HERMES_COMPANY_REGISTERED_LARK_REDIRECT_BASE_URL:-${HERMES_DASHBOARD_PUBLIC_URL:-http://127.0.0.1:${HERMES_DASHBOARD_PORT}}}")"

REGISTERED_LARK_REDIRECT_HOST="$(url_host "$HERMES_COMPANY_REGISTERED_LARK_REDIRECT_BASE_URL")"
REGISTERED_LARK_REDIRECT_PORT="$(url_port "$HERMES_COMPANY_REGISTERED_LARK_REDIRECT_BASE_URL")"
LARK_REDIRECT_PORT_IS_FIXED=0
if [[ "${HERMES_COMPANY_ALLOW_DYNAMIC_LARK_REDIRECT_PORT:-0}" != "1" && "$REGISTERED_LARK_REDIRECT_HOST" =~ ^(127\.0\.0\.1|localhost|0\.0\.0\.0)$ && -n "$REGISTERED_LARK_REDIRECT_PORT" ]]; then
  LARK_REDIRECT_PORT_IS_FIXED=1
fi

if [[ "$LARK_REDIRECT_PORT_IS_FIXED" == "1" ]]; then
  HERMES_DASHBOARD_PORT="$REGISTERED_LARK_REDIRECT_PORT"
  export HERMES_DASHBOARD_PORT
  if ! wait_for_port_free "0.0.0.0" "$HERMES_DASHBOARD_PORT" 24 0.25; then
    cat >&2 <<EOF
Cannot start company dev: Lark OAuth is registered for:
  ${HERMES_COMPANY_REGISTERED_LARK_REDIRECT_BASE_URL}/auth/callback

That requires dashboard port ${HERMES_DASHBOARD_PORT}, but the port is not available yet.

Free the registered dashboard port, then run:
  pnpm dev:company:stop
  pnpm dev:company

Current owner of ${HERMES_DASHBOARD_PORT}, if any:
$(port_owner "$HERMES_DASHBOARD_PORT")

If no owner is shown, wait a few seconds and retry; macOS can briefly hold the
port after Ctrl+C while sockets are closing.
EOF
    exit 1
  fi
else
  choose_port HERMES_DASHBOARD_PORT "$HERMES_DASHBOARD_PORT" "0.0.0.0" "dashboard"
fi
choose_port HERMES_DESKTOP_RENDERER_PORT "$HERMES_DESKTOP_RENDERER_PORT" "127.0.0.1" "desktop renderer"
if [[ "$HERMES_LARK_CHANNEL_ENABLED_NORMALIZED" =~ ^(true|1|yes|on)$ ]]; then
  choose_port HERMES_LARK_CHANNEL_WEBHOOK_PORT "$HERMES_LARK_CHANNEL_WEBHOOK_PORT" "${HERMES_LARK_CHANNEL_WEBHOOK_HOST:-127.0.0.1}" "Lark webhook"
fi

if [[ "${HERMES_COMPANY_ALLOW_DYNAMIC_LARK_REDIRECT_PORT:-0}" != "1" && "$REGISTERED_LARK_REDIRECT_HOST" =~ ^(127\.0\.0\.1|localhost|0\.0\.0\.0)$ && -n "$REGISTERED_LARK_REDIRECT_PORT" && "$REGISTERED_LARK_REDIRECT_PORT" != "$HERMES_DASHBOARD_PORT" ]]; then
  cat >&2 <<EOF
Cannot start company dev on dashboard port ${HERMES_DASHBOARD_PORT}: Lark OAuth is registered for:
  ${HERMES_COMPANY_REGISTERED_LARK_REDIRECT_BASE_URL}/auth/callback

Lark requires the redirect_uri to match exactly. Auto-shifting the dashboard
port would generate an invalid callback URL and fail with Lark error 20029.

Free the registered dashboard port ${REGISTERED_LARK_REDIRECT_PORT}, then run:
  pnpm dev:company:stop
  pnpm dev:company

Current owner of ${REGISTERED_LARK_REDIRECT_PORT}, if any:
$(port_owner "$REGISTERED_LARK_REDIRECT_PORT")

Only bypass this if you have added the selected port to the Lark app's redirect
allowlist:
  HERMES_COMPANY_ALLOW_DYNAMIC_LARK_REDIRECT_PORT=1 pnpm dev:company
EOF
  exit 1
fi

if [[ "${HERMES_COMPANY_ALLOW_EXTERNAL_URLS:-0}" == "1" ]]; then
  export HERMES_DASHBOARD_PUBLIC_URL="${HERMES_DASHBOARD_PUBLIC_URL:-http://127.0.0.1:${HERMES_DASHBOARD_PORT}}"
  export HERMES_DESKTOP_REMOTE_URL="${HERMES_DESKTOP_REMOTE_URL:-http://127.0.0.1:${HERMES_DASHBOARD_PORT}}"
else
  export HERMES_DASHBOARD_PUBLIC_URL="http://127.0.0.1:${HERMES_DASHBOARD_PORT}"
  export HERMES_DESKTOP_REMOTE_URL="http://127.0.0.1:${HERMES_DASHBOARD_PORT}"
fi
export HERMES_DESKTOP_REMOTE_AUTH_MODE="${HERMES_DESKTOP_REMOTE_AUTH_MODE:-oauth}"
export VITE_ZOHO_ACCOUNTS_BASE_URL="${VITE_ZOHO_ACCOUNTS_BASE_URL:-${ZOHO_ACCOUNTS_BASE_URL:-https://accounts.zoho.com}}"
export VITE_ZOHO_API_BASE_URL="${VITE_ZOHO_API_BASE_URL:-${ZOHO_API_BASE_URL:-https://www.zohoapis.com}}"
DEFAULT_DESKTOP_USER_DATA_DIR="$HERMES_HOME/desktop-profile"
LEGACY_DESKTOP_USER_DATA_DIR="/tmp/hermes-desktop-oauth-profile"
DESKTOP_USER_DATA_DIR_FROM_ENV="${HERMES_DESKTOP_USER_DATA_DIR:-}"
if [[ "${HERMES_COMPANY_ALLOW_EXTERNAL_DESKTOP_PROFILE:-0}" == "1" ]]; then
  export HERMES_DESKTOP_USER_DATA_DIR="${DESKTOP_USER_DATA_DIR_FROM_ENV:-$DEFAULT_DESKTOP_USER_DATA_DIR}"
else
  export HERMES_DESKTOP_USER_DATA_DIR="$DEFAULT_DESKTOP_USER_DATA_DIR"
fi
export API_SERVER_ENABLED="${API_SERVER_ENABLED:-false}"
export HERMES_COMPANY_DEV_PID_FILE="${HERMES_COMPANY_DEV_PID_FILE:-$HERMES_HOME/company-dev.pid}"

if [[ "$HERMES_LARK_CHANNEL_ENABLED_NORMALIZED" =~ ^(true|1|yes|on)$ ]]; then
  # The native adapter still uses FEISHU_* internally. Company-mode config is
  # canonicalized above, then exported here so gateway auth and adapter startup
  # see one consistent Lark channel configuration, including any auto-selected
  # webhook port.
  export FEISHU_APP_ID="$HERMES_LARK_CHANNEL_APP_ID"
  export FEISHU_APP_SECRET="$HERMES_LARK_CHANNEL_APP_SECRET"
  export FEISHU_DOMAIN="$HERMES_LARK_CHANNEL_DOMAIN"
  export FEISHU_CONNECTION_MODE="$HERMES_LARK_CHANNEL_CONNECTION_MODE"
  export FEISHU_VERIFICATION_TOKEN="$HERMES_LARK_CHANNEL_VERIFICATION_TOKEN"
  export FEISHU_ENCRYPT_KEY="$HERMES_LARK_CHANNEL_ENCRYPT_KEY"
  export FEISHU_WEBHOOK_HOST="$HERMES_LARK_CHANNEL_WEBHOOK_HOST"
  export FEISHU_WEBHOOK_PORT="$HERMES_LARK_CHANNEL_WEBHOOK_PORT"
  export FEISHU_WEBHOOK_PATH="$HERMES_LARK_CHANNEL_WEBHOOK_PATH"
  export FEISHU_ALLOW_ALL_USERS="$HERMES_LARK_CHANNEL_ALLOW_ALL_USERS"
  export FEISHU_GROUP_POLICY="$HERMES_LARK_CHANNEL_GROUP_POLICY"
  export FEISHU_REQUIRE_MENTION="$HERMES_LARK_CHANNEL_REQUIRE_MENTION"
fi

if [[ "${1:-}" == "--check" ]]; then
  "$PYTHON_BIN" -m enterprise.readiness --company-dev --check-database
  echo "Company dev env OK"
  echo "  HERMES_COMPANY_INSTANCE_ID=$HERMES_COMPANY_INSTANCE_ID"
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
  echo "  HERMES_DASHBOARD_PORT=$HERMES_DASHBOARD_PORT"
  echo "  HERMES_DESKTOP_RENDERER_PORT=$HERMES_DESKTOP_RENDERER_PORT"
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
   • Dashboard  →  ${HERMES_DASHBOARD_PUBLIC_URL} (port ${HERMES_DASHBOARD_PORT})
   • Desktop app (Electron + Vite port ${HERMES_DESKTOP_RENDERER_PORT})
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
   • If this port auto-changed, restart ngrok with: ngrok http ${HERMES_LARK_CHANNEL_WEBHOOK_PORT:-8765}

Stop:  pnpm dev:company:stop
Home:    ${HERMES_HOME}
Profile: ${HERMES_DESKTOP_USER_DATA_DIR}
         (persistent; set HERMES_DESKTOP_RESET_PROFILE=1 only when you want a fresh login)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
echo

pids=()
shutting_down=0
mkdir -p "$(dirname "$HERMES_COMPANY_DEV_PID_FILE")"
printf '%s\n' "$$" > "$HERMES_COMPANY_DEV_PID_FILE"
PHYSICAL_HERMES_ROOT="$(cd "$HERMES_ROOT" && pwd -P)"

terminate_tree() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
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
  kill -0 "$pid" 2>/dev/null || return 0

  local child
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    force_kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)

  kill -KILL "$pid" 2>/dev/null || true
}

stop_matching() {
  local pattern="$1"
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    [[ "$pid" != "$$" ]] || continue
    terminate_tree "$pid"
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
}

stop_matching_force() {
  local pattern="$1"
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    [[ "$pid" != "$$" ]] || continue
    force_kill_tree "$pid"
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
}

stop_root_scoped_processes() {
  local mode="${1:-term}"
  local stopper="stop_matching"
  if [[ "$mode" == "kill" ]]; then
    stopper="stop_matching_force"
  fi

  "$stopper" "$REQUIRED_HERMES_ROOT/.venv/bin/python -m gateway.run"
  "$stopper" "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m gateway.run"
  "$stopper" "$REQUIRED_HERMES_ROOT/.venv/bin/python -m hermes_cli.main gateway run"
  "$stopper" "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m hermes_cli.main gateway run"
  "$stopper" "$REQUIRED_HERMES_ROOT/.venv/bin/hermes gateway run"
  "$stopper" "$PHYSICAL_HERMES_ROOT/.venv/bin/hermes gateway run"
  "$stopper" "$REQUIRED_HERMES_ROOT/.venv/bin/python -m hermes_cli.main dashboard"
  "$stopper" "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m hermes_cli.main dashboard"
  "$stopper" "$REQUIRED_HERMES_ROOT/node_modules/.bin/wait-on http://127.0.0.1:"
  "$stopper" "$PHYSICAL_HERMES_ROOT/node_modules/.bin/wait-on http://127.0.0.1:"
  "$stopper" "$REQUIRED_HERMES_ROOT/node_modules/electron/dist/Electron.app"
  "$stopper" "$PHYSICAL_HERMES_ROOT/node_modules/electron/dist/Electron.app"
  "$stopper" "$REQUIRED_HERMES_ROOT/node_modules/.bin/electron ."
  "$stopper" "$PHYSICAL_HERMES_ROOT/node_modules/.bin/electron ."
  "$stopper" "$REQUIRED_HERMES_ROOT/node_modules/.bin/vite --host 127.0.0.1 --port"
  "$stopper" "$PHYSICAL_HERMES_ROOT/node_modules/.bin/vite --host 127.0.0.1 --port"
  "$stopper" "$REQUIRED_HERMES_ROOT/apps/desktop/node_modules/.bin/vite --host 127.0.0.1 --port"
  "$stopper" "$PHYSICAL_HERMES_ROOT/apps/desktop/node_modules/.bin/vite --host 127.0.0.1 --port"
}

remove_company_pid_file() {
  [[ -f "$HERMES_COMPANY_DEV_PID_FILE" ]] || return 0
  local recorded_pid
  recorded_pid="$(cat "$HERMES_COMPANY_DEV_PID_FILE" 2>/dev/null || true)"
  if [[ "$recorded_pid" == "$$" ]]; then
    rm -f "$HERMES_COMPANY_DEV_PID_FILE"
    return
  fi
  if [[ "$recorded_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$recorded_pid" 2>/dev/null; then
    rm -f "$HERMES_COMPANY_DEV_PID_FILE"
  fi
}

start_cleanup_watcher() {
  local launcher_pid="$$"
  "$PYTHON_BIN" - "$launcher_pid" "$HERMES_COMPANY_DEV_PID_FILE" \
    "$REQUIRED_HERMES_ROOT/.venv/bin/python -m gateway.run" \
    "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m gateway.run" \
    "$REQUIRED_HERMES_ROOT/.venv/bin/python -m hermes_cli.main gateway run" \
    "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m hermes_cli.main gateway run" \
    "$REQUIRED_HERMES_ROOT/.venv/bin/hermes gateway run" \
    "$PHYSICAL_HERMES_ROOT/.venv/bin/hermes gateway run" \
    "$REQUIRED_HERMES_ROOT/.venv/bin/python -m hermes_cli.main dashboard" \
    "$PHYSICAL_HERMES_ROOT/.venv/bin/python -m hermes_cli.main dashboard" \
    "$REQUIRED_HERMES_ROOT/node_modules/.bin/wait-on http://127.0.0.1:" \
    "$PHYSICAL_HERMES_ROOT/node_modules/.bin/wait-on http://127.0.0.1:" \
    "$REQUIRED_HERMES_ROOT/node_modules/electron/dist/Electron.app" \
    "$PHYSICAL_HERMES_ROOT/node_modules/electron/dist/Electron.app" \
    "$REQUIRED_HERMES_ROOT/node_modules/.bin/electron ." \
    "$PHYSICAL_HERMES_ROOT/node_modules/.bin/electron ." \
    "$REQUIRED_HERMES_ROOT/node_modules/.bin/vite --host 127.0.0.1 --port" \
    "$PHYSICAL_HERMES_ROOT/node_modules/.bin/vite --host 127.0.0.1 --port" \
    "$REQUIRED_HERMES_ROOT/apps/desktop/node_modules/.bin/vite --host 127.0.0.1 --port" \
    "$PHYSICAL_HERMES_ROOT/apps/desktop/node_modules/.bin/vite --host 127.0.0.1 --port" <<'PY' >/dev/null 2>&1 &
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

launcher_pid = int(sys.argv[1])
pid_file = Path(sys.argv[2])
patterns = sys.argv[3:]
self_pid = os.getpid()

try:
    os.setsid()
except OSError:
    pass
for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(sig, signal.SIG_IGN)


def pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def pid_file_still_owned() -> bool:
    try:
        return pid_file.read_text(encoding="utf-8").strip() == str(launcher_pid)
    except OSError:
        return False


def children(pid: int) -> list[int]:
    try:
        output = subprocess.check_output(["pgrep", "-P", str(pid)], text=True)
    except subprocess.CalledProcessError:
        return []
    return [int(line) for line in output.splitlines() if line.strip().isdigit()]


def kill_tree(pid: int, sig: int) -> None:
    if pid in {self_pid, launcher_pid}:
        return
    for child in children(pid):
        kill_tree(child, sig)
    try:
        os.kill(pid, sig)
    except OSError:
        pass


def matching_pids(pattern: str) -> list[int]:
    try:
        output = subprocess.check_output(["pgrep", "-f", pattern], text=True)
    except subprocess.CalledProcessError:
        return []
    pids: list[int] = []
    for line in output.splitlines():
        if not line.strip().isdigit():
            continue
        pid = int(line)
        if pid not in {self_pid, launcher_pid}:
            pids.append(pid)
    return pids


while pid_exists(launcher_pid):
    if not pid_file_still_owned():
        raise SystemExit(0)
    time.sleep(1)

if pid_file_still_owned():
    for pattern in patterns:
        for pid in matching_pids(pattern):
            kill_tree(pid, signal.SIGTERM)
    time.sleep(2)
    for pattern in patterns:
        for pid in matching_pids(pattern):
            kill_tree(pid, signal.SIGKILL)
    try:
        pid_file.unlink()
    except OSError:
        pass
PY
}

cleanup() {
  if [[ "$shutting_down" == "1" ]]; then
    return
  fi
  shutting_down=1
  trap - INT TERM EXIT
  if [[ "${#pids[@]}" -gt 0 ]]; then
    local pid
    for pid in "${pids[@]}"; do
      terminate_tree "$pid"
    done
    stop_root_scoped_processes term

    sleep 2

    for pid in "${pids[@]}"; do
      force_kill_tree "$pid"
    done
    stop_root_scoped_processes kill

    wait "${pids[@]}" 2>/dev/null || true
  fi
  remove_company_pid_file
}

on_interrupt() {
  cleanup
  exit 130
}

on_terminate() {
  cleanup
  exit 143
}

trap on_interrupt INT
trap on_terminate TERM
trap cleanup EXIT
start_cleanup_watcher

(
  cd "$HERMES_ROOT"
  if ((${#GATEWAY_VERBOSE_ARGS[@]})); then
    "$PYTHON_BIN" -m hermes_cli.main gateway run --replace "${GATEWAY_VERBOSE_ARGS[@]}"
  else
    "$PYTHON_BIN" -m hermes_cli.main gateway run --replace
  fi
) &
pids+=("$!")
gateway_pid=${pids[0]}

restart_dashboard() {
  (
    cd "$HERMES_ROOT"
    "$PYTHON_BIN" -m hermes_cli.main dashboard --host 0.0.0.0 --port "$HERMES_DASHBOARD_PORT" --no-open --skip-build
  ) &
  dashboard_pid=$!
  pids[1]="$dashboard_pid"
}

restart_dashboard

wait_for_url "${HERMES_DASHBOARD_PUBLIC_URL}/api/status" "Hermes dashboard API" 90

(
  cd "$HERMES_ROOT/apps/desktop"
  export PATH="$HERMES_ROOT/apps/desktop/node_modules/.bin:$HERMES_ROOT/node_modules/.bin:$PATH"
  export VITE_DESKTOP_FOLLOW_UPS_CLIENT="${VITE_DESKTOP_FOLLOW_UPS_CLIENT:-http}"
  export VITE_DESKTOP_TODAY_PANEL_CLIENT="${VITE_DESKTOP_TODAY_PANEL_CLIENT:-http}"
  export HERMES_DESKTOP_DEV_SERVER="http://127.0.0.1:${HERMES_DESKTOP_RENDERER_PORT}"
  # Cursor/CI agents often set ELECTRON_RUN_AS_NODE=1, which makes `electron .`
  # execute main.cjs under Node (app is undefined). Unset before dev launch.
  unset ELECTRON_RUN_AS_NODE
  node scripts/assert-root-install.cjs
  vite_force_args=()
  if [[ "${HERMES_DESKTOP_VITE_FORCE:-1}" != "0" ]]; then
    vite_force_args=(--force)
  fi
  vite --host 127.0.0.1 --port "$HERMES_DESKTOP_RENDERER_PORT" "${vite_force_args[@]}" &
  renderer_pid=$!
  wait-on "$HERMES_DESKTOP_DEV_SERVER"
  env -u ELECTRON_RUN_AS_NODE XCURSOR_SIZE=24 electron . &
  electron_pid=$!
  trap 'kill "$renderer_pid" "$electron_pid" 2>/dev/null || true' INT TERM EXIT
  while kill -0 "$renderer_pid" 2>/dev/null && kill -0 "$electron_pid" 2>/dev/null; do
    sleep 1
  done
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
