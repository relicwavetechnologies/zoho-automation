# Frontend Tasks: RBAC Core

## FE-RBAC-01 RBAC State Model
- Add client state for:
  - current roles
  - allowed tools
  - blocked tools + reason codes
  - approval-required tools
- Source data from `GET /session/capabilities`.

## FE-RBAC-02 Admin Roles UI
- Build roles management page:
  - list system/custom roles
  - create/edit custom roles
  - delete custom roles (with backend policy constraints)

## FE-RBAC-03 Permissions Matrix UI
- Build role-permission matrix per tool.
- Toggle `can_execute` and `requires_approval`.
- Show optimistic updates with rollback on failure.

## FE-RBAC-04 Member Role Assignment UI
- Show member list with assigned roles.
- Allow role assignment updates for authorized admins.
- Render forbidden errors from backend clearly.

## FE-RBAC-05 Route and Action Guards
- Admin routes guarded by role/capability.
- Tool actions guarded by capability map.
- Never expose forbidden control as active CTA.

## FE-RBAC-06 Chat Capability Rendering
- Render only allowed tools in chat controls.
- Show disabled state with reason for blocked tools.
- For approval-required tools, show explicit confirmation modal before submit.

## FE-RBAC-07 Deny and Fallback UX
- Standardize denied action UI by `reason_code`.
- Handle session drift (role changed server-side) via capability refresh.

## FE-RBAC-08 Audit Visibility Hooks
- Surface audit references in admin flows (optional link to audit page if available).

## FE-RBAC-09 Tests
- Component tests for guards and permission matrix behavior.
- E2E checks: member vs admin UI differences, blocked action messaging.

## Done Criteria
1. UI behavior strictly follows backend capability payload.
2. No privileged action path works from frontend alone.
3. Denied flows are understandable and consistent.
