# V1 Plan Extension - Tasks 24-29

## Why This Exists
Several additive hardening tasks were planned after task 23 but the task artifacts and most implementation work were reverted. This file restores the execution plan and locks the reimplementation order.

## Locked Order
1. `24-sse-progress-update-quality`
2. `25-lark-company-config-and-verification-isolation`
3. `26-lark-directory-sync-and-role-bootstrap`
4. `27-vector-visibility-personal-shared-public`
5. `28-admin-approved-vector-sharing`
6. `29-doc-upload-and-generation-limits`

## Locked Decisions
1. `24`: Stream progress only on sentence-safe boundaries, newline boundaries, max-size fallback, or inactivity timeout.
2. `25`: Lark verification config becomes company-scoped. Env remains fallback only.
3. `26`: Lark directory sync runs on connect, nightly, and manual trigger. Default role bootstrap is `COMPANY_ADMIN` for tenant admins/managers when signal exists, else `MEMBER`.
4. `27`: Keep a single Qdrant collection and add visibility payload metadata: `personal`, `shared`, `public`.
5. `28`: Personal-to-shared promotion requires admin approval and does not block normal chat while pending.
6. `29`: Doc limits are enforced centrally with stable reason codes and visible truncation notices.

## Current Revert State
1. Task artifacts `24-29` were missing.
2. SSE buffering is partially present but does not implement sentence-safe flush semantics.
3. Lark verification still depends on env-resolved credentials instead of company-scoped config.
4. Lark directory sync persistence and admin surface are incomplete or reverted.
5. Vector visibility and share-request persistence are absent from current schema/contracts.
6. Centralized doc upload/generation limit utilities are absent.

## Reimplementation Sequence
1. Restore task artifacts and keep them updated as source of truth.
2. Land schema/models first for tasks 25-29.
3. Rebuild backend runtime and APIs in task order.
4. Rebuild admin UI surfaces after backend contracts are stable.
5. Execute targeted tests per task, then rerun regression matrix.

## Acceptance Gate
This extension is complete when:
1. Task folders `24-29` each contain `context.md`, `todo.md`, and `progress.md`.
2. Code for each task is implemented additively and verified.
3. `progress.md` for each task records evidence and blockers.
