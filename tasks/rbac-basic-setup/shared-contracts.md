# Shared Contracts: RBAC + Org Setup

## Contract Governance
- Owner: Backend + Frontend leads jointly.
- Change rule: Any field addition/removal/rename must be updated here first.
- Compatibility rule: Backend must preserve old fields until frontend rollout is complete.

## Auth Model

### Primary Auth
- Provider: Google OAuth (primary and required for production flow).

### Session Bootstrap Response (example shape)
```json
{
  "user": {
    "id": "uuid",
    "email": "user@company.com",
    "first_name": "Abhishek",
    "last_name": "Verma",
    "is_email_verified": true
  },
  "organization": {
    "id": "uuid",
    "name": "Acme Finance"
  },
  "membership": {
    "role_key": "admin",
    "status": "active"
  },
  "capabilities": {
    "tools_allowed": ["zoho.clients.read", "zoho.invoices.read"],
    "tools_blocked": [
      {
        "tool": "zoho.invoice.write",
        "reason": "requires_higher_role"
      }
    ]
  }
}
```

## Invite + Magic Link Contracts

### Create Invite Request
```json
{
  "email": "member@company.com",
  "role_key": "member"
}
```

### Create Invite Response
```json
{
  "invite_id": "uuid",
  "status": "pending",
  "expires_at": "ISO-8601"
}
```

### Accept Invite Request
```json
{
  "token": "magic-link-token"
}
```

### Accept Invite Response
```json
{
  "status": "accepted",
  "organization_id": "uuid",
  "role_key": "member"
}
```

## RBAC Contracts

### Role DTO
```json
{
  "id": "uuid",
  "key": "member",
  "name": "Member",
  "is_system": true
}
```

### Tool Permission DTO
```json
{
  "tool_key": "zoho.invoices.read",
  "can_execute": true,
  "requires_approval": false
}
```

### Policy Check Response DTO
```json
{
  "allowed": false,
  "reason": "tool_not_permitted",
  "requires_approval": false
}
```

## Integration Contracts (Global Zoho)

### Integration Status DTO
```json
{
  "provider": "zoho",
  "status": "connected",
  "connected_at": "ISO-8601",
  "last_health_check_at": "ISO-8601"
}
```

## Version Log
- 2026-03-03: Initial contract baseline.

## Initial Backend API List (BE-01 Freeze)

### Session + Auth
- `GET /auth/google/start` (planned in BE-02)
- `GET /auth/google/callback` (planned in BE-02)
- `POST /auth/session/exchange` (planned in BE-02)
- `GET /session/bootstrap` (planned in BE-02; must return Session Bootstrap Response contract)

### Organization Onboarding
- `POST /org/onboarding` (planned in BE-03)
- `GET /org/status` (planned in BE-03)

### Invites
- `POST /invites` (planned in BE-04)
- `POST /invites/accept` (planned in BE-04)

### RBAC + Admin
- `GET /roles` (planned in BE-06)
- `POST /roles` (planned in BE-06)
- `PATCH /roles/:id` (planned in BE-06)
- `DELETE /roles/:id` (planned in BE-06)
- `GET /members` (planned in BE-06)
- `PATCH /members/:id` (planned in BE-06)
- `GET /tools` (planned in BE-06)
- `PATCH /roles/:roleId/tools/:toolKey` (planned in BE-06)

### Integrations (Zoho, org-global)
- `POST /integrations/zoho/connect` (planned in BE-07)
- `POST /integrations/zoho/reconnect` (planned in BE-07)
- `POST /integrations/zoho/disconnect` (planned in BE-07)
- `GET /integrations/zoho/status` (planned in BE-07)

### Capability + Policy
- `GET /capabilities/bootstrap` (planned in BE-08)
- `POST /policy/check` (planned in BE-08)

### Audit
- `GET /audit/logs` (planned in BE-09)
