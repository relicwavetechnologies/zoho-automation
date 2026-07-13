#!/bin/bash
# Build and publish a signed Divo Dex release from this Mac. The VPS only hosts
# public files; this script keeps the updater private key on the release Mac.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$JAN_DIR/.." && pwd)"
TAURI_CONFIG="$JAN_DIR/src-tauri/tauri.conf.json"
CHANNEL="${1:-stable}"
BUMP="${2:-patch}"
NOTES_FILE="${3:-}"

RELEASE_BASE_URL="${DIVO_RELEASE_BASE_URL:-https://app-dev.103.172.92.187.sslip.io/desktop-updates}"
RELEASE_HOST="${DIVO_RELEASE_HOST:-103.172.92.187}"
RELEASE_USER="${DIVO_RELEASE_USER:-deploy}"
RELEASE_ROOT="${DIVO_RELEASE_ROOT:-/srv/divo-releases}"
RELEASE_RETENTION="${DIVO_RELEASE_RETENTION:-3}"
RELEASE_OUTPUT_ROOT="${DIVO_RELEASE_OUTPUT_DIR:-$JAN_DIR/release-output}"
UPDATER_KEY_PATH="${DIVO_TAURI_UPDATER_KEY_PATH:-$HOME/.config/divo-dex/updater.key}"
UPDATER_KEYCHAIN_SERVICE="${DIVO_TAURI_UPDATER_KEYCHAIN_SERVICE:-divo-dex-tauri-updater-password}"
UPDATER_KEYCHAIN_ACCOUNT="${DIVO_TAURI_UPDATER_KEYCHAIN_ACCOUNT:-$USER}"
ORIGINAL_CONFIG="$(mktemp)"
PUBLISHED=0

cleanup() {
  if [ "$PUBLISHED" != "1" ] && [ -f "$ORIGINAL_CONFIG" ]; then
    cp "$ORIGINAL_CONFIG" "$TAURI_CONFIG"
  fi
  rm -f "$ORIGINAL_CONFIG"
}
trap cleanup EXIT

fail() { echo "error: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: release-local.sh [stable|dev] [patch|minor|major] [release-notes-file]

Example:
  just release patch stable docs/releases/0.8.4.md
EOF
}

case "$CHANNEL" in stable|dev) ;; *) usage; fail "channel must be stable or dev" ;; esac
case "$BUMP" in patch|minor|major) ;; *) usage; fail "bump must be patch, minor, or major" ;; esac
[[ "$RELEASE_RETENTION" =~ ^[1-9][0-9]*$ ]] || fail "DIVO_RELEASE_RETENTION must be a positive integer"
[ -z "$NOTES_FILE" ] || [ -r "$NOTES_FILE" ] || fail "release notes file is not readable: $NOTES_FILE"
[ "$(uname -s)" = "Darwin" ] || fail "desktop releases must be built on macOS"

for command_name in git node security shasum ssh rsync tar yarn; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command '$command_name' was not found"
done

git -C "$ROOT_DIR" diff --quiet || fail "working tree has unstaged changes; commit or stash them before releasing"
git -C "$ROOT_DIR" diff --cached --quiet || fail "working tree has staged changes; commit or unstage them before releasing"
git -C "$ROOT_DIR" rev-parse --verify HEAD >/dev/null || fail "release requires a committed source revision"
[ -f "$UPDATER_KEY_PATH" ] || fail "missing updater key; run 'just setup-updater-key' first"
[ -f "$UPDATER_KEY_PATH.pub" ] || fail "missing updater public key: $UPDATER_KEY_PATH.pub"
[ "$(stat -f '%Lp' "$UPDATER_KEY_PATH")" = "600" ] || fail "updater private key permissions must be 0600"

UPDATER_KEY_PASSWORD="$(security find-generic-password -a "$UPDATER_KEYCHAIN_ACCOUNT" -s "$UPDATER_KEYCHAIN_SERVICE" -w)" \
  || fail "updater key password is missing from the macOS Keychain"
CONFIG_PUBLIC_KEY="$(node -e "const c=require(process.argv[1]); process.stdout.write(c.plugins.updater.pubkey)" "$TAURI_CONFIG")"
LOCAL_PUBLIC_KEY="$(tr -d '\n' < "$UPDATER_KEY_PATH.pub")"
[ "$CONFIG_PUBLIC_KEY" = "$LOCAL_PUBLIC_KEY" ] || fail "bundled updater public key does not match the local signing key"

cp "$TAURI_CONFIG" "$ORIGINAL_CONFIG"
CURRENT_VERSION="$(node -e "const c=require(process.argv[1]); process.stdout.write(c.version)" "$TAURI_CONFIG")"
NEXT_VERSION="$(node - "$CURRENT_VERSION" "$BUMP" <<'NODE'
const [version, bump] = process.argv.slice(2)
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
if (!match) throw new Error(`Expected numeric semver, received ${version}`)
let [major, minor, patch] = match.slice(1).map(Number)
if (bump === 'major') [major, minor, patch] = [major + 1, 0, 0]
if (bump === 'minor') [minor, patch] = [minor + 1, 0]
if (bump === 'patch') patch += 1
process.stdout.write(`${major}.${minor}.${patch}`)
NODE
)"
RELEASE_DIR="$RELEASE_OUTPUT_ROOT/$CHANNEL/$NEXT_VERSION"
[ ! -e "$RELEASE_DIR" ] || fail "local release output already exists: $RELEASE_DIR"
COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOTES="Divo Dex $NEXT_VERSION"
[ -z "$NOTES_FILE" ] || NOTES="$(<"$NOTES_FILE")"

