default:
    @just --list --unsorted

# Run workspace type checks without pnpm's non-interactive package reconciliation.
# Uses each project's already-installed TypeScript binary; no extra memory is needed.
[doc("Type-check the backend and desktop web app")]
typecheck:
    cd advance-backend && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
    cd jan/web-app && ./node_modules/.bin/tsc -b

# Signed but NOT notarized: no Apple round trip, so this is the fast one. A DMG
# built here carries no quarantine attribute and opens normally on this Mac; on
# any other machine Gatekeeper will refuse it. Nothing is uploaded.
[doc("1. Build a macOS DMG to test on this Mac (fast, no notarization)")]
dmg target="aarch64":
    DIVO_SKIP_NOTARIZATION=1 ./jan/scripts/build-local-dmg.sh {{target}}

# Notarized and stapled, because it is downloaded on someone else's Mac. Lands
# under a testing/ URL that no updater polls: no version bump, no change to any
# channel's latest.json, so nothing already installed is affected. Builds from an
# uncommitted tree and labels the result -dirty when it does.
[doc("2. Build a macOS DMG and upload it to a link you can send (no release)")]
share target="aarch64":
    ./jan/scripts/share-dmg.sh {{target}}

# Bumps the version, builds both architectures, and rewrites the channel's
# latest.json — every installed copy on that channel will be offered this build.
# stable and dev are independent feeds, so a dev release is invisible to stable.
# Example: just release patch stable path/to/release-notes.md
# Example: just release patch dev
[doc("3. Publish a versioned release to a channel's update feed (stable or dev)")]
release bump="patch" channel="stable" notes_file="":
    ./jan/scripts/release-local.sh {{channel}} {{bump}} {{notes_file}}

# Generate the local-only Divo Tauri updater signing key and its Keychain password.
# This command never writes the private key into the repository.
[doc("One-time: generate the updater signing key (never leaves this Mac)")]
setup-updater-key:
    ./jan/scripts/setup-updater-key.sh
