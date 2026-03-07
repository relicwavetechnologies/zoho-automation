# Doc Upload And Generation Limits

## Why This Task Exists
Document handling needs stable size and word-count boundaries so uploads, extraction, and generation remain predictable and operationally safe.

## Current State
1. There is no complete centralized utility for upload, extraction, and generation limits in the current source.
2. User-visible truncation and stable reason codes are not consistently enforced.

## In Scope
1. Add centralized limit utilities for upload size, extracted word count, and generated response word count.
2. Add stable reason codes for limit breaches.
3. Apply visible truncation notice behavior in generation paths.
4. Keep behavior additive and backward compatible.

## Out of Scope
1. New document parsing providers.
2. Non-document media policy.
3. Full admin configuration UI for limit values in V1.

## Dependencies
None.

## Deliverables
1. Config/env contract for doc limits.
2. Shared utility for word counting and safe trimming.
3. Enforcement in upload/extraction/generation paths.
4. Automated tests for boundary and overflow behavior.

## Exit Criteria
Doc handling respects explicit limits and reports breaches predictably.
