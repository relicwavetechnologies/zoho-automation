# Context

## Task
- 21 - E2E Admin Dashboard Validation

## Objective
- Validate full admin control-plane flow end-to-end: auth, sidebar shell, RBAC changes, audit visibility, users/invites, and onboarding sync controls.

## Dependency
- 16-admin-auth-backend-foundation, 17-react-admin-dashboard-foundation, 18-admin-rbac-management-ui-and-api, 19-admin-audit-logs-and-system-controls, 20-company-admin-users-invites-and-onboarding-ui

## Reference Docs
- /tasks/v0-emiac/CONTEXT.md
- /tasks/v0-emiac/README.md
- /docs/EMIAC-Architecture-Planning-v3.0.md
- /docs/ARCHITECTURE-REFERENCE-MAP.md
- /docs/V0-DTO-SYNC-CONTRACT.md
- This folder: todo.md and progress.md

## Project Snapshot (Self-Contained)
- V0 now includes dashboard-driven admin operations.
- Need proof that backend and UI policies are aligned and safe.

## V0 Architecture Slice For This Task
- Execute scenario matrix for super-admin and company-admin.
- Verify role-based UX and backend authorization both enforce boundaries.

## DTO Focus For This Task
- AdminSessionDTO, PermissionMatrixDTO, AuditLogDTO, InviteDTO, ZohoConnectionDTO, IngestionJobDTO.

## State Sync Rules (No Deviation)
- Every mutation scenario must create expected audit event.
- Permission changes must alter subsequent authorization outcomes.

## Expected Code Touchpoints
- e2e test scripts/manual validation docs
- backend integration tests
- dashboard validation checklist

## Execution Steps
- Run scenario matrix:
  - super-admin login and global controls
  - company-admin login and scoped controls
  - RBAC update + effect verification
  - invite flow
  - Zoho onboarding + sync status visibility
  - audit log verification
- Record evidence and failures.

## Validation
- All critical paths pass or are logged with clear blockers.
- Security boundaries hold under negative tests.

## Definition Of Done
- Admin dashboard flow is validated and ready for release gating.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not skip negative-path authorization tests.

## Anti-Hallucination Rules
- Do not claim pass without recorded evidence for each scenario.
