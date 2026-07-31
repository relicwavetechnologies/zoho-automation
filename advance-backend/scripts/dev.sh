#!/usr/bin/env bash
# dev.sh — start local infrastructure for advance-backend.
#
# Starts:
#   1. Redis queue  (port 6380, no memory limit)
#   2. Redis cache  (port 6381, 50 MB LRU)
#
# pnpm dev:e2e starts and verifies the VM Postgres SSH tunnel before invoking
# this script, so a tunnel failure aborts the command before infra reports ready.
#
# Infra keeps running until you explicitly kill it with stop.sh.
# Restart the backend and Google Workspace MCP sidecar with: pnpm dev
#
# Ctrl+C exits this script but does NOT kill Redis/tunnel.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# ── colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}▶${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { echo -e "${RED}✖${NC}  $*" >&2; exit 1; }

# ── preflight ─────────────────────────────────────────────────────────────────
[[ -f .env ]]                       || die ".env not found in $ROOT"
command -v redis-server &>/dev/null || die "redis-server not found — brew install redis"

REDIS_QUEUE_PORT=6380
REDIS_CACHE_PORT=6381

# ── helper: start one Redis instance (no-op if already running) ──────────────
start_redis() {
  local label="$1" port="$2" maxmem="$3" logfile="$4"

  if lsof -ti tcp:"$port" &>/dev/null; then
    warn "$label Redis already running on port $port — skipping."
    return
  fi

  log "Starting $label Redis on port $port${maxmem:+ (maxmemory $maxmem)}..."
  redis-server \
    --port        "$port" \
    --loglevel    warning \
    --save        "" \
    --appendonly  no \
    --daemonize   yes \
    ${maxmem:+--maxmemory "$maxmem" --maxmemory-policy allkeys-lru} \
    --logfile     "$logfile"

  for i in $(seq 1 10); do
    if redis-cli -p "$port" ping 2>/dev/null | grep -q PONG; then
      log "$label Redis ready on port $port"
      return
    fi
    sleep 0.5
    if [[ $i -eq 10 ]]; then
      die "$label Redis did not start — check $logfile"
    fi
  done
}

# ── Start Redis (daemonised — survives script exit) ────────────────────────────────────────
start_redis "queue" "$REDIS_QUEUE_PORT" ""      /tmp/divo-redis-queue.log
start_redis "cache" "$REDIS_CACHE_PORT" "50mb"  /tmp/divo-redis-cache.log

# ── Prisma generate ───────────────────────────────────────────────────────────
log "Checking Prisma client..."
pnpm prisma generate 2>&1 | grep -E "Generated|already up to date" || true

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  Local infrastructure is up${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${GREEN}Postgres${NC}     localhost:15432  (SSH tunnel to VM, daemonised)"
echo -e "  ${GREEN}Redis queue${NC}  localhost:$REDIS_QUEUE_PORT  (no limit, daemonised)"
echo -e "  ${GREEN}Redis cache${NC}  localhost:$REDIS_CACHE_PORT  (50 MB max, LRU, daemonised)"
echo -e "  ${GREEN}Google MCP${NC}   starts automatically with pnpm dev"
echo ""
echo -e "  Start the backend:  ${CYAN}pnpm dev${NC}  (or  ${CYAN}scripts/server.sh${NC})"
echo -e "  Stop everything:    ${CYAN}pnpm stop${NC}"
echo ""
