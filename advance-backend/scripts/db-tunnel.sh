#!/usr/bin/env bash
# db-tunnel.sh — manage the local SSH tunnel to the VPS Postgres sidecar.
#
# Defaults match advance-backend/.env:
#   local  127.0.0.1:15432
#   remote 127.0.0.1:15433 on the development VPS
#
# Authentication:
#   - Preferred: normal SSH key/agent auth.
#   - Password mode: set DB_TUNNEL_SSH_PASSWORD or SSHPASS in the environment.
#   - Local-only .env support: DB_TUNNEL_* keys are read from advance-backend/.env.
#
# Do not hardcode SSH passwords in this tracked script.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROOT/.." && pwd)"
ENV_FILE="${DB_TUNNEL_ENV_FILE:-$ROOT/.env}"
STATE_DIR="${DB_TUNNEL_STATE_DIR:-$WORKSPACE_ROOT/.context}"
PID_FILE="$STATE_DIR/db-tunnel.pid"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
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

env_or_file() {
  local key="$1" fallback="$2"
  local current="${!key:-}"
  if [[ -n "$current" ]]; then
    printf '%s' "$current"
    return
  fi
  local from_file
  from_file="$(read_env_value "$key")"
  if [[ -n "$from_file" ]]; then
    printf '%s' "$from_file"
    return
  fi
  printf '%s' "$fallback"
}

LOCAL_HOST="$(env_or_file DB_TUNNEL_LOCAL_HOST 127.0.0.1)"
LOCAL_PORT="$(env_or_file DB_TUNNEL_LOCAL_PORT 15432)"
REMOTE_HOST="$(env_or_file DB_TUNNEL_REMOTE_HOST 127.0.0.1)"
REMOTE_PORT="$(env_or_file DB_TUNNEL_REMOTE_PORT 15433)"
SSH_USER="$(env_or_file DB_TUNNEL_SSH_USER deploy)"
SSH_HOST="$(env_or_file DB_TUNNEL_SSH_HOST 103.172.92.187)"
SSH_IDENTITY_FILE="$(env_or_file DB_TUNNEL_SSH_IDENTITY_FILE '')"
DB_NAME="$(env_or_file DB_TUNNEL_DB_NAME divo_dev)"
SSH_PASSWORD="$(env_or_file DB_TUNNEL_SSH_PASSWORD "${SSHPASS:-}")"

mkdir -p "$STATE_DIR"

tunnel_pids() {
  lsof -tiTCP:"$LOCAL_PORT" -sTCP:LISTEN 2>/dev/null || true
}

is_postgres_ready() {
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h "$LOCAL_HOST" -p "$LOCAL_PORT" -d "$DB_NAME" >/dev/null 2>&1
    return $?
  fi
  nc -z "$LOCAL_HOST" "$LOCAL_PORT" >/dev/null 2>&1
}

write_pid_file() {
  local pid
  pid="$(tunnel_pids | head -n 1)"
  [[ -n "$pid" ]] && printf '%s\n' "$pid" > "$PID_FILE"
}

stop_tunnel() {
  local stopped=0

  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "Stopping DB tunnel pid $pid..."
      kill "$pid" 2>/dev/null || true
      stopped=1
    fi
    rm -f "$PID_FILE"
  fi

  local pid comm
  for pid in $(tunnel_pids); do
    comm="$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ')"
    if [[ "$comm" == "ssh" ]]; then
      log "Stopping DB tunnel listener pid $pid..."
      kill "$pid" 2>/dev/null || true
      stopped=1
    else
      warn "Port $LOCAL_PORT is used by non-ssh process pid $pid; leaving it alone."
    fi
  done

  if [[ "$stopped" == "0" ]]; then
    warn "No DB tunnel found on $LOCAL_HOST:$LOCAL_PORT"
  fi
}

