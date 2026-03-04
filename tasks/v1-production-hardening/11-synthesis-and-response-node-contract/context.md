# Synthesis and Response Node Contract

## Why This Task Exists
Guarantee synthesis schema validity and dependable channel response behavior with deterministic fallback text.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
10-agent-bridge-contract-and-retries

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Synthesis schema tests and fallback content tests.

## Manual Verification
Send sample requests and verify coherent outbound response with correlation info.

## Exit Criteria
No empty or invalid synthesis leaves the pipeline.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
