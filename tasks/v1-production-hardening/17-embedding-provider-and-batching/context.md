# Embedding Provider and Batching

## Why This Task Exists
Introduce embedding provider abstraction with OpenAI-first and deterministic fallback modes, plus batching controls.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
16-qdrant-external-adapter

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Batching/fallback/vector-shape tests for embedding service.

## Manual Verification
Run ingestion on realistic payload and verify throughput/error behavior.

## Exit Criteria
Embedding generation is stable and observable.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
