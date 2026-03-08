# Desktop Electron App V1

## Summary
This task family defines a new desktop application surface for the existing Zoho + Outreach + Lark automation system. The desktop app is a high-agency client for the current backend, not a second backend. It must reuse the existing orchestration engines, RBAC/tool-permission model, conversation memory, vector memory, Zoho/Outreach/Lark Doc integrations, and company/user scope model while introducing a new client/channel source: `desktop`.

The desktop client should feel like a serious operator workspace rather than an admin dashboard:
- dark grey / near-black visual language
- left thread rail
- central streaming chat pane
- compact, dense, Codex-like interaction model
- explicit status for auth, streaming, failures, and long-running work

## Locked Decisions
1. Desktop is a first-class client surface, not a replacement for Lark.
2. Backend remains source of truth for auth, orchestration, tenant scope, tools, memory, and integrations.
3. Desktop requests are represented explicitly as `desktop` source/context, not as Lark-emulated requests.
4. Desktop authentication uses browser-based login via `WEB_APP`, followed by a one-time desktop handoff code exchange.
5. Member authentication must be added to the web/backend stack; current admin-only login surfaces are insufficient.
6. Desktop streaming must use a dedicated backend route and event contract optimized for renderer consumption.
7. Existing Zoho, Outreach, and Lark Doc capabilities must remain server-side and be reused from desktop.
8. Personal vector memory continues to apply to desktop conversations using the same `companyId + requesterUserId` isolation model.
9. Future terminal/filesystem capabilities should be designed for later safe IPC expansion, but unrestricted local execution is out of scope for this task family.

## Current Grounded State
1. Backend already runs an Express server from `/backend/src/server.ts`.
2. Lark ingress is mounted at `/webhooks/lark/events` and already feeds orchestration with company-scoped context.
3. Orchestration already supports `mastra`, `langgraph`, and legacy paths under `/backend/src/company/orchestration`.
4. Mastra runtime routes already exist under `/backend/src/modules/mastra-runtime`, including streaming.
5. Tool permissions and AI roles already exist under `/backend/src/company/tools`.
6. Personal vector memory already exists under `/backend/src/company/integrations/vector/personal-vector-memory.service.ts`.
7. Conversation memory store already exists under `/backend/src/company/state/conversation/conversation-memory.store.ts`.
8. Lark directory sync, Lark Docs create/edit, Zoho integrations, and Outreach integrations already exist and are operational.
9. The current web app in `/admin` is still primarily admin-focused, though invite acceptance already exists for members.
10. There is currently no desktop app folder in the repo and no end-user member login flow suitable for desktop bootstrap.

## Task Order
1. `01-electron-app-shell-and-ui`
2. `02-member-auth-and-web-login-bridge`
3. `03-desktop-chat-runtime-and-streaming`
4. `04-desktop-session-memory-and-doc-workflows`

## Implementation Prompt
Use this prompt when delegating implementation of the desktop app to another agent:

