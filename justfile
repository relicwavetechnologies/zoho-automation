default:
    @just --list --unsorted

# Build, sign, notarize, staple, and verify ARM64 and Intel macOS DMGs.
# Pass aarch64 or x86_64 to build only one architecture.
local-dmg target="all":
    ./jan/scripts/build-local-dmg.sh {{target}}
