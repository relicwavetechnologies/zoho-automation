# Qdrant External Adapter

## Why This Task Exists
Implement production external Qdrant adapter path for upsert/search/delete/health and retire Prisma-only vector runtime dependency.

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
Adapter integration tests for Qdrant operations and health checks.

## Manual Verification
Validate collection creation and vector counts against real Qdrant.

## Exit Criteria
Vector storage/search runs against external Qdrant.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
