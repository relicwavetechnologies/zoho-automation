# Lark Ingress Contract Hardening

## Why This Task Exists
Harden webhook parsing/normalization for url_verification and event_callback payload variants without breaking existing route shape.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
00-v1-scope-and-guardrails, 01-env-contract-and-bootstrap-health

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Contract tests for accepted/rejected payload forms and schema errors.

## Manual Verification
Run curl url_verification and synthetic event callbacks against local webhook endpoint.

## Exit Criteria
Webhook accepts valid Lark payloads and rejects malformed payloads with explicit reason.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
