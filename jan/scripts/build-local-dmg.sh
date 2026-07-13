#!/bin/bash
# Build local Divo Dex DMGs from the current checkout.
#
# By default this produces separate Apple Silicon and Intel packages. Each app
# and DMG is signed with the local Developer ID identity, submitted to Apple's
# notarization service, stapled, and verified before the script succeeds.
#
# Apple credentials are read from environment variables, the existing AirNote
# Keychain entry, or the local deploy-airnote skill. Secrets are never written
# into this repository or printed by this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_DIR="$JAN_DIR/src-tauri"
OUTPUT_DIR="${DIVO_LOCAL_DMG_OUTPUT_DIR:-$JAN_DIR/local-dmg}"
SELECTOR="${1:-all}"

APPLE_ID="${APPLE_ID:-shivam@emiactech.com}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-96ZQGP7L3B}"
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: EMIAC TECHNOLOGIES LIMITED (96ZQGP7L3B)}"
APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-airnote-deploy}"
NOTARY_TIMEOUT="${NOTARY_TIMEOUT:-45m}"
DEPLOY_AIRNOTE_SKILL="${DEPLOY_AIRNOTE_SKILL:-$HOME/.codex/skills/deploy-airnote/SKILL.md}"

ACTIVE_MOUNT_POINT=""

cleanup() {
  if [ -n "$ACTIVE_MOUNT_POINT" ] && mount | grep -Fq "on $ACTIVE_MOUNT_POINT "; then
    hdiutil detach "$ACTIVE_MOUNT_POINT" >/dev/null 2>&1 || true
  fi
  if [ -n "$ACTIVE_MOUNT_POINT" ]; then
    rmdir "$ACTIVE_MOUNT_POINT" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' was not found"
}

case "$SELECTOR" in
  all)
    TARGETS="aarch64-apple-darwin x86_64-apple-darwin"
    ;;
  aarch64|arm64|aarch64-apple-darwin)
    TARGETS="aarch64-apple-darwin"
    ;;
  x86_64|intel|x86_64-apple-darwin)
    TARGETS="x86_64-apple-darwin"
    ;;
  --preflight)
    TARGETS=""
    ;;
  *)
    fail "unknown target '$SELECTOR' (use all, aarch64, x86_64, or --preflight)"
    ;;
esac

[ "$(uname -s)" = "Darwin" ] || fail "local signed DMGs must be built on macOS"

for command_name in codesign file hdiutil node rustup security shasum spctl xcrun yarn; do
  require_command "$command_name"
done

if ! security find-identity -v -p codesigning | grep -Fq "\"$APPLE_SIGNING_IDENTITY\""; then
  fail "Developer ID identity '$APPLE_SIGNING_IDENTITY' is not available in the login Keychain"
fi

APPLE_NOTARY_PASSWORD="${APPLE_APP_SPECIFIC_PASSWORD:-${APPLE_PASSWORD:-}}"
if [ -z "$APPLE_NOTARY_PASSWORD" ]; then
  APPLE_NOTARY_PASSWORD="$(
    security find-generic-password -a "$APPLE_ID" -s airnote-apple-app-password -w 2>/dev/null \
      || awk '
        /Known working Apple app-specific password/ {getline; gsub(/^[[:space:]]*`|`[[:space:]]*$/, ""); print; exit}
      ' "$DEPLOY_AIRNOTE_SKILL" 2>/dev/null
  )"
fi

NOTARY_MODE="profile"
if [ -n "$APPLE_ID" ] && [ -n "$APPLE_NOTARY_PASSWORD" ]; then
  NOTARY_MODE="password"
  if ! xcrun notarytool history \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_NOTARY_PASSWORD" >/dev/null 2>&1; then
    fail "Apple notarization credentials were found but Apple rejected them"
  fi
elif ! xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE" >/dev/null 2>&1; then
  fail "no valid Apple notarization credentials were found; configure '$APPLE_KEYCHAIN_PROFILE' or APPLE_APP_SPECIFIC_PASSWORD"
