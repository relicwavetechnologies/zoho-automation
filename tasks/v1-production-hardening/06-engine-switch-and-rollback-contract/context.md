# Engine Switch and Rollback Contract

## Why This Task Exists
Stabilize orchestration engine selection and one-cycle emergency rollback behavior with observable metadata.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
05-bullmq-runtime-safety

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Execution tests covering langgraph default, legacy selection, and fallback path.

## Manual Verification
Flip engine flags at runtime config level and verify selected engine metadata in task output.

## Exit Criteria
Engine routing is deterministic and rollback path is proven.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
