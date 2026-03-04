# Progress Log

## Entries
- Timestamp: TBD
  Actor: unassigned
  Status: not_started
  Update: Task scaffold created.
  Blockers: None yet.
  Next: Claim first TODO item and begin implementation.
- Timestamp: 2026-03-04 19:02:57 IST
  Actor: codex
  Status: in_progress
  Update: Claimed Task 04 and started tightening webhook trust boundary (signature, replay window, and atomic idempotency) before queue dispatch.
  Blockers: None.
  Next: Enforce Lark signature/replay validation against raw body and ensure duplicate requests do not mutate runtime state.
- Timestamp: 2026-03-04 19:05:08 IST
  Actor: codex
  Status: completed
  Update: Enforced webhook security gate before queue dispatch by validating Lark signature + replay window against raw request body, rejecting invalid requests with 401. Added raw body capture in Express JSON middleware. Replaced ingress idempotency claim with Redis atomic `SET NX EX` gate using TTL (`INGRESS_IDEMPOTENCY_TTL_SECONDS`) so duplicate requests are dropped without mutating runtime state.
  Blockers: None.
  Next: Start Task 21 (admin dashboard e2e validation) then finalize Task 12 release checklist.

- Timestamp: 2026-03-04 19:57:17 IST
  Actor: codex
  Status: completed
  Update: Extended webhook verification to support Lark `Verification Token` mode (from event callback payload) while preserving signature-header mode (`x-lark-signature`) for HMAC flows. Route now passes parsed body to verifier. Added verifier unit tests for token mode and signature mode.
  Blockers: Runtime env still needs either `LARK_VERIFICATION_TOKEN` (token mode) or `LARK_WEBHOOK_SIGNING_SECRET` (signature mode), then backend restart.
  Next: Set env in running backend and execute signed/tokened webhook ingress smoke check.
