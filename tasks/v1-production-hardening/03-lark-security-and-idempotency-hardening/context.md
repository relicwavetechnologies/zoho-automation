# Lark Security and Idempotency Hardening

## Why This Task Exists
Finalize token/signature verification behavior, replay-window controls, and duplicate-event suppression guarantees.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
02-lark-ingress-contract-hardening

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Verification mismatch tests, replay-window tests, and idempotency duplicate tests.

## Manual Verification
Send duplicate webhook events and confirm single effective task enqueue.

## Exit Criteria
No duplicate processing and clear 401/403 rejection semantics.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
