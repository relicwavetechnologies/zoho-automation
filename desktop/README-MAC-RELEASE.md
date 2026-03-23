# macOS Release Guide

This app is distributed outside the Mac App Store, so you must sign and notarize it before sharing it with other Mac users.

## 1. Prerequisites

- Apple Developer Program membership
- Xcode installed on your Mac
- A `Developer ID Application` certificate installed in Keychain

Helpful references:

- https://developer.apple.com/support/developer-id/
- https://developer.apple.com/help/account/certificates/create-developer-id-certificates/
- https://www.electron.build/code-signing-mac
- https://www.electron.build/electron-builder.Interface.MacConfiguration.html

## 2. Production app URLs

Set the desktop runtime URLs in [`.env`](./.env):

```env
DIVO_BACKEND_URL=https://zoho-automation-production-f5d3.up.railway.app
DIVO_WEB_APP_URL=https://zoho-automation.vercel.app
```

These values are copied into the packaged app as `app.env`.

## 3. Choose a notarization auth method

Electron Builder supports three auth methods. Use one.

### Option A: App-specific password

Export these environment variables in your shell:

```bash
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOURTEAMID"
```

### Option B: App Store Connect API key

```bash
export APPLE_API_KEY="/absolute/path/to/AuthKey_ABC123XYZ.p8"
export APPLE_API_KEY_ID="ABC123XYZ"
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
```

### Option C: notarytool keychain profile

Store credentials once:

```bash
xcrun notarytool store-credentials "divo-notary" \
  --apple-id "your-apple-id@example.com" \
  --team-id "YOURTEAMID" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

Then export:

```bash
export APPLE_KEYCHAIN=login.keychain-db
export APPLE_KEYCHAIN_PROFILE="divo-notary"
```

## 4. Make sure signing identity is available

If your certificate is already in Keychain, Electron Builder can usually discover it automatically.

If you have multiple identities installed, set:

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
```

If you want to sign from an exported `.p12` instead:

```bash
export CSC_LINK="/absolute/path/to/developer-id-application.p12"
export CSC_KEY_PASSWORD="your-p12-password"
```

## 5. Build

Apple Silicon only:

```bash
pnpm dist:mac
```

Universal build for Apple Silicon + Intel:

```bash
pnpm dist:mac:universal
```

## 6. Verify

Check the signature:

```bash
codesign --verify --deep --strict "dist/mac-arm64/Divo Desktop.app"
```

Check Gatekeeper:

```bash
spctl -a -t exec -vv "dist/mac-arm64/Divo Desktop.app"
```

Validate the notarization ticket:

```bash
xcrun stapler validate "dist/mac-arm64/Divo Desktop.app"
```

## 7. Share

Send the notarized DMG from `dist/`.

If you built `arm64`, it only runs on Apple Silicon Macs.
If you need both Apple Silicon and Intel Macs, use the universal build.
