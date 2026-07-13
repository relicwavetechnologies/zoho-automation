#!/bin/bash
# Create the local-only Tauri updater signing key used by Divo Dex releases.
# The private key stays outside this checkout and its passphrase is kept in the
# macOS login Keychain.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
KEY_DIR="${DIVO_TAURI_UPDATER_KEY_DIR:-$HOME/.config/divo-dex}"
KEY_PATH="${DIVO_TAURI_UPDATER_KEY_PATH:-$KEY_DIR/updater.key}"
KEYCHAIN_SERVICE="${DIVO_TAURI_UPDATER_KEYCHAIN_SERVICE:-divo-dex-tauri-updater-password}"
KEYCHAIN_ACCOUNT="${DIVO_TAURI_UPDATER_KEYCHAIN_ACCOUNT:-$USER}"

fail() { echo "error: $*" >&2; exit 1; }

command -v security >/dev/null 2>&1 || fail "macOS Keychain command 'security' was not found"
command -v openssl >/dev/null 2>&1 || fail "openssl was not found"
command -v yarn >/dev/null 2>&1 || fail "yarn was not found"

umask 077
mkdir -p "$KEY_DIR"

if [ ! -f "$KEY_PATH" ]; then
  password="$(openssl rand -base64 48 | tr -d '\n')"
  security add-generic-password -U -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w "$password" >/dev/null
  (
    cd "$JAN_DIR"
    TAURI_PRIVATE_KEY_PASSWORD="$password" \
      yarn tauri signer generate --ci --password "$password" --write-keys "$KEY_PATH"
  )
  chmod 600 "$KEY_PATH"
fi

[ -f "$KEY_PATH.pub" ] || fail "updater public key was not generated"
[ "$(stat -f '%Lp' "$KEY_PATH")" = "600" ] || fail "updater private key permissions must be 0600"
security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w >/dev/null

echo "Divo updater signing key is ready."
echo "Private key: $KEY_PATH"
echo "Public key: $(tr -d '\n' < "$KEY_PATH.pub")"
