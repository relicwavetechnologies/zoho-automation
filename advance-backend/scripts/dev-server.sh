#!/usr/bin/env bash
# Start the backend watcher and its backend-private Google Workspace MCP sidecar.
# Both are ordinary local processes. SaaS credentials and tool execution remain
# server-side and are never moved into the desktop runtime.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_PORT="${GOOGLE_WORKSPACE_MCP_PORT:-18000}"
SIDECAR_URL="http://127.0.0.1:${SIDECAR_PORT}"
SIDECAR_PID=""
BACKEND_PID=""

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

command -v uvx >/dev/null 2>&1 || die "uvx is required for the Google Workspace MCP sidecar. Install uv with: brew install uv"
[[ -f "$BACKEND_ROOT/.env" ]] || die ".env not found in $BACKEND_ROOT"

cleanup() {
  trap - EXIT INT TERM
  [[ -n "$BACKEND_PID" ]] && kill "$BACKEND_PID" 2>/dev/null || true
  [[ -n "$SIDECAR_PID" ]] && kill "$SIDECAR_PID" 2>/dev/null || true
  [[ -n "$BACKEND_PID" ]] && wait "$BACKEND_PID" 2>/dev/null || true
  [[ -n "$SIDECAR_PID" ]] && wait "$SIDECAR_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

printf 'Starting Google Workspace MCP sidecar...\n'
MCP_ENABLE_OAUTH21=true \
EXTERNAL_OAUTH21_PROVIDER=true \
WORKSPACE_MCP_STATELESS_MODE=true \
WORKSPACE_MCP_HOST=127.0.0.1 \
WORKSPACE_MCP_PORT="$SIDECAR_PORT" \
PORT="$SIDECAR_PORT" \
ALLOWED_FILE_DIRS=/tmp/divo-no-local-files \
  uvx \
    --quiet \
    --python 3.12 \
    --env-file "$BACKEND_ROOT/.env" \
    --from 'workspace-mcp==1.22.0' \
    workspace-mcp \
    --transport streamable-http \
    --tool-tier complete \
    --tools gmail drive calendar docs sheets slides forms tasks contacts chat appscript &
SIDECAR_PID=$!

for attempt in $(seq 1 90); do
  if curl --silent --fail "$SIDECAR_URL/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    wait "$SIDECAR_PID" || true
    die "Google Workspace MCP sidecar exited before becoming ready."
  fi
  if [[ "$attempt" -eq 90 ]]; then
    die "Google Workspace MCP sidecar did not become ready within 90 seconds."
  fi
  sleep 1
done

printf 'Google Workspace MCP sidecar is ready at %s/mcp\n' "$SIDECAR_URL"
printf 'Starting advance-backend with hot reload...\n'

cd "$BACKEND_ROOT"
pnpm exec tsx watch src/index.ts &
BACKEND_PID=$!

# Portable process supervision (including the Bash 3.2 shipped with macOS).
while kill -0 "$SIDECAR_PID" 2>/dev/null && kill -0 "$BACKEND_PID" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
  set +e
  wait "$SIDECAR_PID"
  STATUS=$?
  set -e
else
  set +e
  wait "$BACKEND_PID"
  STATUS=$?
  set -e
fi
exit "$STATUS"
