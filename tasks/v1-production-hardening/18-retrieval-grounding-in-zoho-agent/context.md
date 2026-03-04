# Retrieval Grounding in Zoho Agent

## Why This Task Exists
Integrate retrieval service into zoho-read agent so responses are context-grounded from indexed vectors.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
17-embedding-provider-and-batching, 14-zoho-historical-sync-real-read

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Retrieval relevance and empty-context behavior tests.

## Manual Verification
Ask Zoho-specific questions via channel and validate grounded responses.

## Exit Criteria
Zoho agent answers are grounded in indexed data, not synthetic placeholders.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
