# Zoho Delta Sync (Real Events)

## Why This Task Exists
Harden real delta ingestion flow with idempotency, retries, and terminal failure semantics.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
14-zoho-historical-sync-real-read

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Delta dedupe and retry/max-attempt tests.

## Manual Verification
Submit duplicate delta events and verify single effective update.

## Exit Criteria
Delta pipeline is reliable under duplicates/failures.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
