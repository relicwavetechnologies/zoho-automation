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
| Webhook Signed Ingress | Full signed webhook ingress-to-runtime via HTTP | BLOCKED | Backend runtime missing `LARK_WEBHOOK_SIGNING_SECRET` at process startup, so signed-flow verification cannot be executed in current run |

## Release Decision
- Decision: **NO_GO (conditional blocker)**
- Reason: Full signed Lark webhook ingress path over HTTP is blocked by missing runtime webhook signing configuration.

## Exact Unblock Condition
1. Set `LARK_WEBHOOK_SIGNING_SECRET` in backend runtime env.
2. Restart backend process on port `8000` with that env loaded.
3. Re-run signed webhook ingress smoke check and confirm enqueue/processing path.

## Notes
- Admin dashboard/control-plane validation is green.
- Core HITL and retry flows are green.
- Lark outbound token lifecycle automation is implemented and unit-tested.
