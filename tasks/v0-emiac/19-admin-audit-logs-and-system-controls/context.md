# Context

## Task
- 19 - Admin Audit Logs And System Controls

## Objective
- Provide audit log visibility and high-impact system controls in admin dashboard for super-admin and company-admin.

## Dependency
- 18-admin-rbac-management-ui-and-api, 11-observability-retries-error-taxonomy

## Reference Docs
- /tasks/v0-emiac/CONTEXT.md
- /tasks/v0-emiac/README.md
- /docs/EMIAC-Architecture-Planning-v3.0.md
- /docs/ARCHITECTURE-REFERENCE-MAP.md
- /docs/V0-DTO-SYNC-CONTRACT.md
- This folder: todo.md and progress.md

## Project Snapshot (Self-Contained)
- Need traceability for auth, RBAC, invite, and critical system actions.
- Admin dashboard must surface logs and key controls safely.

## V0 Architecture Slice For This Task
- Add audit query APIs and dashboard views.
- Add admin controls for integration toggles and runtime policy switches where available.

## DTO Focus For This Task
- AuditLogDTO: actor, companyId, action, outcome, timestamp, metadata.
- AdminControlActionDTO: controlKey, requestedValue, appliedBy, appliedAt, status.

## State Sync Rules (No Deviation)
- Audit logs are append-only.
- Control actions require authorization and emit audit events regardless of outcome.

## Expected Code Touchpoints
- backend audit modules and APIs
- dashboard log viewer and controls pages

## Execution Steps
- Implement audit retrieval APIs with filters.
- Build audit log UI (filters, table, detail drawer).
- Add controlled admin actions panel with confirmations.

## Validation
- Admin can view filtered logs.
- Control actions are authorized and logged.
- Failed control actions are visible in logs and UI.

## Definition Of Done
- Audit + controls are manageable from dashboard hub.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not build long-term BI/warehouse reporting.

## Anti-Hallucination Rules
- Do not mutate or delete audit records from UI flow.
