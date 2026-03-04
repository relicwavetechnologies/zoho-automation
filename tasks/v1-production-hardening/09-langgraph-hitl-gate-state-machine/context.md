# LangGraph HITL Gate State Machine

## Why This Task Exists
Harden pending/confirm/cancel/expire transitions and timeout handling with auditability.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
08-langgraph-plan-node-determinism

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
State-machine tests for all HITL transitions and timeout branch.

## Manual Verification
Trigger write intent, then confirm/cancel/timeout via runtime controls and verify outcomes.

## Exit Criteria
HITL flow is deterministic and auditable.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
