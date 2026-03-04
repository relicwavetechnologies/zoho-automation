# Context

## Task
- 14 - Async Historical Zoho To Vector DB

## Objective
- Ingest full historical Zoho data into vector DB asynchronously after integration connection.

## Dependency
- 13-company-onboarding-zoho-connect

## Reference Docs
- /tasks/v0-emiac/CONTEXT.md
- /tasks/v0-emiac/README.md
- /docs/EMIAC-Architecture-Planning-v3.0.md
- /docs/ARCHITECTURE-REFERENCE-MAP.md
- /docs/V0-DTO-SYNC-CONTRACT.md
- This folder: todo.md and progress.md

## Project Snapshot (Self-Contained)
- Historical backfill should not block interactive onboarding.
- Vector DB in architecture is Qdrant.

## V0 Architecture Slice For This Task
- Initial full sync runs as background ingestion job.
- Chunk/embed/upsert pipeline writes into vector DB with checkpointing.

## V0 DTO Contract Snapshot (Use Exactly)
- Existing V0 DTOs plus IngestionJobDTO and VectorUpsertDTO in contract file.

## DTO Focus For This Task
- IngestionJobDTO: jobId, companyId, source, mode, status, progress, checkpoint.
- VectorUpsertDTO: companyId, sourceType, sourceId, chunkIndex, contentHash, payload.

## State Sync Rules (No Deviation)
- Ingestion jobs are resumable via checkpoint.
- Job status transitions are append-only auditable events.

## Additional Sync Constraints For This Task
- Full sync must be async queue/worker job.
- On worker crash, resume from last checkpoint, not from zero.

## Expected Code Touchpoints
- backend queue and state boundaries
- backend integrations/zoho boundary
- backend vector ingestion boundary

## Execution Steps
- Create ingestion worker for full historical sync.
- Implement chunk/embed/upsert stages with checkpoint persistence.
- Record progress/status updates for visibility.

## Validation
- Historical data ingestion runs async.
- Job resumes correctly from checkpoint.
- Vector records are created for company scope.

## Definition Of Done
- Company historical Zoho data is backfilled to vector DB through async workflow.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not run blocking sync in onboarding HTTP call.

## Anti-Hallucination Rules
- Do not assume fixed Zoho record shapes without adapter mapping.
- Keep vector payload filter fields consistent with architecture doc.
