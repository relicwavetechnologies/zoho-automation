#!/bin/bash
# One-time root setup for the Divo desktop static update host.
# Run this on the VPS after review. Releases themselves run as `deploy`.

set -euo pipefail

RELEASE_ROOT="${DIVO_RELEASE_ROOT:-/srv/divo-releases}"
RELEASE_OWNER="${DIVO_RELEASE_OWNER:-deploy}"
NGINX_SERVER_CONFIG="${DIVO_NGINX_SERVER_CONFIG:-/etc/nginx/sites-available/app-dev}"
NGINX_SNIPPET="${DIVO_NGINX_SNIPPET:-/etc/nginx/snippets/divo-desktop-updates.conf}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNIPPET_SOURCE="$SCRIPT_DIR/nginx/divo-desktop-updates.conf"

fail() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "run this one-time setup as root"
[ -r "$SNIPPET_SOURCE" ] || fail "missing Nginx snippet: $SNIPPET_SOURCE"
[ -f "$NGINX_SERVER_CONFIG" ] || fail "missing Nginx server configuration: $NGINX_SERVER_CONFIG"
command -v nginx >/dev/null 2>&1 || fail "nginx is not installed"
id "$RELEASE_OWNER" >/dev/null 2>&1 || fail "release owner does not exist: $RELEASE_OWNER"

install -d -m 0755 -o "$RELEASE_OWNER" -g "$RELEASE_OWNER" \
  "$RELEASE_ROOT" "$RELEASE_ROOT/.staging" "$RELEASE_ROOT/stable" "$RELEASE_ROOT/dev"
install -D -m 0644 "$SNIPPET_SOURCE" "$NGINX_SNIPPET"

if ! grep -Fq 'include /etc/nginx/snippets/divo-desktop-updates.conf;' "$NGINX_SERVER_CONFIG"; then
  cp "$NGINX_SERVER_CONFIG" "$NGINX_SERVER_CONFIG.bak.$(date -u +%Y%m%d%H%M%S)"
  sed -i '/^[[:space:]]*location \/api\//i\  include /etc/nginx/snippets/divo-desktop-updates.conf;\n' "$NGINX_SERVER_CONFIG"
fi

nginx -t
systemctl reload nginx
echo "Divo desktop update host is ready at /desktop-updates/{stable,dev}/latest.json"
