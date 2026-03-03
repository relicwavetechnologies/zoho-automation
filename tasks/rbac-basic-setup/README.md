# Feature Pack: RBAC + Basic Org Setup

## Purpose
Build company-level onboarding, Google OAuth auth, invite-by-magic-link onboarding, RBAC controls, and permission-scoped chat safely in parallel.

## Structure
- `shared-contracts.md` (single source of truth for DTO/API contracts)
- `backend/README.md` (backend agent tasks)
- `frontend/README.md` (frontend agent tasks)

## Working Rule
1. Backend and frontend can run in parallel.
2. Neither side may change API/DTO shape without updating `shared-contracts.md`.
3. Every contract change must include version/date note in `shared-contracts.md`.

## Core Flow (Must Support)
1. Admin signs in with Google OAuth.
2. Admin creates organization/workspace.
3. Admin invites user by email.
4. System sends one-time magic link email.
5. Invitee opens link, verifies via Google OAuth, completes onboarding.
6. Invitee gets role-based app access.
