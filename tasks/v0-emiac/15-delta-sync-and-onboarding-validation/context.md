# Context

## Task
- 15 - Delta Sync And Onboarding Validation

## Objective
- Add post-backfill delta sync and verify full onboarding flow: connect Zoho, async historical backfill, continued incremental sync.

## Dependency
- 14-async-historical-zoho-to-vectordb

## Reference Docs
- /tasks/v0-emiac/CONTEXT.md
- /tasks/v0-emiac/README.md
- /docs/EMIAC-Architecture-Planning-v3.0.md
- /docs/ARCHITECTURE-REFERENCE-MAP.md
- /docs/V0-DTO-SYNC-CONTRACT.md
- This folder: todo.md and progress.md

## Project Snapshot (Self-Contained)
- Initial sync gives baseline vectors.
- Delta sync keeps vector DB fresh after onboarding.

## V0 Architecture Slice For This Task
- Webhook or scheduled delta updates re-embed changed records only.
- Validation must prove end-to-end onboarding + sync correctness.

## V0 DTO Contract Snapshot (Use Exactly)
- IngestionJobDTO and VectorUpsertDTO for sync state.
- Normalized incoming event DTO for webhook-driven delta paths.

## DTO Focus For This Task
- DeltaSyncEventDTO: source, sourceId, changedAt, companyId, operation.

## State Sync Rules (No Deviation)
- Delta processing is idempotent per source event key.
- Updated records replace prior vector entries by sourceId/contentHash semantics.

## Additional Sync Constraints For This Task
- Failures in delta sync are retried with bounded attempts and audit logs.

## Expected Code Touchpoints
- backend webhook/integration boundaries
- ingestion worker and state checkpoint boundaries
- e2e tests and docs

## Execution Steps
- Implement delta event handling path.
- Add re-embed/update delete behaviors for vector data lifecycle.
- Run onboarding + sync end-to-end validation scenarios.

## Validation
- Company onboarding with Zoho connect triggers async backfill.
- New/updated Zoho data appears in vector DB via delta path.
- Failures are observable and retried safely.

## Definition Of Done
- Onboarding-to-vector lifecycle is complete and verifiable.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not add unrelated analytics/reporting features.

## Anti-Hallucination Rules
- Do not assume delta payload fields not in provider/webhook schema.
- Keep operation enum and retry policy consistent with contract docs.
