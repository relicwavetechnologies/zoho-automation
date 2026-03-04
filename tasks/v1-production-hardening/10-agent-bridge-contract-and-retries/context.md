# Agent Bridge Contract and Retries

## Why This Task Exists
Stabilize agent invocation envelope, error classification, and bounded retry mapping.

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
Tests for unknown-agent, retriable, non-retriable, and retry-exhausted outcomes.

## Manual Verification
Force one controlled agent failure and verify retry then terminal result semantics.

## Exit Criteria
Agent failures are classified, bounded, and observable.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
