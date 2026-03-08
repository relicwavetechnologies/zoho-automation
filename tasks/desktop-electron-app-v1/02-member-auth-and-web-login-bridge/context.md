# Member Auth and Web Login Bridge

## Objective
- Add end-user member authentication and a browser-based desktop login bridge so desktop users can sign in securely through the web app and receive a desktop session without reusing admin session semantics.

## Current State
- Backend admin auth currently supports:
  - super admin login
  - company admin login
  - company admin signup
  - invite acceptance
- Web app routes are still admin-focused in `/admin/src/app/App.tsx`.
- Invite acceptance already exists, which means the repo already acknowledges non-admin members, but there is no normal member login surface or desktop-oriented session exchange.
- Current admin sessions should not be repurposed as general desktop member sessions.

## In Scope
- Add backend member authentication/session model for normal end users.
- Add member-facing login UI flow in the web app.
- Add desktop auth handoff flow:
  - desktop opens browser
  - user logs into web app
  - web app generates short-lived one-time desktop handoff code
  - desktop exchanges that code for a desktop session token
- Add desktop logout/session invalidation path.
- Add backend validation for the handoff code exchange and expiration.

## Out of Scope
- Desktop chat runtime itself.
- Lark webhook behavior changes.
- Admin auth removal or large auth-system rewrite.

## Locked Decisions
- Desktop login must use the `WEB_APP` browser flow; do not attempt password entry directly inside the desktop app as the primary login path.
- Use a one-time, short-lived handoff code rather than directly exposing long-lived auth tokens in browser redirects.
- Member auth UI must be separated from admin control-plane UI semantics even if implemented in the same frontend app for now.

## Dependencies
- Existing user, company, invite, and membership models in backend.
- Existing auth middleware patterns from `/backend/src/modules/admin-auth`.
- Existing frontend auth infrastructure in `/admin/src/auth`.

## Implementation Contract
- Add member login routes/controllers/services in backend.
- Add desktop auth exchange endpoints in backend.
- Add web routes/pages/components for member login and handoff completion.
- Choose one desktop callback strategy and implement it fully:
  - localhost callback server, or
  - custom protocol deep-link
- The chosen strategy must be documented and tested end-to-end.

## Risks
- Confusing admin and member auth scopes.
- Reusing admin tokens for desktop member auth.
- Weak handoff validation or token leakage during browser-to-desktop exchange.

## Acceptance Criteria
- [ ] Normal members can sign in through the web app without using admin routes.
- [ ] Desktop app can open the browser login flow and complete an authenticated handoff.
- [ ] Desktop sessions are scoped cleanly and are not admin-session aliases.
- [ ] Logout and expired/invalid handoff cases are handled explicitly.
- [ ] Member auth UX stays separate from admin control-plane UX.
