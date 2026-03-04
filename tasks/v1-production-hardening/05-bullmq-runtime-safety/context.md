# BullMQ Runtime Safety

## Why This Task Exists
Harden queue/job configuration: job ID sanitization, retry policy, timeout behavior, and Redis connectivity handling.

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
Unit/integration tests for job ID normalization and retry boundaries.

## Manual Verification
Restart worker during active jobs and confirm safe recovery and no process crash.

## Exit Criteria
Queue runtime remains stable under malformed IDs and transient infra faults.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
