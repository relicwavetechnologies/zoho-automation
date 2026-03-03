# Frontend Task Track: RBAC + Basic Org Setup

## Execution Order
1. FE-01 to FE-04 (auth UX, onboarding UX, invite acceptance UX).
2. FE-05 to FE-08 (admin dashboard for members/roles/tools/integrations).
3. FE-09 to FE-10 (chat scoping, audit UX, edge-state QA).

## Tasks

### FE-01 Google OAuth Login UX
- Replace existing login/register UX with Google OAuth entry flow.
- Handle callback success/failure and load session bootstrap.
- Persist user/org/membership context for route guards.

### FE-02 Admin Organization Onboarding UX
- Build first-run organization setup screen.
- Collect/confirm admin profile + company/workspace name.
- Route users to onboarding until completion.

### FE-03 Admin Invite UX
- Add invite form in admin dashboard (email + role).
- Add invite list (pending/accepted/expired/revoked).
- Add revoke/resend actions.

### FE-04 Magic Link Acceptance UX
- Build invite acceptance route/page.
- Handle token validation states: invalid/expired/revoked/already-used.
- Continue via Google OAuth and complete profile onboarding.

### FE-05 Admin Members Page
- Members table with search/filter.
- Change role and member status actions.
- Error states for forbidden or stale data.

### FE-06 Admin Roles + Tools Pages
- Roles page (base + custom role create/edit/clone).
- Tools matrix page showing per-role tool permissions.
- Approval-required toggle UX for high-impact tools.

### FE-07 Admin Integrations Page (Zoho Global)
- Zoho integration status card.
- Connect/reconnect/disconnect controls for authorized roles.
- Health and expired-token states.

### FE-08 Route Guards + Capability Guards
- Add admin route guard by role.
- Add capability-based UI guards for chat and admin actions.
- Consume deny reason codes from backend.

### FE-09 Chat Capability-Scoped UX
- Hide/disable disallowed tool controls in chat.
- Show clear denial reason when blocked.
- Add confirmation modal for approval-required actions.

### FE-10 Audit UI + QA Hardening
- Build audit timeline view with filters.
- Validate end-to-end flows for onboarding, invite acceptance, role-based restrictions.
- Cover edge states (expired invite, revoked invite, disconnected Zoho, permission denied).

## Done Criteria
1. UI contracts match `../shared-contracts.md` exactly.
2. Frontend does not assume permissions; it reads capability payload.
3. All critical flows work without manual DB intervention.
