# Lark Identity Verification Flow

Use this flow for all inbound Lark webhook messages.

## Objective
Guarantee that only linked, authorized members can trigger orchestration via Lark direct messages or mentions.

## Pipeline
1. Verify Lark signature and replay window.
2. Check idempotency on `messageId`.
3. Extract sender `open_id`, chat context, and tenant scope.
4. Resolve identity link:
   - lookup by `(provider=lark, providerUserId=open_id, providerTenantKey)`
5. Resolve membership:
   - user + company membership must be `ACTIVE`
6. Resolve permission gate:
   - role must allow requested action category
7. If passed, queue task with `AuthenticatedActorDTO`.

## Fail-Closed Behavior
- Any missing verification step must deny execution.
- Unlinked users receive onboarding instruction response.
- Suspended/revoked users receive access denied response.
- Denied requests are audit logged with reason.

## Direct Message Requirement
For `chatType = p2p`:
- user must be linked to an ACTIVE membership
- message can be accepted even without group context
- company resolution comes from identity link tenant key mapping

## Minimal Tables Needed
- `users`
- `companies`
- `memberships`
- `identity_links`
- `invites`
- `audit_logs`

## Security Notes
- Do not trust any user identifiers from message text body.
- Use webhook sender metadata only.
- Never dispatch unverified events to queue.
