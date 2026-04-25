#!/usr/bin/env bash
# server.sh — start the advance-backend server (tsx watch / HMR).
#
# Run dev.sh first to start Redis infrastructure.
# This script only starts the Node.js server — you can Ctrl+C and restart
# as many times as you like without touching Redis or clearing the cache.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}▶${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { echo -e "${RED}✖${NC}  $*" >&2; exit 1; }

[[ -f .env ]] || die ".env not found in $ROOT"

REDIS_QUEUE_PORT=6380
REDIS_CACHE_PORT=6381

# Verify Redis is up before starting the server
for port in $REDIS_QUEUE_PORT $REDIS_CACHE_PORT; do
  if ! redis-cli -p "$port" ping 2>/dev/null | grep -q PONG; then
    die "Redis not responding on port $port — run scripts/dev.sh first"
  fi
done

log "Redis queue OK (port $REDIS_QUEUE_PORT)"
log "Redis cache OK (port $REDIS_CACHE_PORT)"

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  advance-backend server — starting${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${GREEN}Server${NC}  http://localhost:8000  (tsx watch — HMR on save)"
echo -e "  Press ${RED}Ctrl+C${NC} to stop the server (Redis stays up)."
echo ""

exec pnpm dev
