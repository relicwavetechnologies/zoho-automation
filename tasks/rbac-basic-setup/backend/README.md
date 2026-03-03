# Backend Task Track: RBAC + Basic Org Setup

## Execution Order
1. BE-01 to BE-04 (foundation, OAuth, onboarding, invite).
2. BE-05 to BE-08 (RBAC, admin APIs, Zoho global integration, chat policy enforcement).
3. BE-09 to BE-10 (audit, migration/backfill + test hardening).

## Tasks

### BE-01 Runtime and Contract Freeze
- Lock `backend-ts` as active runtime.
- Align stream/auth assumptions with current frontend.
- Publish initial API list in `../shared-contracts.md`.
 - Status: In progress (API list published in shared contracts; runtime/auth alignment pending BE-02 integration work).

### BE-02 Google OAuth + Session
- Implement Google OAuth start/callback/exchange.
- Map OAuth identity to local user account.
- Return session bootstrap payload from shared contract.

### BE-03 Organization Onboarding
- Create organization/workspace onboarding endpoint.
- Create initial owner/admin membership in same transaction.
- Block app usage if org setup is incomplete.

### BE-04 Invite + Magic Link
- Add invite model and lifecycle (`pending`, `accepted`, `expired`, `revoked`).
- Generate one-time invite token (hashed at rest) and send email.
- Accept invite endpoint with token validation + expiry + single-use.

### BE-05 RBAC Core + Policy Engine
- Seed base roles (`owner`, `admin`, `manager`, `member`, `viewer`).
- Support custom roles per organization.
- Implement role-tool permission mapping and policy resolver.

### BE-06 Admin Control APIs
- Members APIs (list/update role/status).
- Roles APIs (list/create/update/delete custom roles).
- Tool APIs (list tools, update role-tool permissions, enable/disable tool).

### BE-07 Global Zoho Integration
- Add org-level integration storage for Zoho.
- Enforce single active Zoho integration per org.
- Implement connect/reconnect/disconnect/status endpoints.

### BE-08 Chat Capability Enforcement
- Add capability bootstrap endpoint per session.
- Enforce policy before every tool execution.
- Return standardized deny reasons for UI.

### BE-09 Audit + Security
- Record audit logs for invites, role/permission changes, integration changes, tool allow/deny.
- Add audit query endpoint with filters.
- Harden token replay prevention and org-bound authorization checks.

### BE-10 Backfill + Test Matrix
- Backfill legacy users into org/membership model.
- Add integration tests for OAuth, invite flow, RBAC matrix, Zoho integration constraints.
- Publish migration runbook and rollback notes.

## Done Criteria
1. All endpoints match `../shared-contracts.md`.
2. Cross-org access is denied across all sensitive endpoints.
3. Invite link and permission checks are covered by tests.
