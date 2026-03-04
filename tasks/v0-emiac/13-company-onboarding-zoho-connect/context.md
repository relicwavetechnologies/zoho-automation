# Context

## Task
- 13 - Company Onboarding Zoho Connect

## Objective
- Ensure company onboarding includes secure Zoho integration connection and stores integration state for ingestion kickoff.

## Dependency
- 03-channel-abstraction-and-lark-adapter

## Reference Docs
- /tasks/v0-emiac/CONTEXT.md
- /tasks/v0-emiac/README.md
- /docs/EMIAC-Architecture-Planning-v3.0.md
- /docs/ARCHITECTURE-REFERENCE-MAP.md
- /docs/V0-DTO-SYNC-CONTRACT.md
- This folder: todo.md and progress.md

## Project Snapshot (Self-Contained)
- V0 must support Lark-first execution and extensible integrations.
- Company onboarding must capture integration readiness early.

## V0 Architecture Slice For This Task
- Company onboarding path can connect Zoho via integration adapter.
- Integration state must be available for asynchronous ingestion trigger.

## V0 DTO Contract Snapshot (Use Exactly)
- Existing V0 DTOs plus Zoho integration DTOs in contract file.

## DTO Focus For This Task
- ZohoConnectionDTO fields: companyId, status, connectedAt, scopes, lastSyncAt.

## State Sync Rules (No Deviation)
- Integration connect callback is idempotent.
- A company has at most one active Zoho integration record per environment.

## Additional Sync Constraints For This Task
- On successful connection, enqueue initial historical sync job asynchronously; do not block onboarding HTTP flow.

## Expected Code Touchpoints
- backend auth/company onboarding modules
- backend integrations boundary
- queue producer boundary

## Execution Steps
- Add Zoho connect endpoint/service in onboarding flow.
- Persist integration metadata.
- Trigger async initial sync job.

## Validation
- Company can connect Zoho during onboarding.
- Connect response returns quickly while sync is queued in background.

## Definition Of Done
- Zoho connection status is visible to system after onboarding.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not run full ingestion inline in the request thread.

## Anti-Hallucination Rules
- Do not invent Zoho payload fields beyond adapter contracts.
- Record assumptions in progress.md if provider fields differ.
