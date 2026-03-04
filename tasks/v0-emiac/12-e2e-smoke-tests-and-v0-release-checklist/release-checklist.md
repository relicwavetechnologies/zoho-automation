# V0 Release Smoke Checklist

## Run Date
- March 4, 2026 (IST)

## Validation Summary

| Area | Check | Status | Evidence |
|---|---|---|---|
| Build | Backend TypeScript + Prisma generate | PASS | `pnpm -C backend build` |
| Build | Admin dashboard build | PASS | `pnpm -C admin build` |
| Lark Token Lifecycle | Token cache/refresh/retry/fallback unit tests | PASS | `pnpm -C backend test:unit:lark` (5/5 pass) |
| Admin Control Plane | End-to-end admin scenarios (Task 21 dependency) | PASS | `node backend/scripts/validate-admin-e2e.cjs` (`ok: true`) |
| Core Runtime Path | Ingress->dispatch->synthesis (orchestrator core) | PASS | `node backend/scripts/validate-v0-core-smoke.cjs` scenario 1 |
| HITL | Pending->confirmed transition and atomic re-resolve rejection | PASS | `node backend/scripts/validate-v0-core-smoke.cjs` scenario 2 |
| Retry | Bounded retry path execution | PASS | `node backend/scripts/validate-v0-core-smoke.cjs` scenario 3 |
| Cleanup | Test artifacts removed after validation | PASS | Admin E2E cleanup (`deletedUsers: 3`, `deletedCompanies: 2`), core smoke cleanup (`redisKeysDeleted: 2`) |
| Webhook Security | Unsafely configured webhook ingress rejected | PASS | `POST /webhooks/lark/events` => `Lark webhook rejected: missing_secret` |
| Webhook Signed/Tokened Ingress | Full webhook ingress-to-runtime via HTTP with configured verification | PASS | `POST /webhooks/lark/events` with configured token returned `{\"challenge\":\"smoke-challenge-123\"}` |

## Release Decision
- Decision: **GO**
- Reason: All required V0 smoke checks now pass, including verified webhook ingress challenge flow.

## Exact Unblock Condition
1. Completed: webhook verification env configured in runtime (`LARK_VERIFICATION_TOKEN`).
2. Completed: backend process serving on port `8000`.
3. Completed: verified webhook challenge flow returned success payload.

## Notes
- Admin dashboard/control-plane validation is green.
- Core HITL and retry flows are green.
- Lark outbound token lifecycle automation is implemented and unit-tested.
