default:
    @just --list --unsorted

# Build, sign, notarize, staple, and verify ARM64 and Intel macOS DMGs.
# Pass aarch64 or x86_64 to build only one architecture.
local-dmg target="all":
    ./jan/scripts/build-local-dmg.sh {{target}}

# Generate the local-only Divo Tauri updater signing key and its Keychain password.
# This command never writes the private key into the repository.
setup-updater-key:
    ./jan/scripts/setup-updater-key.sh

# Build, sign, notarize, validate, and publish a versioned local desktop release.
# Example: just release patch stable path/to/release-notes.md
release bump="patch" channel="stable" notes_file="":
    ./jan/scripts/release-local.sh {{channel}} {{bump}} {{notes_file}}
