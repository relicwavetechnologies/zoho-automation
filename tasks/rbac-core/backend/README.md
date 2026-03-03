# Backend Tasks: RBAC Core

## BE-RBAC-01 Data Model
- Add tables/models:
  - `roles`
  - `role_permissions`
  - `member_roles`
- Seed system roles: `owner`, `admin`, `manager`, `member`, `viewer`.
- Add unique constraints for org-scoped role keys.

## BE-RBAC-02 Role Management APIs
- Implement role CRUD for custom roles.
- Prevent deletion of system roles unless explicit policy allows.
- Enforce org-scoped access for all role APIs.

## BE-RBAC-03 Permission Management APIs
- Implement read/update APIs for role -> tool permissions.
- Support `can_execute` + `requires_approval` fields.
- Validate tool existence before permission writes.

## BE-RBAC-04 Member Role Assignment APIs
- Implement get/set member roles.
- Enforce assigner role hierarchy (e.g., member cannot assign admin).
- Track role assignment changes in audit logs.

## BE-RBAC-05 Policy Engine Service
- Implement centralized policy resolver:
  - Input: org, user, tool, action.
  - Output: allow/deny, reason code, requires approval.
- Add standard reason codes from shared contract.

## BE-RBAC-06 Runtime Enforcement
- Integrate policy checks into tool execution path.
- Hard deny disallowed actions.
- Return structured deny payload.
- Gate approval-required actions until explicit confirmation token.

## BE-RBAC-07 Capability Bootstrap
- Implement `GET /session/capabilities` based on resolved permissions.
- Include `allowed`, `blocked`, `approval_required` arrays.

## BE-RBAC-08 Audit and Security
- Audit events for role CRUD, permission updates, member role assignments, policy denies.
- Ensure cross-org access denial on every RBAC endpoint.

## BE-RBAC-09 Tests
- Unit tests: policy resolver matrix per base role.
- Integration tests: endpoint auth, cross-org denial, approval-required behavior.

## Done Criteria
1. All RBAC endpoints follow `../shared-contracts.md`.
2. No tool executes without policy check.
3. Deny responses always include reason code.
