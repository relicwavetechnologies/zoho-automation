# LangSmith Tracing Redaction

## Why This Task Exists
Add optional LangSmith tracing with strict PII/secret redaction and safe metadata capture.

## In Scope
1. Implement the task objective in smallest additive increments.
2. Preserve existing compatibility contracts unless explicitly additive.
3. Add/adjust observability for new failure paths introduced by this task.

## Out of Scope
1. Unrelated refactors outside this task boundary.
2. Breaking API/type changes.
3. Changes that bypass backend authorization or runtime policy controls.

## Dependencies
19-admin-runtime-observability-and-controls

## Deliverables
1. Code and/or API updates required for this task objective.
2. Test updates covering success and failure paths.
3. Documentation updates for changed interfaces or operations.

## Automated Checks
Tracing toggle and redaction tests.

## Manual Verification
Enable tracing and verify trace emission without sensitive data leaks.

## Exit Criteria
Tracing is safe and optional for non-dev environments.

## Risks To Watch
1. Regression of Lark webhook/runtime processing.
2. Hidden failures due to incomplete error classification.
3. Increased complexity that violates simplicity constraints.
