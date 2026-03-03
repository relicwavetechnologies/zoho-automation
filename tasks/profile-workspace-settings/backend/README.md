# Backend Tasks: Profile, Workspace, and Account Settings

## BE-PROF-01 Profile Read Endpoint
- Implement `GET /me/profile`.
- Return user profile + current workspace + current role.
- Ensure org-scoped membership resolution.

## BE-PROF-02 Profile Update Endpoint
- Implement `PATCH /me/profile` with validation.
- Allow update for first name, last name, avatar URL.
- Audit profile change event.

## BE-PROF-03 Security Overview Endpoint
- Implement `GET /me/security`.
- Return provider type, password enabled flag, MFA flag, last password change timestamp.

## BE-PROF-04 Password Reset Request (Email)
- Implement `POST /account/password/reset/request`.
- Generate one-time reset token with TTL.
- Hash token at rest and send reset email link.
- Always return generic success message to avoid account enumeration.

## BE-PROF-05 Password Reset Confirm
- Implement `POST /account/password/reset/confirm`.
- Validate token, TTL, single-use constraints.
- Validate password policy and set new password hash.
- Invalidate token after use.

## BE-PROF-06 Provider Constraints
- For Google-only accounts, define policy:
  - either disallow password reset (`password_not_supported_for_provider`), or
  - allow setting local password as secondary login (if product allows).
- Keep response consistent with shared contract.

## BE-PROF-07 Email Delivery + Templates
- Add reset email template with secure URL.
- Include expiry note and security footer.
- Log delivery attempts (without sensitive token material).

## BE-PROF-08 Security Hardening
- Rate-limit reset request endpoint.
- Lock out repeated invalid token attempts.
- Enforce strong token randomness.

## BE-PROF-09 Tests
- Unit tests for validation and token lifecycle.
- Integration tests for request/confirm flow, expired/invalid/reused tokens, provider constraints.

## Done Criteria
1. Endpoints match `../shared-contracts.md`.
2. Reset flow is secure against replay and enumeration.
3. Profile response reliably includes workspace and role context.