start_tunnel() {
  local pids
  pids="$(tunnel_pids)"
  if [[ -n "$pids" ]]; then
    if is_postgres_ready; then
      write_pid_file
      log "DB tunnel already healthy on $LOCAL_HOST:$LOCAL_PORT"
      return
    fi
    warn "Stale listener found on $LOCAL_HOST:$LOCAL_PORT; replacing it."
    stop_tunnel
    sleep 0.3
  fi

  command -v ssh >/dev/null 2>&1 || die "ssh not found"
  if [[ -n "$SSH_PASSWORD" ]]; then
    command -v sshpass >/dev/null 2>&1 || die "sshpass not found; install it or use SSH key auth"
  fi

  log "Starting DB tunnel $LOCAL_HOST:$LOCAL_PORT → $SSH_USER@$SSH_HOST:$REMOTE_HOST:$REMOTE_PORT..."
  local ssh_args=(
    -fN
    -L "$LOCAL_HOST:$LOCAL_PORT:$REMOTE_HOST:$REMOTE_PORT"
    -o StrictHostKeyChecking=no
    -o ExitOnForwardFailure=yes
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=3
  )
  if [[ -n "$SSH_IDENTITY_FILE" ]]; then
    [[ -r "$SSH_IDENTITY_FILE" ]] || die "SSH identity file is not readable: $SSH_IDENTITY_FILE"
    ssh_args+=(
      -i "$SSH_IDENTITY_FILE"
      -o IdentitiesOnly=yes
    )
  fi
  ssh_args+=("$SSH_USER@$SSH_HOST")

  if [[ -n "$SSH_PASSWORD" ]]; then
    SSHPASS="$SSH_PASSWORD" sshpass -e ssh "${ssh_args[@]}" || die "SSH authentication or port forwarding failed"
  else
    ssh "${ssh_args[@]}" || die "SSH authentication or port forwarding failed"
  fi

  for _ in $(seq 1 20); do
    if is_postgres_ready; then
      write_pid_file
      log "DB tunnel ready on $LOCAL_HOST:$LOCAL_PORT"
      return
    fi
    sleep 0.5
  done

  die "DB tunnel started but Postgres did not respond on $LOCAL_HOST:$LOCAL_PORT"
}

status_tunnel() {
  local pids
  pids="$(tunnel_pids)"
  if [[ -z "$pids" ]]; then
    warn "DB tunnel is not listening on $LOCAL_HOST:$LOCAL_PORT"
    return 1
  fi

  if is_postgres_ready; then
    log "DB tunnel healthy on $LOCAL_HOST:$LOCAL_PORT (pid $(echo "$pids" | head -n 1))"
    return 0
  fi

  warn "DB tunnel listener exists on $LOCAL_HOST:$LOCAL_PORT but Postgres is not responding"
  return 2
}

# Keep the tunnel up for as long as this runs.
#
# `ssh -fN` is one-shot. Combined with ServerAliveInterval=30 and
# ServerAliveCountMax=3 above, ssh deliberately kills itself after roughly
# ninety seconds of an unresponsive server — which is the right way to notice a
# dead link, and useless on its own, because nothing then brings it back. A
# single blip on the way to the host ends the tunnel for good, and the first
# thing anybody sees is the backend answering `{"status":"degraded"}` some
# minutes later with no clue why.
#
# So: poll the same readiness check `status` uses, and start the tunnel again
# whenever it stops answering. No new dependency; autossh would do this better
# but is not installed.
watch_tunnel() {
  local interval="${DB_TUNNEL_WATCH_INTERVAL:-15}"
  log "Watching DB tunnel every ${interval}s. Ctrl-C to stop."
  # Ensure there is something to watch before the first poll.
  is_postgres_ready || start_tunnel
  while true; do
    sleep "$interval"
    if ! is_postgres_ready; then
      warn "DB tunnel stopped answering; restarting..."
      # Clears a listener that survived its ssh session, which would otherwise
      # make the port look taken and the restart fail.
      stop_tunnel >/dev/null 2>&1 || true
      start_tunnel || warn "Restart failed; will try again in ${interval}s"
    fi
  done
}

case "${1:-status}" in
  start)   start_tunnel ;;
  stop)    stop_tunnel ;;
  restart) stop_tunnel; start_tunnel ;;
  status)  status_tunnel ;;
  watch)   watch_tunnel ;;
  *)
    cat <<EOF
Usage: scripts/db-tunnel.sh <start|stop|restart|status|watch>

  watch  keeps the tunnel up, restarting it whenever it stops answering.
         Runs in the foreground; background it with & or a separate terminal.

Optional env/.env keys:
  DB_TUNNEL_SSH_HOST        default: 103.172.92.187
  DB_TUNNEL_SSH_USER        default: deploy
  DB_TUNNEL_SSH_IDENTITY_FILE optional private-key path
  DB_TUNNEL_SSH_PASSWORD    optional, not printed
  DB_TUNNEL_LOCAL_PORT      default: 15432
  DB_TUNNEL_REMOTE_PORT     default: 15433
EOF
    exit 2
    ;;
esac
