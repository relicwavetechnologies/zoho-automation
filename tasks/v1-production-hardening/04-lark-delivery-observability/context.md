# Lark Delivery Observability

## Why This Task Exists
Ensure ingress/egress logging has correlation IDs, safe redaction, and traceable request chain without noisy overlogging.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
02-lark-ingress-contract-hardening, 03-lark-security-and-idempotency-hardening

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Logger tests for redaction, sampling, and severity behavior.

## Manual Verification
Send multiple Lark messages and verify per-message traceability across logs.

## Exit Criteria
Every message has an end-to-end trace in logs with secrets redacted.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
