# LangGraph Route Node Determinism

## Why This Task Exists
Enforce structured route outputs with strict fallback heuristics when model output is invalid/empty.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
06-engine-switch-and-rollback-contract

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Route parse tests for valid, invalid, and fallback outputs.

## Manual Verification
Run prompts across general/zoho_read/write_intent and verify route classification.

## Exit Criteria
Route node always resolves a valid intent.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
