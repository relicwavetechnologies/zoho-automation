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
#   scripts/dev-stack.sh build      rebuild the Pi runtime image after editing
#                                   anything under divo-pi/divo
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

# ---------------------------------------------------------------- the image
# The half of the runtime that restarting does not update.
#
# `divo-pi/Dockerfile` does `COPY . .`, so everything Pi runs inside the
# container — the whole gateway extension included — is baked in at build time.
# Restarting the controller reloads the host's own .mjs files and nothing else,
# which makes a stale image the quietest failure in this stack: every service
# reports healthy, the code you just wrote is simply not the code that runs.
# So this is checked rather than assumed.

PI_IMAGE="${DIVO_PI_IMAGE:-divo-pi-local:phase0}"

image_built_epoch() {
  local created
  created=$(docker image inspect "$PI_IMAGE" --format '{{.Created}}' 2>/dev/null) || return 1
  [[ -n "$created" ]] || return 1
  # 2026-08-20T22:55:41.140068883Z — seconds are all this comparison needs.
  date -j -u -f '%Y-%m-%dT%H:%M:%S' "${created%%.*}" +%s 2>/dev/null
}

# Only the sources the image carries. Editing the backend or the admin UI is no
# reason to rebuild a container, and saying otherwise would train you to ignore
# the warning that matters.
newest_runtime_source_epoch() {
  find "$ROOT/divo-pi/divo" \
    \( -name node_modules -prune \) -o \
    -type f \( -name '*.ts' -o -name '*.mjs' -o -name '*.json' \) -print0 2>/dev/null \
    | xargs -0 stat -f '%m' 2>/dev/null | sort -rn | head -1
}

image_current() {
  local built newest
  built=$(image_built_epoch) || return 1
  newest=$(newest_runtime_source_epoch)
  [[ -n "$newest" ]] || return 0
  (( built >= newest ))
}

report_image() {
  local built newest
  if ! built=$(image_built_epoch); then
    down "Pi image      $PI_IMAGE (not built)"
    warn "Build it before running anything through Pi: scripts/dev-stack.sh build"
    return
  fi
  newest=$(newest_runtime_source_epoch)
  if [[ -n "$newest" ]] && (( built < newest )); then
    # Both stamped with the date. An image from last week shown as a bare
    # clock time reads as newer than a source edited this morning.
    down "Pi image      $PI_IMAGE (STALE — built $(date -r "$built" '+%b %d %H:%M'), sources changed $(date -r "$newest" '+%b %d %H:%M'))"
    warn "Pi is running older code than this checkout. Rebuild: scripts/dev-stack.sh build"
  else
    ok "Pi image      $PI_IMAGE (built $(date -r "$built" '+%b %d %H:%M'))"
  fi
}

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

cmd_build() {
  if ! docker info >/dev/null 2>&1; then
    fail "Docker Desktop is not running."
    exit 1
  fi
  log "Building $PI_IMAGE (this bakes divo-pi/divo into the runtime)..."
  mkdir -p "$LOG_DIR"
  if ! docker build -t "$PI_IMAGE" "$ROOT/divo-pi" > "$LOG_DIR/image.log" 2>&1; then
    fail "Image build failed. Last 20 lines of $LOG_DIR/image.log:"
    tail -20 "$LOG_DIR/image.log" >&2
    exit 1
  fi
  log "Built $PI_IMAGE"

  # A container started from the old image keeps running it. The controller
  # replaces one whose image id has moved, but only on its next run, and a warm
  # Pi process it is still holding never gets that far. Clearing them here means
  # "built" and "running" cannot drift apart silently.
  local stale
  stale=$(docker ps -q --filter "ancestor=$PI_IMAGE" --filter "name=divo-pi" 2>/dev/null)
  for name in $(docker ps --format '{{.Names}}' 2>/dev/null | grep '^divo-pi-local' || true); do
    docker rm -f "$name" >/dev/null 2>&1 && warn "Removed runtime container $name (its session volume is untouched)"
  done
  [[ -n "$stale" ]] || true

  if controller_healthy; then
    warn "Restart the controller so it drops any warm Pi process: scripts/dev-stack.sh stop && scripts/dev-stack.sh start"
  fi
}

cmd_status() {
  echo -e "${CYAN}Local stack${NC}"
  backend_healthy    && ok "backend        http://127.0.0.1:8000"      || down "backend        http://127.0.0.1:8000"
  admin_healthy      && ok "admin UI       http://localhost:5173"      || down "admin UI       http://localhost:5173"
  controller_healthy && ok "Pi controller  http://127.0.0.1:4317"      || down "Pi controller  http://127.0.0.1:4317"
  mcp_healthy        && ok "Google MCP     http://127.0.0.1:18000/mcp" || down "Google MCP     http://127.0.0.1:18000/mcp"
  tunnel_healthy     && ok "Postgres       127.0.0.1:15432 (tunnel)"   || down "Postgres       127.0.0.1:15432 (tunnel)"
  redis_healthy      && ok "Redis          127.0.0.1:6380 / 6381"      || down "Redis          127.0.0.1:6380 / 6381"
  docker info >/dev/null 2>&1 && report_image

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
  build)  cmd_build ;;
  *)
    echo "usage: scripts/dev-stack.sh [start|status|stop|logs|build]" >&2
    exit 2
    ;;
esac
