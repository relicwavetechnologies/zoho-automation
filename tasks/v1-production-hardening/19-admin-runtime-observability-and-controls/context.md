# Admin Runtime Observability and Controls

## Why This Task Exists
Expose runtime health/traces/recovery controls through backend APIs and ShadCN-based admin UI with backend authz enforcement.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
12-checkpoint-recovery-determinism, 18-retrieval-grounding-in-zoho-agent

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
API authz and response-contract tests for runtime control endpoints.

## Manual Verification
Login as company admin and verify allowed runtime controls and trace visibility.

## Exit Criteria
Company admin has practical operational visibility/control without frontend-only auth.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
