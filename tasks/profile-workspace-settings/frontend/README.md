# Frontend Tasks: Profile, Workspace, and Account Settings

## FE-PROF-01 Settings Information Architecture
- Add settings area and navigation sections:
  - Profile
  - Workspace
  - Security
- Ensure role-based access to workspace admin-only controls if needed.

## FE-PROF-02 Profile Page
- Build profile page using `GET /me/profile`.
- Show:
  - full name
  - email
  - workspace name
  - role label
- Add edit form for profile fields.

## FE-PROF-03 Workspace Context Panel
- Display active workspace summary.
- Show current role in workspace prominently.
- Add link to admin pages if user has admin capability.

## FE-PROF-04 Security Page
- Build security overview using `GET /me/security`.
- Show provider type and account security state.
- Conditionally show password reset CTA based on `password_enabled`/provider state.

## FE-PROF-05 Password Reset Request UX
- Build forgot/reset password request form.
- Submit to `POST /account/password/reset/request`.
- Always show generic success confirmation copy.

## FE-PROF-06 Password Reset Confirm UX
- Build reset page consuming token from URL.
- Submit new password to `POST /account/password/reset/confirm`.
- Handle states:
  - success
  - invalid token
  - expired token
  - provider not supported

## FE-PROF-07 UX Copy + Error Handling
- Map backend reason codes to clear user-facing messages.
- Avoid exposing account existence details.

## FE-PROF-08 QA Scenarios
- Google-only user sees expected security behavior.
- Password-enabled user can request and complete reset.
- Expired/reused token flows are handled gracefully.

## Done Criteria
1. Profile page clearly shows workspace and role.
2. Password reset UX is complete end-to-end.
3. UI strictly follows `../shared-contracts.md`.
