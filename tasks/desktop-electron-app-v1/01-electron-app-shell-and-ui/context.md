# Electron App Shell and UI

## Objective
- Create a new Electron desktop application shell that feels like a serious AI operator workspace and connects to the existing backend rather than embedding parallel business logic.

## Current State
- The repo currently has `/backend` and `/admin`, but no desktop app folder.
- The existing frontend UI language in `/admin` is control-plane oriented, not end-user chat oriented.
- Backend capabilities already exist for streaming orchestration, tool permissions, personal memory, Zoho, Outreach, and Lark Docs.
- There is no desktop-local IPC or windowing layer yet.

## In Scope
- New top-level Electron app folder and workspace setup.
- Main process, preload process, and renderer split.
- Local development scripts for desktop app startup.
- Codex-like chat UI shell:
  - left sidebar with threads
  - top header/session strip
  - main message pane
  - bottom composer
  - loading/empty/error states
- Safe renderer architecture with no direct Node API exposure.
- Minimal reusable state model for threads and active conversation.
- Visual direction locked to dark grey / near-black / dense / serious.

## Out of Scope
- Browser auth handoff implementation.
- Backend desktop chat route implementation.
- Deep message persistence logic.
- Terminal/filesystem execution.
- Packaging/signing/notarization beyond keeping the project structure packaging-friendly.

## Dependencies
- Existing backend API base URL and environment conventions from `/backend`.
- Existing frontend toolchain conventions in `/admin` may be reused where sensible, but the desktop UI should not inherit admin-dashboard structure.

## Design Requirements
- The desktop app must not look like a repackaged admin panel.
- It should resemble a professional chat workspace similar to Codex-style dense tooling UIs:
  - restrained dark neutrals
  - compact controls
  - high information density
  - thread-first navigation
  - strong streaming readability
- Avoid dashboard cards as the primary layout primitive for the main chat experience.

## Implementation Contract
- Create a new app folder such as `/desktop`.
- Use Electron + React + TypeScript.
- Use a preload bridge for all privileged access.
- Establish environment-driven backend URL configuration.
- Keep renderer API contracts narrow and future-safe for later desktop-only capabilities.
- Create app bootstrap scripts so local development can run the Electron app against a locally running backend.

## Risks
- Accidentally building a web-admin shell inside Electron instead of a chat-native product surface.
- Leaking Node/Electron APIs directly into the renderer.
- Tight-coupling the renderer to future auth/runtime decisions instead of keeping clean seams.

## Acceptance Criteria
- [ ] A new Electron app folder exists with clear main/preload/renderer separation.
- [ ] Local dev scripts can start the desktop app in development mode.
- [ ] The renderer shows a Codex-like chat shell with thread rail, chat pane, composer, and state placeholders.
- [ ] The renderer uses safe preload/IPC boundaries rather than direct Node integration.
- [ ] The UI language is clearly distinct from the admin control plane.
