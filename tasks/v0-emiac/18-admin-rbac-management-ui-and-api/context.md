# Context

## Task
- 18 - Admin RBAC Management UI And API

## Objective
- Implement dynamic RBAC management backend endpoints and dashboard pages for super-admin/company-admin control.

## Dependency
- 16-admin-auth-backend-foundation, 17-react-admin-dashboard-foundation

## Reference Docs
- /tasks/v0-emiac/CONTEXT.md
- /tasks/v0-emiac/README.md
- /docs/EMIAC-Architecture-Planning-v3.0.md
- /docs/ARCHITECTURE-REFERENCE-MAP.md
- /docs/V0-DTO-SYNC-CONTRACT.md
- This folder: todo.md and progress.md

## Project Snapshot (Self-Contained)
- RBAC control must be dynamic and admin-editable.
- Dashboard is the UI control plane; backend remains source of truth.

## V0 Architecture Slice For This Task
- Add role/action/permission APIs.
- Add dashboard views for roles, permissions matrix, and role assignment.

## DTO Focus For This Task
- PermissionMatrixDTO: roleId, actionId, allowed, updatedAt, updatedBy.
- RoleAssignmentDTO: userId, companyId, roleId, assignedBy.

## State Sync Rules (No Deviation)
- Permission changes apply on next request (cache invalidation if used).
- UI updates are optimistic only with rollback on backend reject.

## Expected Code Touchpoints
- backend rbac/policy modules and APIs
- dashboard pages/components for roles and permissions

## Execution Steps
- Implement RBAC APIs and enforcement helpers.
- Build roles and permissions management screens.
- Wire assignment/revocation actions with backend checks.

## Validation
- Admin can change role permissions dynamically.
- Permission changes reflect immediately in protected actions.
- Unauthorized role edits are denied and surfaced in UI.

## Definition Of Done
- Dynamic RBAC management works end-to-end.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not implement audit analytics charts in this task.

## Anti-Hallucination Rules
- Do not assume static role matrix in frontend.
- Enforce backend-side role checks for every mutation.
