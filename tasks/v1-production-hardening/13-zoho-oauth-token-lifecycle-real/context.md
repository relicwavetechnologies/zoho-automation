# Zoho OAuth Token Lifecycle (Real)

## Why This Task Exists
Replace scaffolded Zoho auth behavior with real OAuth code exchange, token refresh, and encrypted token handling.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
01-env-contract-and-bootstrap-health

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Unit tests for token exchange/refresh/expiry/retry logic.

## Manual Verification
Connect Zoho from onboarding path and verify persisted secure token metadata.

## Exit Criteria
No synthetic connection logic remains for auth lifecycle.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
