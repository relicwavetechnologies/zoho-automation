# Rollback Drill and Ops Runbook

## Why This Task Exists
Run emergency rollback drill (langgraph -> legacy) and finalize production operations runbook.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
22-e2e-release-gate-matrix, 06-engine-switch-and-rollback-contract

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Automated rollback verification script pass.

## Manual Verification
Perform live-like rollback drill and validate successful task execution under legacy engine.

## Exit Criteria
Rollback procedure is proven and documented.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
