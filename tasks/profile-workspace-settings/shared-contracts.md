# Shared Contracts: Profile, Workspace, and Account Settings

## 1) Profile DTO
```json
{
  "user": {
    "id": "uuid",
    "email": "user@company.com",
    "first_name": "Abhishek",
    "last_name": "Verma",
    "avatar_url": null,
    "auth_provider": "google",
    "created_at": "ISO-8601",
    "updated_at": "ISO-8601"
  },
  "workspace": {
    "id": "uuid",
    "name": "Acme Finance",
    "slug": "acme-finance"
  },
  "membership": {
    "role_key": "manager",
    "role_name": "Manager",
    "status": "active"
  }
}
```

## 2) Update Profile Request
```json
{
  "first_name": "Abhishek",
  "last_name": "Verma",
  "avatar_url": "https://..."
}
```

## 3) Password Reset (Email)

### Request Reset
`POST /account/password/reset/request`
```json
{
  "email": "user@company.com"
}
```
Response (always generic):
```json
{
  "message": "If an account exists, a reset link has been sent."
}
```

### Confirm Reset
`POST /account/password/reset/confirm`
```json
{
  "token": "reset-token",
  "new_password": "StrongPassword123!"
}
```
Response:
```json
{
  "status": "success"
}
```

## 4) Account Security DTO
```json
{
  "auth_provider": "google",
  "password_enabled": false,
  "mfa_enabled": false,
  "last_password_change_at": null
}
```

## 5) API Surface
- `GET /me/profile`
- `PATCH /me/profile`
- `GET /me/security`
- `POST /account/password/reset/request`
- `POST /account/password/reset/confirm`

## 6) Validation Rules
1. `first_name`, `last_name`: non-empty, max 100 chars.
2. `new_password`: min 8 chars, policy checks configurable.
3. Reset tokens: one-time use, short TTL, hashed at rest.

## 7) UX/Error Codes
- `invalid_reset_token`
- `expired_reset_token`
- `password_not_supported_for_provider`
- `validation_error`

## Version Log
- 2026-03-03: Initial baseline.
