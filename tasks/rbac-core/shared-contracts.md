# RBAC Shared Contracts

## 1) Core Entities

### Role
```json
{
  "id": "uuid",
  "org_id": "uuid",
  "key": "admin",
  "name": "Admin",
  "is_system": true,
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

### Permission Mapping (Role -> Tool)
```json
{
  "role_id": "uuid",
  "tool_key": "zoho.invoices.read",
  "can_execute": true,
  "requires_approval": false,
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

### Member Role Assignment
```json
{
  "member_id": "uuid",
  "role_id": "uuid",
  "status": "active"
}
```

## 2) Policy Decision Contract

### Policy Check Request
```json
{
  "org_id": "uuid",
  "user_id": "uuid",
  "tool_key": "zoho.invoices.read",
  "action": "execute"
}
```

### Policy Check Response
```json
{
  "allowed": false,
  "reason_code": "tool_not_permitted",
  "reason_message": "Your role does not allow this tool.",
  "requires_approval": false
}
```

## 3) Capability Bootstrap Contract

### Capability Response
```json
{
  "roles": ["member"],
  "tools": {
    "allowed": ["zoho.clients.read", "zoho.invoices.read"],
    "blocked": [
      {
        "tool_key": "zoho.invoice.write",
        "reason_code": "requires_higher_role"
      }
    ],
    "approval_required": ["zoho.payment.refund"]
  }
}
```

## 4) Standard Reason Codes
- `tool_not_permitted`
- `role_not_assigned`
- `tool_disabled_org_level`
- `requires_higher_role`
- `approval_required`
- `not_org_member`
- `policy_conflict`

## 5) API Surface (RBAC)
- `GET /rbac/roles`
- `POST /rbac/roles`
- `PATCH /rbac/roles/:id`
- `DELETE /rbac/roles/:id`
- `GET /rbac/role-permissions?role_id=...`
- `PUT /rbac/role-permissions/:role_id`
- `GET /rbac/members/:member_id/roles`
- `PUT /rbac/members/:member_id/roles`
- `POST /rbac/policy/check`
- `GET /session/capabilities`

## 6) Versioning Rule
- Additive changes only unless both frontend and backend confirm migration plan.

## Version Log
- 2026-03-03: Initial RBAC contract baseline.
