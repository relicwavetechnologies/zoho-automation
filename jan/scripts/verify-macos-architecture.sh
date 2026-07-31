#!/usr/bin/env bash
set -euo pipefail

APP_BUNDLE=${1:?"Usage: verify-macos-architecture.sh <app-bundle> <architecture>"}
REQUIRED_ARCH=${2:?"Architecture is required (for example: x86_64)"}

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "App bundle does not exist: $APP_BUNDLE" >&2
  exit 1
fi

required_files=(bun uv sqlite-vec.dylib)
for required_file in "${required_files[@]}"; do
  if ! find "$APP_BUNDLE" -type f -name "$required_file" -print -quit | grep -q .; then
    echo "Required native component is missing: $required_file" >&2
    exit 1
  fi
done

if find "$APP_BUNDLE" -name 'mlx-server' -print -quit | grep -q .; then
  echo "Divo package must not contain the removed local MLX server" >&2
  exit 1
fi

if [[ "$REQUIRED_ARCH" == "x86_64" ]] && find "$APP_BUNDLE" -iname '*mlx-extension*' -print -quit | grep -q .; then
  echo "Intel package must not contain the Apple-Silicon-only MLX extension" >&2
  exit 1
fi

checked=0
while IFS= read -r -d '' candidate; do
  description=$(file -b "$candidate")
  if [[ "$description" != *Mach-O* ]]; then
    continue
  fi

  checked=$((checked + 1))
  if ! lipo "$candidate" -verify_arch "$REQUIRED_ARCH"; then
    echo "Native component is missing the $REQUIRED_ARCH slice: $candidate" >&2
    file "$candidate" >&2
    exit 1
  fi
done < <(
  find "$APP_BUNDLE" -type f \
    \( -perm -111 -o -name '*.dylib' -o -name '*.node' -o -name '*.so' \) \
    -print0
)

if [[ "$checked" -eq 0 ]]; then
  echo "No Mach-O files were found in $APP_BUNDLE" >&2
  exit 1
fi

echo "Verified $checked Mach-O files contain the $REQUIRED_ARCH architecture."
