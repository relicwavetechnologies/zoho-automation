# Feature Pack: RBAC Core

## Goal
Implement full role-permission policy enforcement with explicit allow/deny decisions, approval gates, and auditability.

## Assignment Model
- Frontend agent gets:
  - `shared-contracts.md`
  - `frontend/README.md`
- Backend agent gets:
  - `shared-contracts.md`
  - `backend/README.md`

## Principles
1. Backend is source of truth for all policy decisions.
2. Frontend never assumes access; it renders from capability payload.
3. Every deny must return a machine-readable reason.
4. High-impact actions require explicit approval confirmation.
