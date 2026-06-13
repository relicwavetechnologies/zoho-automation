#!/usr/bin/env bash
set -euo pipefail

pkill -f 'gateway.run' || true
pkill -f 'hermes_cli.main dashboard' || true
pkill -f 'electron .' || true
pkill -f 'vite --host 127.0.0.1 --port 5174' || true

PROFILE_DIR="${HERMES_DESKTOP_USER_DATA_DIR:-/tmp/hermes-desktop-oauth-profile}"
echo "Stopped Hermes company dev processes."
echo "  Desktop profile preserved at: ${PROFILE_DIR}"
echo "  Next dev:company start wipes profile unless HERMES_DESKTOP_RESET_PROFILE=0"
