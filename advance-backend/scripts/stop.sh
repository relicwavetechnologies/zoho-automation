#!/usr/bin/env bash
# stop.sh — kill Redis queue and cache instances started by dev.sh.

set -uo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}▶${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }

stop_redis() {
  local label="$1" port="$2"
  local pid
  pid=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [[ -n "$pid" ]]; then
    log "Stopping $label Redis (port $port, pid $pid)..."
    kill "$pid" 2>/dev/null || true
  else
    warn "$label Redis not running on port $port"
  fi
}

stop_redis "queue" 6380
stop_redis "cache" 6381

log "Done."