```text
You are implementing a new Electron desktop app for the existing codebase at /Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr.

This product is an agentic AI system for Zoho, Outreach, and Lark automation. The backend already exists and includes:
- Express backend in /backend
- Mastra and LangGraph orchestration engines
- Lark webhook/channel flow
- Zoho read/action integrations
- Outreach publisher integration
- Lark Docs create/edit support
- personal vector memory + scoped shared/public memory
- RBAC/tool-permission system
- admin web app in /admin

Your task is to spin up a production-structured Electron desktop app that becomes a high-agency chat client for this same backend and feature set.

Non-negotiable goals:
1. Build a real Electron app, not a mock and not only a browser page.
2. Keep the backend as source of truth. Do not duplicate business logic in desktop.
3. Integrate with existing backend/orchestration/features rather than inventing a parallel backend.
4. Preserve current RBAC/tool-permission behavior.
5. Add desktop/member auth flow and member web login flow.
6. Support streaming chat from desktop with a desktop-specific request path.
7. UI should feel intentional and Codex-like: darkish greyish, dense, clean, serious, not generic dashboard UI.

Important product behavior:
- Today Lark is a main chat surface. Desktop must become another first-class surface.
- Desktop requests must be distinguishable from Lark requests.
- If Lark messages are identified by Lark webhook/channel metadata, desktop messages must be identified by an explicit desktop request route / request context / channel value.
- The same Zoho, Outreach, and Lark Doc capabilities should be available from desktop chat.
- The desktop app should support thread history and smooth streaming updates.
- Personal vector memory should continue working for desktop conversations too.

Current repo facts to use:
- Backend server entry: /backend/src/server.ts
- Express routes wired in /backend/src/loaders/express.ts
- Lark webhook route exists at /webhooks/lark/events
- Mastra runtime routes exist under /backend/src/modules/mastra-runtime
- Admin auth routes exist under /backend/src/modules/admin-auth
- Current web app is admin-focused in /admin/src/app/App.tsx
- Member invite accept page already exists, but there is not yet a proper member login flow for normal desktop users
- Lark directory sync and channel identities already exist
- Lark Docs service already exists in /backend/src/company/channels/lark/lark-docs.service.ts
- Tool registry / permissions already exist under /backend/src/company/tools
- Conversation memory store already exists under /backend/src/company/state/conversation
- Personal vector memory exists under /backend/src/company/integrations/vector/personal-vector-memory.service.ts

Implementation requirements:

A. Desktop app structure
- Create a new top-level app, e.g. /desktop or /electron-app
- Use Electron + React + TypeScript
- Use a clean main/preload/renderer split
- Safe IPC only through preload
- No direct Node access in renderer
- Add local dev scripts so desktop app can run against local backend
- Prefer a structure that is easy to package later for macOS and Windows

B. UI/UX
- Build a Codex-like chat workspace:
  - left sidebar with thread list
  - top session/header bar
  - central message pane
  - bottom composer
  - strong streaming feel
- Use dark grey/near-black palette, not glossy dashboard styling
- Keep typography calm and dense
- Avoid default template look
- Add clear states:
  - signed out
  - connecting/auth pending
  - streaming
  - failed tool/error
  - empty thread
- Prepare space for future artifacts/doc previews, even if minimal in v1

C. Auth flow
- Add member-side auth to the web app/backend
- Current web app/admin auth is not enough; normal members must be able to authenticate
- Desktop login flow must be:
  1. user clicks Sign In in desktop app
  2. app opens browser to WEB_APP
  3. user logs in there
  4. web app issues short-lived one-time desktop auth handoff
  5. desktop app exchanges that for a desktop session token
- Choose a secure, implementation-ready flow:
  - localhost callback server or custom protocol is acceptable
  - make one choice and implement it cleanly
- Reuse existing user/company/session model where possible
- Do not overload admin session tokens for desktop member sessions

D. Backend desktop runtime
- Add a new desktop chat route/controller/service path
- It must not pretend to be Lark
- Requests must carry desktop source metadata so orchestration knows this is desktop
- Reuse current orchestration service/engines internally
- Preserve:
  - tool permissions
  - AI role checks
  - company scope
  - personal vector memory behavior
- Add desktop streaming event semantics suited to renderer consumption
- Handle:
  - progress updates
  - streamed text
  - tool progress if available
  - final completion
  - explicit errors

E. Memory and threads
- Desktop app must support threads/conversations
- Persist enough backend state so a user can reopen prior desktop threads
- Personal vector memory should continue to store user and assistant turns for desktop
- Desktop thread state should also retain useful references such as created/edited Lark Docs where applicable

F. Lark/Zoho/Outreach feature reuse
- Desktop chat must be able to:
  - ask Zoho CRM questions
  - run Outreach inventory queries
  - create/edit Lark Docs
  - use the same routed agent behavior already present
- Do not rebuild these tools in desktop; call existing backend capability surfaces

G. Member web app changes
- Extend the web app so it has a member-facing login experience in addition to super admin/workspace admin
- Keep admin control-plane UX separate from member auth UX
- Do not mix member login into admin UI confusingly
- If needed, add a lightweight member auth section/route in the same app for now, but keep boundaries clean

H. Safety and future-proofing
- In this pass, do not build unrestricted local terminal/file execution into the renderer
- But structure the Electron app so future desktop-only tools can be added safely through IPC and explicit permission gating
- Add architecture seams for future:
  - terminal execution
  - file selection
  - local artifact workspace
- These future capabilities should not block the core desktop chat client

I. Testing and verification
- Add local dev scripts for:
  - backend dev
  - desktop dev
- Validate:
  - desktop launch
  - auth handoff
  - streaming chat
  - Zoho/outreach/doc flows from desktop
  - thread reload
  - failure state rendering
- Ensure build passes for backend, admin, and desktop app

Design preferences:
- Dark, grey, serious, Codex-like
- Not purple-heavy
- Not “AI slop” dashboard
- Dense but readable
- Desktop first, not browser-first styling inside a shell

Deliverables:
1. New Electron desktop app scaffolded and wired
2. Member login/auth bridge implemented
3. Backend desktop request path implemented
4. Desktop streaming chat UI implemented
5. Existing backend features usable from desktop
6. Thread/memory integration implemented
7. Clear local run instructions

Make implementation choices decisively. Do not leave architecture decisions unresolved.
```

## Acceptance Gate
This task family is complete when:
1. Desktop app launches locally against the existing backend.
2. End users can authenticate into desktop via the browser-based `WEB_APP` handoff flow.
3. Desktop chat uses a real desktop channel/runtime path with streaming.
4. Zoho, Outreach, and Lark Doc capabilities work from desktop chat under existing RBAC.
5. Desktop conversations preserve thread state and personal memory retrieval behavior.
6. The implementation is documented with clear local run and verification instructions.
