# Context

## Task
- 17 - React Admin Dashboard Foundation

## Objective
- Create a root React admin app with authenticated shell and sidebar-based layout as control hub.

## Dependency
- 16-admin-auth-backend-foundation

## Reference Docs
- /tasks/v0-emiac/CONTEXT.md
- /tasks/v0-emiac/README.md
- /docs/EMIAC-Architecture-Planning-v3.0.md
- /docs/ARCHITECTURE-REFERENCE-MAP.md
- /docs/V0-DTO-SYNC-CONTRACT.md
- This folder: todo.md and progress.md

## Project Snapshot (Self-Contained)
- Repo currently does not expose a root admin React app.
- Need a scalable layout for super-admin/company-admin operations.

## V0 Architecture Slice For This Task
- Build frontend foundation only: app shell, routing, sidebar, auth/session bootstrap.
- Keep UI modular so future channels/integrations panels are pluggable.

## DTO Focus For This Task
- AdminSessionDTO consumed by frontend auth provider.
- AdminNavItemDTO for role-aware sidebar rendering.

## State Sync Rules (No Deviation)
- Sidebar visibility must be role-driven from backend capabilities.
- Frontend auth state must refresh from backend session endpoint, not local hardcoded role.

## Expected Code Touchpoints
- root React app directory and config
- frontend auth context/provider
- layout components: sidebar, topbar, content routes

## Execution Steps
- Initialize root React app.
- Create protected layout with sidebar and role-aware nav.
- Integrate backend auth/session handshake.

## Validation
- Super-admin and company-admin can log in and land on dashboard shell.
- Unauthorized users are redirected/blocked.
- Sidebar updates by role permissions from backend response.

## Definition Of Done
- Admin dashboard shell is production-ready as extension hub.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not implement full RBAC and audit pages in this task.

## Anti-Hallucination Rules
- Do not hardcode nav and role logic without backend capability checks.
