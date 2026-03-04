# Zoho Historical Sync (Real Read)

## Why This Task Exists
Replace synthetic historical fetch with real paginated Zoho data reads and backoff handling.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
13-zoho-oauth-token-lifecycle-real

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Adapter tests for pagination, throttling, and transient failures.

## Manual Verification
Run historical sync and verify non-zero real records ingested for a test tenant.

## Exit Criteria
Historical ingestion uses real Zoho data.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
