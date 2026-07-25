# Divo Dex desktop release and update pipeline

How a macOS build of the desktop app (`jan/`, product name **Divo Dex**) is
built, signed, published to the VPS, and picked up by an installed copy.

No credentials appear in this document. The signing key never leaves the
release Mac.

## End-to-end map

```text
release Mac                                          VPS 103.172.92.187

tauri.conf.json version
    |
    +-- just release <bump> <channel>
          |
          +-- build + Developer ID sign + notarize + staple --> Divo_Dex_<v>_<arch>.dmg
          +-- tar the signed .app, minisign it -------------> Divo_Dex_<v>_<arch>.app.tar.gz(.sig)
          +-- write latest.json + SHA256SUMS
          +-- rsync to /srv/divo-releases/.staging/... then atomically promote
                                                   |
                                                   v
                              /srv/divo-releases/<channel>/<version>/
                              /srv/divo-releases/<channel>/latest.json

installed app --> polls latest.json --> verifies minisign against embedded
              pubkey --> downloads + stages --> asks the user to restart
              --> installs on restart --> relaunches
```

## Channels

Two independent channels, `stable` and `dev`. They are deliberately
**mutually exclusive**: Tauri walks the configured endpoint list and takes the
first manifest it can fetch, so listing both would let a stable build install a
dev release whenever stable had nothing newer.

`release-local.sh` therefore rewrites `plugins.updater.endpoints` to the single
channel being published, builds, and then restores the committed default
(`stable`) so a dev release leaves only the version bump in the working tree.

| Channel | Feed | Published by |
| --- | --- | --- |
| stable | `/desktop-updates/stable/latest.json` | `just release patch stable` |
| dev | `/desktop-updates/dev/latest.json` | `just release patch dev` |

A build only ever tracks the channel it was published to. To move a machine onto
the dev channel, install a dev-channel DMG once; it self-updates from the dev
feed thereafter.

## VPS layout

One-time provisioning (needs root):

```bash
./infra/releases/setup-vps-release-host.sh
```

It creates the release root owned by `deploy`, installs the Nginx snippet, and
includes it in the `app-dev` vhost:

```text
/srv/divo-releases/
├── .staging/          # uploads land here, promoted atomically
├── stable/
│   ├── latest.json
│   └── <version>/
└── dev/
    ├── latest.json
    └── <version>/
```

Nginx (`/etc/nginx/snippets/divo-desktop-updates.conf`) serves manifests with
`no-store` so an update decision is never made from a cached manifest, and
versioned artifacts as `immutable` since they never change. Directory listing is
off. Publishing runs as `deploy` over SSH keys; Nginx only needs read access.

Retention keeps the newest `DIVO_RELEASE_RETENTION` (default 3) versions per
channel.

## Publishing

Requires macOS, the Developer ID certificate, a notarization credential, and the
updater signing key.

```bash
just setup-updater-key      # one time, generates the local-only signing key
just release patch dev      # build, sign, notarize, publish to the dev channel
```

The script refuses to start unless the working tree is clean, the private key is
`0600`, and — importantly — the public key inside `tauri.conf.json` matches the
local signing key. That check is what stops you shipping an update that no
installed app can verify.

Commit the resulting version bump in `jan/src-tauri/tauri.conf.json`.

## Client behaviour

Polling (`web-app/src/providers/DataProvider.tsx`): one check shortly after
launch, deferred to browser idle so it does not compete with first paint, then
every `UPDATE_CHECK_INTERVAL_MS` (default 1 hour). Skipped in dev builds and
when the user turns off automatic update checks.

Applying (`web-app/src/hooks/useAppUpdater.ts`):

1. A newer version surfaces a prompt with the version and release notes.
2. **Update Now** downloads and *stages* the update. Models and sidecars keep
   running — the installed app is untouched, so there is no reason to interrupt
   work to fetch bytes.
3. Once staged, the prompt becomes **Update Downloaded — Restart Divo Dex to
   finish installing**. This re-surfaces even if the user previously chose
   "Remind me later".
4. **Restart Now** stops inference and sidecars first (installing swaps the app
   bundle), installs, and relaunches.
5. **Later** keeps the update staged; the next hourly check brings the prompt
   back. A failed install keeps it staged so the restart can be retried.

The staged `Update` handle lives in module scope, so a webview reload loses it.
`installPendingUpdate()` re-resolves and re-downloads in that case rather than
leaving the user on a restart that cannot proceed.

## Trust model

Three separate things, often confused:

- **Developer ID signing** — identifies the publisher to macOS.
- **Notarization + stapling** — lets Gatekeeper trust a downloaded DMG.
- **Tauri updater (minisign) signature** — authenticates an archive that may
  replace an already-installed app.

The version and URL in a manifest are *not* trusted. The app installs an archive
only if it verifies against the public key compiled into the binary. Generate one
updater key per product and never reuse another product's key: it is the
long-lived trust root for everything already installed.

## Verification

After publishing:

```bash
V=<version>
curl -fsS  https://app-dev.103.172.92.187.sslip.io/desktop-updates/dev/latest.json
curl -fsSI https://app-dev.103.172.92.187.sslip.io/desktop-updates/dev/$V/Divo_Dex_${V}_aarch64.app.tar.gz
curl -fsS  https://app-dev.103.172.92.187.sslip.io/desktop-updates/dev/$V/SHA256SUMS
```

Confirm the manifest version matches, both arch archives return 200, and the
manifest is served as `application/json` with `no-store`. Then install a
lower-versioned build and confirm it prompts, downloads, asks to restart, and
relaunches on the new version.

Read-only host checks:

```bash
ssh deploy@103.172.92.187 'ls -la /srv/divo-releases/dev/'
ssh deploy@103.172.92.187 'cat /srv/divo-releases/dev/latest.json'
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Update never appears | manifest 404, or same/lower semver | check the channel feed and the version in `latest.json` |
| Feed returns the admin UI | Nginx snippet not included in the vhost | re-run `setup-vps-release-host.sh` |
| Download succeeds, install fails | archive signed with the wrong key | confirm the `tauri.conf.json` pubkey matches the signing key; republish |
| Stable build installed a dev release | both endpoints configured | endpoints must contain exactly one channel |
| Release script aborts immediately | dirty working tree, or key permissions not `0600` | commit/stash, then `chmod 600` the key |

## Source of truth

| File | Responsibility |
| --- | --- |
| `justfile` | public release commands |
| `jan/scripts/setup-updater-key.sh` | generates the local-only signing key |
| `jan/scripts/release-local.sh` | channel endpoint, build, sign, manifest, upload, retention |
| `jan/scripts/build-local-dmg.sh` | build, sign, notarize, staple, Gatekeeper check |
| `jan/src-tauri/tauri.conf.json` | updater public key, default endpoint, app version |
| `infra/releases/setup-vps-release-host.sh` | one-time VPS provisioning |
| `infra/releases/nginx/divo-desktop-updates.conf` | feed routing and cache policy |
| `jan/web-app/src/services/updater/tauri.ts` | check, stage, install |
| `jan/web-app/src/hooks/useAppUpdater.ts` | download/restart state machine |
| `jan/web-app/src/containers/dialogs/AppUpdater.tsx` | prompt and restart UX |
