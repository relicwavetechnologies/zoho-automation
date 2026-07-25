default:
    @just --list --unsorted

# Run workspace type checks without pnpm's non-interactive package reconciliation.
# Uses each project's already-installed TypeScript binary; no extra memory is needed.
typecheck:
    cd advance-backend && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
    cd jan/web-app && ./node_modules/.bin/tsc -b

# Build, sign, notarize, staple, and verify ARM64 and Intel macOS DMGs.
# Pass aarch64 or x86_64 to build only one architecture.
local-dmg target="all":
    ./jan/scripts/build-local-dmg.sh {{target}}

# Generate the local-only Divo Tauri updater signing key and its Keychain password.
# This command never writes the private key into the repository.
setup-updater-key:
    ./jan/scripts/setup-updater-key.sh

# Build, sign, notarize, validate, and publish a versioned local desktop release.
# The channel decides which update feed the build polls and where it publishes;
# stable and dev are independent, so a dev build never sees a stable release.
# Example: just release patch stable path/to/release-notes.md
# Example: just release patch dev
release bump="patch" channel="stable" notes_file="":
    ./jan/scripts/release-local.sh {{channel}} {{bump}} {{notes_file}}
