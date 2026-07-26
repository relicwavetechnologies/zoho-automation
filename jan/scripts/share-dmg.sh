#!/bin/bash
# Build a signed, notarized Divo Dex DMG from the current checkout and put it on
# the VPS so someone else can download and install it.
#
# This is deliberately NOT a release. It never bumps a version and never writes
# a channel's latest.json, so nothing already installed is affected by running
# it. Builds land under a testing/ prefix that no updater ever polls.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$JAN_DIR/.." && pwd)"
TAURI_CONFIG="$JAN_DIR/src-tauri/tauri.conf.json"
SELECTOR="${1:-aarch64}"

SHARE_BASE_URL="${DIVO_RELEASE_BASE_URL:-https://app-dev.103.172.92.187.sslip.io/desktop-updates}"
SHARE_HOST="${DIVO_RELEASE_HOST:-103.172.92.187}"
SHARE_USER="${DIVO_RELEASE_USER:-deploy}"
SHARE_ROOT="${DIVO_RELEASE_ROOT:-/srv/divo-releases}"
SHARE_RETENTION="${DIVO_SHARE_RETENTION:-5}"

fail() { echo "error: $*" >&2; exit 1; }

case "$SELECTOR" in
  all|aarch64|arm64|aarch64-apple-darwin|x86_64|intel|x86_64-apple-darwin) ;;
  *) fail "unknown target '$SELECTOR' (use all, aarch64, or x86_64)" ;;
esac

[ "$(uname -s)" = "Darwin" ] || fail "shareable builds must be produced on macOS"
[[ "$SHARE_RETENTION" =~ ^[1-9][0-9]*$ ]] || fail "DIVO_SHARE_RETENTION must be a positive integer"

for command_name in git node rsync shasum ssh; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command '$command_name' was not found"
done

VERSION="$(node -e "const c=require(process.argv[1]); process.stdout.write(c.version)" "$TAURI_CONFIG")"
[ -n "$VERSION" ] || fail "could not read the desktop version"

# A shared build is identified by the commit it came from, not by a version:
# several shares can carry the same version, and only the commit distinguishes
# them. An uncommitted tree is marked so nobody mistakes it for a clean build.
COMMIT="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
BUILD_ID="$VERSION-$COMMIT"
if ! git -C "$ROOT_DIR" diff --quiet || ! git -C "$ROOT_DIR" diff --cached --quiet; then
  BUILD_ID="$BUILD_ID-dirty"
  echo "note: the working tree has uncommitted changes; publishing as $BUILD_ID"
fi

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/divo-share.XXXXXX")"
trap 'rm -rf "$STAGE_DIR"' EXIT

echo "==> Building shareable Divo Dex $VERSION ($COMMIT)"
# Notarization is mandatory here: the DMG is downloaded on another Mac, so it
# arrives quarantined and Gatekeeper will block anything Apple has not stapled.
DIVO_SKIP_NOTARIZATION=0 DIVO_LOCAL_DMG_OUTPUT_DIR="$STAGE_DIR" \
  "$SCRIPT_DIR/build-local-dmg.sh" "$SELECTOR"

shopt -s nullglob
DMGS=("$STAGE_DIR"/*.dmg)
shopt -u nullglob
[ "${#DMGS[@]}" -gt 0 ] || fail "no DMG was produced"

(cd "$STAGE_DIR" && shasum -a 256 ./*.dmg > SHA256SUMS)

REMOTE_DIR="$SHARE_ROOT/testing/$BUILD_ID"
echo "==> Uploading to $SHARE_USER@$SHARE_HOST:$REMOTE_DIR"
ssh "$SHARE_USER@$SHARE_HOST" "rm -rf '$REMOTE_DIR' && install -d -m 0755 '$SHARE_ROOT/testing' '$REMOTE_DIR'"
rsync -az --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$STAGE_DIR/" "$SHARE_USER@$SHARE_HOST:$REMOTE_DIR/"

ssh "$SHARE_USER@$SHARE_HOST" "bash -s -- '$SHARE_ROOT' '$BUILD_ID' '$SHARE_RETENTION'" <<'REMOTE'
set -euo pipefail
share_root="$1"; build_id="$2"; retention="$3"
cd "$share_root/testing/$build_id"
sha256sum -c SHA256SUMS
# rsync carries the local staging directory's mode across, and that directory is
# created private. Nginx has to traverse this one, so set the mode here rather
# than depending on the umask of whoever ran the build.
chmod 0755 "$share_root/testing/$build_id"
# Keep the newest builds by upload time; names are commit-based, so they do not
# sort chronologically.
mapfile -t stale < <(
  find "$share_root/testing" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' \
    | sort -rn | tail -n +"$((retention + 1))" | cut -d' ' -f2-
)
for old in "${stale[@]:-}"; do
  [ -n "$old" ] || continue
  rm -rf -- "$share_root/testing/$old"
done
REMOTE

echo
echo "Shareable build $BUILD_ID:"
for dmg in "${DMGS[@]}"; do
  echo "  $SHARE_BASE_URL/testing/$BUILD_ID/$(basename "$dmg")"
done
echo
echo "This did not bump a version or touch any update feed."