fi

echo "Signing identity: $APPLE_SIGNING_IDENTITY"
echo "Apple team: $APPLE_TEAM_ID"
echo "Notarization credentials: validated ($NOTARY_MODE)"

if [ "$SELECTOR" = "--preflight" ]; then
  echo "Local DMG signing/notarization preflight passed."
  exit 0
fi

VERSION="$(node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(p.version)" "$TAURI_DIR/tauri.conf.json")"
EXPECTED_BUNDLE_ID="$(node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(p.identifier)" "$TAURI_DIR/tauri.conf.json")"
[ -n "$VERSION" ] || fail "could not read the desktop version"
[ -n "$EXPECTED_BUNDLE_ID" ] || fail "could not read the desktop bundle identifier"

mkdir -p "$OUTPUT_DIR"

sign_app() {
  local app_path="$1"
  local candidate
  local main_executable

  main_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Contents/Info.plist")"

  while IFS= read -r -d '' candidate; do
    # Signing a bundle's main executable directly makes codesign validate the
    # whole bundle before its sidecars are ready. Sign every nested Mach-O
    # first, then let the final app-bundle signature cover the main executable.
    if [ "$candidate" = "$app_path/Contents/MacOS/$main_executable" ]; then
      continue
    fi
    if file -b "$candidate" | grep -q 'Mach-O'; then
      codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$candidate"
    fi
  done < <(
    find "$app_path/Contents" -type f \
      \( -perm -111 -o -name '*.dylib' -o -name '*.node' -o -name '*.so' \) \
      -print0
  )

  codesign --force --deep --options runtime --timestamp \
    --entitlements "$TAURI_DIR/Entitlements.plist" \
    --sign "$APPLE_SIGNING_IDENTITY" "$app_path"
  codesign --verify --deep --strict --verbose=2 "$app_path"
}

verify_mounted_dmg() {
  local dmg_path="$1"
  local architecture="$2"
  local mounted_app
  local mounted_bundle_id

  ACTIVE_MOUNT_POINT="$(mktemp -d "${TMPDIR:-/tmp}/divo-dmg-mount.XXXXXX")"
  hdiutil attach -readonly -nobrowse -mountpoint "$ACTIVE_MOUNT_POINT" "$dmg_path" >/dev/null
  mounted_app="$ACTIVE_MOUNT_POINT/Divo Dex.app"
  [ -d "$mounted_app" ] || fail "Divo Dex.app is missing from $dmg_path"

  mounted_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$mounted_app/Contents/Info.plist")"
  [ "$mounted_bundle_id" = "$EXPECTED_BUNDLE_ID" ] \
    || fail "unexpected bundle identifier '$mounted_bundle_id' in $dmg_path"

  codesign --verify --deep --strict --verbose=2 "$mounted_app"
  "$SCRIPT_DIR/verify-macos-architecture.sh" "$mounted_app" "$architecture"

  hdiutil detach "$ACTIVE_MOUNT_POINT" >/dev/null
  rmdir "$ACTIVE_MOUNT_POINT"
  ACTIVE_MOUNT_POINT=""
}

notarize_dmg() {
  local dmg_path="$1"
  local notary_output
  local notary_status

  set +e
  if [ "$NOTARY_MODE" = "password" ]; then
    notary_output="$(xcrun notarytool submit "$dmg_path" \
      --apple-id "$APPLE_ID" \
      --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_NOTARY_PASSWORD" \
      --timeout "$NOTARY_TIMEOUT" \
      --wait 2>&1)"
    notary_status=$?
  else
    notary_output="$(xcrun notarytool submit "$dmg_path" \
      --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
      --timeout "$NOTARY_TIMEOUT" \
      --wait 2>&1)"
    notary_status=$?
  fi
  set -e

  printf '%s\n' "$notary_output"
  [ "$notary_status" -eq 0 ] || fail "Apple notarization failed for $dmg_path"
  printf '%s\n' "$notary_output" | grep -Eq 'status:[[:space:]]*Accepted' \
    || fail "Apple did not report an Accepted notarization status for $dmg_path"
}

