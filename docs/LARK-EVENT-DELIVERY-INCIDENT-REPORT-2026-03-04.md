# Lark Event Delivery Incident Report

Date: March 4, 2026
Scope: Production app `Zoho Automation` (`cli_a92d03d75538ded1`), webhook event `im.message.receive_v1`
Primary symptom: User-sent Lark messages are not consistently reaching ngrok/backend; no reliable event processing from real user messages.

## 1. Executive Summary

The backend webhook endpoint is reachable and functioning (manual POST/curl succeeds), but real user message events are not reliably delivered from Lark to the webhook pipeline. Configuration screenshots show core setup is mostly correct (published version, event subscription, tenant-token scopes, event URL configured). The remaining failure is highly likely in Lark-side event dispatch prerequisites (message context + receive scopes + app availability to test user), not in network tunnel or basic backend route availability.

A backend verifier improvement was implemented so token-only deployments are resilient even when signature headers are present. This removed one potential blocker, but the issue persisted, indicating dispatch or permissions context is still the likely root problem.

## 2. Environment and Architecture Context

### 2.1 Backend/runtime
- Repository: `/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr`
- Backend port: `8000`
- Webhook route: `POST /webhooks/lark/events`
- Event URL configured in Lark (latest shared):
  - `https://3c1d-2a09-bac5-3aeb-1a96-00-2a6-60.ngrok-free.app/webhooks/lark/events`
- ngrok forwarding (confirmed):
  - `https://3c1d-...ngrok-free.app -> http://localhost:8000`

### 2.2 Lark app details (from shared screenshots)
- App ID: `cli_a92d03d75538ded1`
- App status: `Enabled`
- Version management: `1.0.1` marked `Released`
- Event subscription:
  - `Message received v2.0`
  - event key: `im.message.receive_v1`
  - subscription type: `Tenant token`
- Permissions status shown: `Added` (not pending)

### 2.3 Relevant backend env status (previously verified)
- `LARK_APP_ID`: set
- `LARK_APP_SECRET`: set
- `LARK_VERIFICATION_TOKEN`: set
- `LARK_WEBHOOK_SIGNING_SECRET`: missing
- `LARK_BOT_TENANT_ACCESS_TOKEN`: missing (intentional; auto token mode)

## 3. What Was Verified as Working

1. ngrok tunnel is online and maps correctly to backend port 8000.
2. Manual curl/webhook tests reach the endpoint successfully.
3. At least one `200 OK` was observed on `/webhooks/lark/events` in ngrok logs.
4. App version and permission changes show as published/added in latest screenshots.
5. Backend lark token lifecycle and adapter tests pass.

Implication: base transport path (Internet -> ngrok -> backend) is valid.

## 4. What Was Failing

1. Real user message events were not consistently visible in ngrok.
2. User reported no corresponding backend processing logs from live messages.
3. At least one `401` was observed for webhook POST in ngrok during testing period.

## 5. Code-Level Behavior Relevant to This Incident

### 5.1 Webhook verifier modes
File: `backend/src/company/security/lark/lark-webhook-verifier.ts`

Verifier supports:
- Signature mode: validates `x-lark-signature` + timestamp when signing secret exists.
- Verification token mode: validates request token from body.

### 5.2 Important fix applied during incident
A fallback fix was implemented:
- If signature headers are present but `LARK_WEBHOOK_SIGNING_SECRET` is not configured, verifier now falls back to token validation instead of hard failing.
- This was validated with updated unit tests.

Build/tests after change:
- `pnpm -C backend build` passed
- `pnpm -C backend test:unit:lark` passed (10/10)

Conclusion: token-only deployments should no longer fail solely because signature headers appear.

## 6. Evidence-Based Root Cause Analysis

Given current evidence, the most likely blockers are Lark dispatch preconditions, in this order:

### 6.1 Most likely: missing DM receive scope for actual test context
Current visible scopes include:
- `im:chat`
- `im:message`
- `im:message.group_at_msg:readonly`
- `im:message:send_as_bot`

Potentially missing scope for direct-message event intake:
- `im:message.p2p_msg:readonly` (UI label varies; commonly equivalent to obtaining private messages sent to bot)

Why this matters:
- `im.message.receive_v1` delivery is context-sensitive.
- If testing was done in bot DM, missing P2P read scope can suppress event delivery.

### 6.2 Very likely: message context mismatch during testing
- Group messages may require bot presence and mention semantics.
- Sending normal group text (without @bot or without bot in group) may not emit expected callback.

### 6.3 Possible: app availability/installation scope mismatch for testing user
Even with `Released` status, app availability can still be scoped.
- If test user is outside allowed release/install scope, callbacks may never originate.

### 6.4 Lower likelihood after current evidence
- Tunnel/URL mismatch: currently less likely because shared ngrok URL and Lark event URL matched.
- Backend route failure: low likelihood because manual requests succeed.
- Signature-only rejection: mitigated by fallback patch.

## 7. Why Callback Configuration Is Not the Issue

The empty `Callback Configuration` tab is acceptable for this flow.
- Message event callbacks are configured under `Event Configuration`.
- `Callback Configuration` is for interactive card callback services.

## 8. Required Final Configuration for This Flow

### 8.1 Lark Event Configuration
- Request URL: current ngrok URL + `/webhooks/lark/events`
- Event: `im.message.receive_v1`
- Subscription type: `Tenant token`

### 8.2 Lark permissions/scopes (minimum practical)
- `im:message`
- `im:message:send_as_bot`
- `im:chat`
- `im:message.group_at_msg:readonly` (for group @bot cases)
- `im:message.p2p_msg:readonly` (for bot DM receive)

### 8.3 Backend env
- Keep token mode:
  - `LARK_VERIFICATION_TOKEN=<exact token from Encryption Strategy>`
- Signing secret can remain unset for now:
  - `LARK_WEBHOOK_SIGNING_SECRET=` (optional)

## 9. Deterministic Validation Procedure

1. Confirm backend is up on `8000` and ngrok forwarding to `8000`.
2. Confirm Lark event URL equals current ngrok URL exactly.
3. Add missing P2P receive scope if not present; publish new version.
4. Ensure test user can access/use app in same tenant.
5. Test in this order:
   1. Bot DM: send `hello`
   2. Group: `@Zoho Automation hello`
6. Observe:
   - ngrok should show POST `/webhooks/lark/events` with 200/202
   - backend should log webhook accepted and queue event
7. If no ngrok hit after DM test:
   - issue remains on Lark dispatch/access/scope side
8. If ngrok hit but 401:
   - verify token exact match in backend env and Lark encryption strategy

## 10. Logging and Observability Status

Backend logging has been upgraded for this phase:
- Structured JSON logs
- Request IDs + HTTP request logs
- Sampled success logs
- Full error logging with stack (configurable)
- Process-level unhandled exception/rejection logs

This ensures failures are visible once events reach backend.

## 11. Current Status

- Transport path: healthy
- Core app configuration: mostly healthy
- Release: healthy
- Remaining blocker: likely Lark dispatch eligibility (scope/context/user availability)

## 12. Immediate Next Action (single highest value)

Add/verify `im:message.p2p_msg:readonly`, publish, then test with direct bot DM from the intended user in the intended tenant.

If still no event appears in ngrok after that, pull one exact row from Lark Log Search (or confirm no row exists) and escalate to Lark app availability/install scope details.
