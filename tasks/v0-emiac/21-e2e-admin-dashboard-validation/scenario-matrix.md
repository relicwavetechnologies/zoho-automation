# Admin E2E Scenario Matrix

## Scope
- Validate backend-authenticated admin control-plane paths for super-admin and company-admin.
- Validate negative authorization paths are enforced server-side.
- Validate dashboard navigation capabilities are backend-driven.

## Scenarios

| ID | Scenario | Role | Expected Result | Evidence Source |
|---|---|---|---|---|
| A1 | Login as super-admin | SUPER_ADMIN | Token and session issued | `backend/scripts/validate-admin-e2e.cjs` |
| A2 | Resolve capabilities for super-admin | SUPER_ADMIN | Includes `workspaces` and control-plane routes | `backend/scripts/validate-admin-e2e.cjs` |
| A3 | Signup + login company-admin | COMPANY_ADMIN | Company-scoped session issued | `backend/scripts/validate-admin-e2e.cjs` |
| A4 | Resolve capabilities for company-admin | COMPANY_ADMIN | Excludes `workspaces`, includes scoped nav | `backend/scripts/validate-admin-e2e.cjs` |
| A5 | Company-admin attempts RBAC write | COMPANY_ADMIN | HTTP 403 forbidden | `backend/scripts/validate-admin-e2e.cjs` |
| A6 | Company-admin creates invite | COMPANY_ADMIN | Invite created successfully | `backend/scripts/validate-admin-e2e.cjs` |
| A7 | Member accepts invite | MEMBER (new) | Invite accepted and user provisioned | `backend/scripts/validate-admin-e2e.cjs` |
| A8 | Company-admin onboarding connect | COMPANY_ADMIN | Zoho connection succeeds and historical sync completes | `backend/scripts/validate-admin-e2e.cjs` |
| A9 | Super-admin updates RBAC and effects propagate | SUPER_ADMIN + COMPANY_ADMIN | Company-admin runtime route toggles 403/200 based on permission | `backend/scripts/validate-admin-e2e.cjs` |
| A10 | Cross-company access attempt by wrong company-admin | COMPANY_ADMIN | HTTP 403 scope mismatch | `backend/scripts/validate-admin-e2e.cjs` |
| A11 | Audit log query for invite + RBAC mutations | SUPER_ADMIN | Relevant audit records returned | `backend/scripts/validate-admin-e2e.cjs` |

## Run Command
```bash
node backend/scripts/validate-admin-e2e.cjs
```

## Cleanup Guarantee
- Script deletes generated users/companies and linked admin/onboarding/sync artifacts after execution.
- Script restores prior `COMPANY_ADMIN:system.controls.write` permission state.