build_target() {
  local target="$1"
  local architecture
  local verification_architecture
  local package_script
  local source_app
  local source_bundle_id
  local output_dmg
  local stage_dir
  local gatekeeper_output

  case "$target" in
    aarch64-apple-darwin)
      architecture="aarch64"
      verification_architecture="arm64"
      package_script="build:macos:aarch64"
      ;;
    x86_64-apple-darwin)
      architecture="x86_64"
      verification_architecture="x86_64"
      package_script="build:macos:x86_64"
      ;;
    *)
      fail "unsupported build target '$target'"
      ;;
  esac

  echo
  echo "==> Building Divo Dex $VERSION for $architecture"
  if [ "${DIVO_LOCAL_DMG_SKIP_BUILD:-0}" = "1" ]; then
    echo "Reusing the existing $target app bundle."
  else
    rustup target add "$target"

    (
      unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY
      unset APPLE_ID APPLE_PASSWORD APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
      unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
      cd "$JAN_DIR"
      yarn "$package_script"
    )
  fi

  source_app="$TAURI_DIR/target/$target/release/bundle/macos/Divo Dex.app"
  [ -d "$source_app" ] || fail "Tauri did not produce $source_app"

  source_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$source_app/Contents/Info.plist")"
  [ "$source_bundle_id" = "$EXPECTED_BUNDLE_ID" ] \
    || fail "unexpected bundle identifier '$source_bundle_id' in $source_app"

  "$SCRIPT_DIR/verify-macos-architecture.sh" "$source_app" "$verification_architecture"
  sign_app "$source_app"
  "$SCRIPT_DIR/verify-macos-architecture.sh" "$source_app" "$verification_architecture"

  output_dmg="$OUTPUT_DIR/Divo_Dex_${VERSION}_${architecture}.dmg"
  rm -f "$output_dmg"
  stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/divo-dmg-stage.XXXXXX")"
  ditto "$source_app" "$stage_dir/Divo Dex.app"
  ln -s /Applications "$stage_dir/Applications"

  hdiutil create \
    -volname "Divo Dex" \
    -srcfolder "$stage_dir" \
    -ov \
    -format UDZO \
    "$output_dmg"
  rm -rf "$stage_dir"

  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$output_dmg"
  codesign --verify --verbose=2 "$output_dmg"
  hdiutil verify "$output_dmg"
  verify_mounted_dmg "$output_dmg" "$verification_architecture"

  echo "==> Notarizing $(basename "$output_dmg")"
  notarize_dmg "$output_dmg"
  xcrun stapler staple "$output_dmg"
  xcrun stapler validate "$output_dmg"

  set +e
  gatekeeper_output="$(spctl --assess --type open --context context:primary-signature -v "$output_dmg" 2>&1)"
  gatekeeper_status=$?
  set -e
  printf '%s\n' "$gatekeeper_output"
  [ "$gatekeeper_status" -eq 0 ] || fail "Gatekeeper rejected $output_dmg"
  printf '%s\n' "$gatekeeper_output" | grep -Fq 'source=Notarized Developer ID' \
    || fail "Gatekeeper did not identify $output_dmg as a notarized Developer ID package"

  verify_mounted_dmg "$output_dmg" "$verification_architecture"
  shasum -a 256 "$output_dmg"
  echo "==> Finished $output_dmg"
}

for target in $TARGETS; do
  build_target "$target"
done

echo
echo "Signed and notarized Divo Dex DMGs:"
for target in $TARGETS; do
  case "$target" in
    aarch64-apple-darwin) architecture="aarch64" ;;
    x86_64-apple-darwin) architecture="x86_64" ;;
  esac
  echo "  $OUTPUT_DIR/Divo_Dex_${VERSION}_${architecture}.dmg"
done
