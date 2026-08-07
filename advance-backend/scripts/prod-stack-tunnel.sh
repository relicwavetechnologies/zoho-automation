#!/usr/bin/env bash
# prod-stack-tunnel.sh — forward the production stack's internal services to
# localhost so a backend running on this machine can join it.
#
# Only Postgres is published on the VPS host; everything else lives on the
# docker networks and is reachable only from inside them. sshd runs on the host,
# which routes to both networks, so one SSH session can forward all of them by
# container IP.
#
# Read-only in the sense that it opens no ports on the VPS and changes nothing
# there. What the local process then does with these connections is not.
#
#   scripts/prod-stack-tunnel.sh up      # start (background)
#   scripts/prod-stack-tunnel.sh status
#   scripts/prod-stack-tunnel.sh down
#
# Optional reverse tunnel, so a Pi container on the VPS can call back into the
# backend running here:
#   REVERSE_BACKEND_PORT=13003 scripts/prod-stack-tunnel.sh up

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
STATE_DIR="${STATE_DIR:-$ROOT/../.context}"
PID_FILE="$STATE_DIR/prod-stack-tunnel.pid"

SSH_HOST="${PROD_SSH_HOST:-103.172.92.187}"
SSH_USER="${PROD_SSH_USER:-deploy}"

# local:remote_ip:remote_port — container IPs on divo-main_divo-main-internal
# and divo-main_divo-main-agent-control.
FORWARDS=(
  "15434:172.24.0.7:5432"    # postgres      divo_main
  "16379:172.24.0.2:6379"    # redis cache
  "16380:172.24.0.5:6379"    # redis queue
  "16381:172.24.0.4:6379"    # redis memory
  "14317:172.25.0.2:4317"    # pi controller
  "18010:172.24.0.3:8000"    # google-workspace-mcp
  "18888:172.24.0.10:8888"   # hindsight
  "13310:172.24.0.6:3310"    # clamav
)

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}▶${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { echo -e "${RED}✖${NC}  $*" >&2; exit 1; }

read_env_value() {
  local key="$1" line value
  [[ -f "$ENV_FILE" ]] || return 0
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

tunnel_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && printf '%s' "$pid"
}

cmd_up() {
  if pid="$(tunnel_pid)"; then
    warn "already running (pid $pid)"; cmd_status; return 0
  fi
  mkdir -p "$STATE_DIR"

  local args=()
  for f in "${FORWARDS[@]}"; do
    args+=(-L "127.0.0.1:${f}")
  done
  if [[ -n "${REVERSE_BACKEND_PORT:-}" ]]; then
    # Bound to the VPS loopback. Reaching it from a container needs
    # host.docker.internal or the docker bridge gateway on that side.
    args+=(-R "127.0.0.1:${REVERSE_BACKEND_PORT}:127.0.0.1:${LOCAL_BACKEND_PORT:-3001}")
  fi

  local pw; pw="$(read_env_value DB_TUNNEL_SSH_PASSWORD)"
  local -a launcher=()
  if [[ -n "$pw" ]]; then
    command -v sshpass >/dev/null 2>&1 || die "sshpass not installed and DB_TUNNEL_SSH_PASSWORD is set"
    export SSHPASS="$pw"
    launcher=(sshpass -e)
  fi

  "${launcher[@]}" ssh -N -o StrictHostKeyChecking=no -o LogLevel=ERROR \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    "${args[@]}" "${SSH_USER}@${SSH_HOST}" &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # ExitOnForwardFailure means a bound port kills the session; give it a moment
  # to fail loudly rather than reporting a tunnel that is already dead.
  sleep 3
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    die "tunnel exited immediately — a local port is probably already bound"
  fi
  log "tunnel up (pid $pid)"
  cmd_status
}

cmd_down() {
  if pid="$(tunnel_pid)"; then
    kill "$pid" 2>/dev/null
    rm -f "$PID_FILE"
    log "tunnel stopped (pid $pid)"
  else
    warn "not running"
    rm -f "$PID_FILE"
  fi
}

cmd_status() {
  if pid="$(tunnel_pid)"; then
    log "running (pid $pid)"
  else
    warn "not running"
    return 1
  fi
  for f in "${FORWARDS[@]}"; do
    local lp="${f%%:*}"
    if nc -z 127.0.0.1 "$lp" 2>/dev/null; then
      printf '   %-6s open   → %s\n' "$lp" "${f#*:}"
    else
      printf '   %-6s CLOSED → %s\n' "$lp" "${f#*:}"
    fi
  done
}

case "${1:-status}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  *)      die "usage: $0 {up|down|status}" ;;
esac
