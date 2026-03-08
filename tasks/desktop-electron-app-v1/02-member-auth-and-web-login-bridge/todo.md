# TODO - Member Auth and Web Login Bridge

## Work Items
- [ ] `owner: implementation-agent` - Add backend member authentication/session flows distinct from admin sessions.
- [ ] `owner: implementation-agent` - Implement one-time desktop handoff code issuance and exchange endpoints with short-lived validation.
- [ ] `owner: implementation-agent` - Add a member-facing login flow in the web app that supports desktop handoff completion.
- [ ] `owner: implementation-agent` - Wire the desktop app sign-in button to open the browser and complete the desktop session bootstrap.
- [ ] `owner: implementation-agent` - Validate login, exchange, expiration, and logout flows end-to-end.

## Deferred
- Social login / SSO variants.
- Multi-device session management beyond the required desktop session flow.