echo "==> Preparing Divo Dex $NEXT_VERSION from $COMMIT"
node - "$TAURI_CONFIG" "$NEXT_VERSION" <<'NODE'
const fs = require('fs')
const [configPath, version] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
config.version = version
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
NODE

mkdir -p "$RELEASE_DIR"
DIVO_LOCAL_DMG_OUTPUT_DIR="$RELEASE_DIR/dmg" "$SCRIPT_DIR/build-local-dmg.sh" all

build_updater_bundle() {
  local target="$1" architecture="$2"
  local app_dir="$JAN_DIR/src-tauri/target/$target/release/bundle/macos/Divo Dex.app"
  local bundle="Divo_Dex_${NEXT_VERSION}_${architecture}.app.tar.gz"
  local bundle_path="$RELEASE_DIR/$bundle"

  [ -d "$app_dir" ] || fail "signed app bundle is missing: $app_dir"
  tar -C "$(dirname "$app_dir")" -czf "$bundle_path" "$(basename "$app_dir")"
  (
    cd "$JAN_DIR"
    TAURI_PRIVATE_KEY_PATH="$UPDATER_KEY_PATH" \
      TAURI_PRIVATE_KEY_PASSWORD="$UPDATER_KEY_PASSWORD" \
      yarn tauri signer sign "$bundle_path"
  )
  [ -s "$bundle_path.sig" ] || fail "Tauri did not create $bundle_path.sig"
}

echo "==> Creating signed updater bundles"
build_updater_bundle aarch64-apple-darwin aarch64
build_updater_bundle x86_64-apple-darwin x86_64
cp "$RELEASE_DIR/dmg/Divo_Dex_${NEXT_VERSION}_aarch64.dmg" "$RELEASE_DIR/"
cp "$RELEASE_DIR/dmg/Divo_Dex_${NEXT_VERSION}_x86_64.dmg" "$RELEASE_DIR/"
rmdir "$RELEASE_DIR/dmg"

node - "$RELEASE_DIR" "$NEXT_VERSION" "$NOTES" "$PUBLISHED_AT" "$RELEASE_BASE_URL" "$CHANNEL" <<'NODE'
const fs = require('fs')
const path = require('path')
const [dir, version, notes, pubDate, baseUrl, channel] = process.argv.slice(2)
const asset = (arch) => `Divo_Dex_${version}_${arch}.app.tar.gz`
const signature = (arch) => fs.readFileSync(path.join(dir, `${asset(arch)}.sig`), 'utf8').trim()
const url = (arch) => `${baseUrl.replace(/\/$/, '')}/${channel}/${version}/${asset(arch)}`
const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms: {
    'darwin-aarch64': { url: url('aarch64'), signature: signature('aarch64') },
    'darwin-x86_64': { url: url('x86_64'), signature: signature('x86_64') },
  },
}
fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
NODE

(
  cd "$RELEASE_DIR"
  shasum -a 256 \
    "Divo_Dex_${NEXT_VERSION}_aarch64.app.tar.gz" \
    "Divo_Dex_${NEXT_VERSION}_aarch64.app.tar.gz.sig" \
    "Divo_Dex_${NEXT_VERSION}_x86_64.app.tar.gz" \
    "Divo_Dex_${NEXT_VERSION}_x86_64.app.tar.gz.sig" \
    "Divo_Dex_${NEXT_VERSION}_aarch64.dmg" \
    "Divo_Dex_${NEXT_VERSION}_x86_64.dmg" latest.json > SHA256SUMS
)

SSH_TARGET="$RELEASE_USER@$RELEASE_HOST"
REMOTE_STAGE="$RELEASE_ROOT/.staging/${CHANNEL}-${NEXT_VERSION}-$$"
echo "==> Uploading verified release to $SSH_TARGET:$REMOTE_STAGE"
ssh "$SSH_TARGET" "install -d -m 0755 '$RELEASE_ROOT/.staging' '$RELEASE_ROOT/$CHANNEL' '$REMOTE_STAGE'"
rsync -az --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$RELEASE_DIR/" "$SSH_TARGET:$REMOTE_STAGE/"

ssh "$SSH_TARGET" "bash -s -- '$RELEASE_ROOT' '$CHANNEL' '$NEXT_VERSION' '$REMOTE_STAGE' '$RELEASE_RETENTION'" <<'REMOTE'
set -euo pipefail
release_root="$1"; channel="$2"; version="$3"; stage_dir="$4"; retention="$5"
cd "$stage_dir"
sha256sum -c SHA256SUMS
test -s "Divo_Dex_${version}_aarch64.app.tar.gz"
test -s "Divo_Dex_${version}_aarch64.app.tar.gz.sig"
test -s "Divo_Dex_${version}_x86_64.app.tar.gz"
test -s "Divo_Dex_${version}_x86_64.app.tar.gz.sig"
test -s latest.json
release_dir="$release_root/$channel/$version"
test ! -e "$release_dir"
mv "$stage_dir" "$release_dir"
install -m 0644 "$release_dir/latest.json" "$release_root/$channel/.latest.json.$$"
mv -f "$release_root/$channel/.latest.json.$$" "$release_root/$channel/latest.json"
mapfile -t old_releases < <(find "$release_root/$channel" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V | head -n -"$retention")
for old_release in "${old_releases[@]:-}"; do rm -rf -- "$release_root/$channel/$old_release"; done
REMOTE

PUBLISHED=1
echo "Published Divo Dex $NEXT_VERSION"
echo "Update feed: $RELEASE_BASE_URL/$CHANNEL/latest.json"
echo "Commit the version bump in $TAURI_CONFIG before considering this release complete."
