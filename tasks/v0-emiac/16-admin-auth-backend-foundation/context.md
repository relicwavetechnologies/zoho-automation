# Context

## Task
- 16 - Admin Auth Backend Foundation

## Objective
- Build backend auth foundation for super-admin and company-admin access to the control plane.

## Dependency
- 13-company-onboarding-zoho-connect, 04-webhook-security-idempotency

## Reference Docs
- /tasks/v0-emiac/CONTEXT.md
- /tasks/v0-emiac/README.md
- /docs/EMIAC-Architecture-Planning-v3.0.md
- /docs/ARCHITECTURE-REFERENCE-MAP.md
- /docs/V0-DTO-SYNC-CONTRACT.md
- /docs/LARK-IDENTITY-VERIFICATION-FLOW.md
- This folder: todo.md and progress.md

## Project Snapshot (Self-Contained)
- Existing backend has user login basics but no control-plane grade admin auth.
- Admin dashboard must trust backend role and company context.

## V0 Architecture Slice For This Task
- Add super-admin and company-admin auth/session primitives.
- Role and company context must be issued from backend and enforced server-side.

## DTO Focus For This Task
- AdminSessionDTO: userId, companyId, role, sessionId, expiresAt.
- SuperAdminBootstrapDTO (one-time bootstrap path if not present).

## State Sync Rules (No Deviation)
- Only one active super-admin bootstrap creation path.
- Session claims must include role and company scope.
- Admin-only routes must validate session + role before action execution.

## Expected Code Touchpoints
- backend auth modules
- backend user/company membership persistence
- backend middleware for session/role enforcement

## Execution Steps
- Add admin auth/session services and route guards.
- Add one-time super-admin bootstrap path.
- Add company-admin authentication path tied to company membership.

## Validation
- Super-admin can authenticate and access protected admin APIs.
- Company-admin can authenticate only within assigned company scope.
- Non-admin users are denied admin routes.

## Definition Of Done
- Backend admin auth foundation is stable and reusable by React dashboard.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not build dashboard UI in this task.

## Anti-Hallucination Rules
- Do not hardcode role access only in frontend.
- Do not bypass server-side company scoping.
