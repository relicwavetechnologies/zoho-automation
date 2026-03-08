# TODO - Electron App Shell and UI

## Work Items
- [ ] `owner: implementation-agent` - Create the new top-level Electron app workspace with Electron + React + TypeScript and a clean main/preload/renderer split.
- [ ] `owner: implementation-agent` - Add development scripts and environment plumbing so the desktop app can run locally against the existing backend.
- [ ] `owner: implementation-agent` - Build the initial Codex-like desktop shell with thread rail, header, streaming chat pane, composer, and empty/loading/error states.
- [ ] `owner: implementation-agent` - Establish safe preload APIs and renderer-side service abstractions for future auth and chat runtime integration.
- [ ] `owner: implementation-agent` - Validate the desktop app boots locally and renderer updates work in development mode.

## Deferred
- Terminal/filesystem execution bridges.
- Platform packaging/signing.
- Rich artifact preview panes beyond initial layout scaffolding.
