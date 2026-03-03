# RBAC Test Matrix

## OAuth + Session
- Google start redirect works.
- Callback creates/updates local user.
- Exchange token is single-use and expires.
- Session bootstrap returns user/org/membership/capabilities.

## Onboarding
- User without org gets `complete: false` on org status.
- Onboarding creates org + membership atomically.
- Protected routes reject users without org membership.

## Invites
- Create invite pending + expiry.
- Accept invite with valid token joins org.
- Expired/revoked/already-used tokens are rejected.

## RBAC
- System roles exist (`owner`, `admin`, `manager`, `member`, `viewer`).
- Custom role CRUD scoped to organization.
- Role-tool permission overrides take effect.

## Integrations
- Zoho status/connect/reconnect/disconnect flows work.
- One org/provider row enforced.

## Policy + Chat
- `GET /capabilities/bootstrap` returns allowed/blocked tools.
- `POST /policy/check` returns standardized deny reasons.
- Tool execution in stream is denied when policy blocks.

## Audit
- Invite, role/tool changes, integration changes, tool allow/deny create audit records.
- Audit query filters (`action`, `actor_user_id`, time range) work.
