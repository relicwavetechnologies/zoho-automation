#!/usr/bin/env bash
#
# dev-stack.sh — the whole local stack, in one command.
#
# The runbook asks for four terminals so a failure stays attributable to one
# service. That is the right instinct and this script keeps it: every service
# gets its own log file, and nothing is reported as up until its own health
# check answers. What the four terminals cost was the thing worth removing —
# the ordering, the waiting, and remembering which directory each one runs in.
#
#   scripts/dev-stack.sh            start everything, wait for it, print URLs
#   scripts/dev-stack.sh status     what is up right now
#   scripts/dev-stack.sh stop       stop everything this script can stop
#   scripts/dev-stack.sh logs       tail every service log at once
#
# Safe to re-run. Anything already healthy is left alone rather than restarted,
# so this doubles as a repair command when one service has died.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.dev-stack"
LOG_DIR="$RUN_DIR/logs"

# The backend re-reconciles the tool and skill catalogue on every boot, which
# is most of this. Measured at ~66s on a warm machine; the ceiling is generous
# because a cold Prisma generate is slower and a timeout here reads as a
# failure that is really just patience.
BACKEND_BOOT_TIMEOUT=180
CONTROLLER_BOOT_TIMEOUT=45
ADMIN_BOOT_TIMEOUT=90

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
log()  { echo -e "${GREEN}▶${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
fail() { echo -e "${RED}✖${NC}  $*" >&2; }
ok()   { echo -e "  ${GREEN}●${NC} $*"; }
down() { echo -e "  ${RED}○${NC} $*"; }

# ---------------------------------------------------------------- health
# One definition per service, used by start, status, and the boot wait. A
# service is "up" when it answers, never when its port is merely bound: a
# process that has claimed 8000 and is still reconciling is not a backend yet.

backend_healthy()    { curl -fsS -m 3 http://127.0.0.1:8000/health 2>/dev/null | grep -q '"status":"ok"'; }
controller_healthy() { curl -fsS -m 3 http://127.0.0.1:4317/health 2>/dev/null | grep -q '"status":"ok"'; }
admin_healthy()      { [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:5173/ 2>/dev/null)" == "200" ]]; }
# The MCP sidecar answers 405 to a GET, which is correct: it wants POST. Any
# HTTP status at all proves it is listening, so this asks for a status rather
# than a successful one.
mcp_healthy()        { [[ -n "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:18000/mcp 2>/dev/null | grep -E '^[1-5][0-9][0-9]$')" ]]; }
tunnel_healthy()     { nc -z -w 2 127.0.0.1 15432 >/dev/null 2>&1; }
redis_healthy()      { nc -z -w 2 127.0.0.1 6380 >/dev/null 2>&1 && nc -z -w 2 127.0.0.1 6381 >/dev/null 2>&1; }

# Wait for a health check, or fail loudly and say where to look. Never returns
# success on a timeout — a stack reported as up when it is not costs more than
# the wait did.
wait_for() {
  local label="$1" check="$2" timeout="$3" logfile="${4:-}"
  local waited=0
  while (( waited < timeout )); do
    if "$check"; then
      log "$label ready (${waited}s)"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  fail "$label did not come up within ${timeout}s."
  if [[ -n "$logfile" && -f "$logfile" ]]; then
    fail "Last 20 lines of $logfile:"
    tail -20 "$logfile" >&2
  fi
  return 1
}

# Start a long-running service unless its health check already passes.
# `pnpm dev:e2e` is already idempotent for Redis and the tunnel; this gives the
# other three the same property, so re-running the script repairs the stack
# instead of stacking duplicate processes onto bound ports.
start_service() {
  local name="$1" dir="$2" cmd="$3" check="$4" timeout="$5"
  local logfile="$LOG_DIR/$name.log"

  if "$check"; then
    warn "$name already healthy — leaving it alone."
    return 0
  fi

  log "Starting $name..."
  mkdir -p "$LOG_DIR"
  ( cd "$ROOT/$dir" && eval "$cmd" ) > "$logfile" 2>&1 &
  echo $! > "$RUN_DIR/$name.pid"
  wait_for "$name" "$check" "$timeout" "$logfile"
}

# ---------------------------------------------------------------- commands

cmd_start() {
  if ! docker info >/dev/null 2>&1; then
    fail "Docker Desktop is not running. Start it first; the Cloud-Pi container needs it."
    exit 1
  fi
  mkdir -p "$LOG_DIR"

  # 1. Infra: SSH tunnel to the Development database, plus both Redis instances.
  #    Exits on its own once up, and no-ops whatever is already running.
  if tunnel_healthy && redis_healthy; then
    warn "Tunnel and Redis already up — skipping infra."
  else
    log "Starting tunnel and Redis..."
    if ! ( cd "$ROOT/advance-backend" && pnpm dev:e2e ) > "$LOG_DIR/infra.log" 2>&1; then
      fail "Infra failed to start. Last 20 lines of $LOG_DIR/infra.log:"
      tail -20 "$LOG_DIR/infra.log" >&2
      exit 1
    fi
    log "Tunnel and Redis ready"
  fi

  # 2. The Pi controller, before the backend, so an admitted run has somewhere
  #    to go the moment the backend accepts one.
  start_service "controller" "divo-pi" \
    "MAX_ACTIVE_RUNS=\${MAX_ACTIVE_RUNS:-2} node divo/local-rpc-server.mjs" \
    controller_healthy "$CONTROLLER_BOOT_TIMEOUT" || exit 1

  # 3. Backend, which also brings up the Google Workspace MCP sidecar on 18000.
  start_service "backend" "advance-backend" "pnpm dev" \
    backend_healthy "$BACKEND_BOOT_TIMEOUT" || exit 1

  # 4. Admin UI.
  start_service "admin" "admin" "pnpm dev" \
    admin_healthy "$ADMIN_BOOT_TIMEOUT" || exit 1

  mcp_healthy || warn "Google Workspace MCP sidecar is not answering on 18000. Google tools will fail; see $LOG_DIR/backend.log."

  echo
  cmd_status
  echo
  echo -e "  ${DIM}Logs:${NC}  scripts/dev-stack.sh logs"
  echo -e "  ${DIM}Stop:${NC}  scripts/dev-stack.sh stop"
}

cmd_status() {
  echo -e "${CYAN}Local stack${NC}"
  backend_healthy    && ok "backend        http://127.0.0.1:8000"      || down "backend        http://127.0.0.1:8000"
  admin_healthy      && ok "admin UI       http://localhost:5173"      || down "admin UI       http://localhost:5173"
  controller_healthy && ok "Pi controller  http://127.0.0.1:4317"      || down "Pi controller  http://127.0.0.1:4317"
  mcp_healthy        && ok "Google MCP     http://127.0.0.1:18000/mcp" || down "Google MCP     http://127.0.0.1:18000/mcp"
  tunnel_healthy     && ok "Postgres       127.0.0.1:15432 (tunnel)"   || down "Postgres       127.0.0.1:15432 (tunnel)"
  redis_healthy      && ok "Redis          127.0.0.1:6380 / 6381"      || down "Redis          127.0.0.1:6380 / 6381"

  if controller_healthy; then
    local runs
    runs=$(curl -fsS -m 3 http://127.0.0.1:4317/health 2>/dev/null)
    echo -e "  ${DIM}controller: ${runs}${NC}"
  fi
}

cmd_stop() {
  for name in admin backend controller; do
    local pidfile="$RUN_DIR/$name.pid"
    if [[ -f "$pidfile" ]]; then
      local pid; pid=$(cat "$pidfile")
      # Kill the group: pnpm spawns vite and tsx as children, and killing only
      # the parent leaves the real listener holding the port.
      kill -- "-$(ps -o pgid= "$pid" 2>/dev/null | tr -d ' ')" 2>/dev/null \
        || kill "$pid" 2>/dev/null \
        || true
      rm -f "$pidfile"
      log "Stopped $name"
    fi
  done
  # Anything this script did not start, but which is holding a stack port.
  for port in 5173 8000 4317 18000; do
    local pid; pid=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    [[ -n "$pid" ]] && { kill $pid 2>/dev/null || true; warn "Killed leftover listener on $port"; }
  done
  ( cd "$ROOT/advance-backend" && pnpm stop ) 2>&1 | sed 's/^/  /'
  log "Stack stopped. Divo containers, images and volumes are untouched."
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  local files=("$LOG_DIR"/*.log)
  [[ -e "${files[0]}" ]] || { warn "No logs yet. Start the stack first."; exit 0; }
  tail -f "${files[@]}"
}

case "${1:-start}" in
  start)  cmd_start ;;
  status) cmd_status ;;
  stop)   cmd_stop ;;
  logs)   cmd_logs ;;
  *)
    echo "usage: scripts/dev-stack.sh [start|status|stop|logs]" >&2
    exit 2
    ;;
esac
