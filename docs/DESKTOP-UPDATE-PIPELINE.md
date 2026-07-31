# Divo Dex desktop update pipeline

Divo Dex desktop updates are built, signed, and published from the local
release Mac. GitHub Actions is not part of this release path.

```text
Release Mac
  build + Apple code-sign/notarize ARM and Intel apps
  create Tauri-signed .app.tar.gz updater bundles
  upload versioned assets over SSH
        |
        v
VPS Nginx static host
  /desktop-updates/stable/latest.json
  /desktop-updates/stable/<version>/...
        |
        v
Divo Dex
  checks the fixed feed and verifies the Tauri signature before install
```

DMGs are retained for first-time/manual installation. In-app updates download
the matching `.app.tar.gz` bundle and verify its `.sig` using the public key
bundled into the desktop app.

## One-time VPS setup

The current `deploy` account can publish files but has no sudo. Run this once
as root on the VPS after the repository is present there:

```bash
cd /path/to/divo
sudo infra/releases/setup-vps-release-host.sh
```

It creates `/srv/divo-releases`, installs the Nginx snippet, validates Nginx,
and reloads it. It does not publish a release.

The initial feed is:

```text
https://app-dev.103.172.92.187.sslip.io/desktop-updates/stable/latest.json
```

Use a dedicated production hostname before distributing outside the internal
channel. The updater feed is intentionally fixed at build time and separate
from the user-editable backend URL.

## Local key setup

On the release Mac:

```bash
just setup-updater-key
```

The private updater key is stored at `~/.config/divo-dex/updater.key` with
permissions `0600`; its passphrase is stored in the macOS login Keychain. The
private key must never be committed or copied to the VPS. Back it up securely:
losing it prevents future updates for apps that trust its public key.

## Publishing

The tree must be clean and committed. This command bumps the Tauri app version,
builds both macOS architectures, signs/notarizes, validates, uploads to a VPS
staging directory, verifies remote checksums, and atomically replaces the feed.

```bash
just release patch stable path/to/release-notes.md
```

The command does not use GitHub Actions. After it succeeds, commit and tag the
version bump before treating the release as complete.

## Retention and rollback

Three version directories are retained by default. Do not repoint `latest.json`
to an older version: normal Tauri clients do not downgrade. Publish a newer
corrective patch instead. `latest.json` is uncacheable; versioned files are
immutable, so clients cannot see a manifest before the referenced assets exist.
