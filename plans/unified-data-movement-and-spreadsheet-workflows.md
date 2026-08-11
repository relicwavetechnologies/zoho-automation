# Data movement and spreadsheet workflows

> Current architecture pointer, updated 2026-08-11.

The former candidate/offer/sample `dataExport` architecture is removed. Its
design and rollout history remains available in Git and must not be used as
implementation guidance.

Current Cloud-Pi data movement is:

1. Read the native source and destination skills.
2. Page the governed source through `divo-local` from one persistent Python
   file when the job contains a record set or transformation.
3. Keep provider rows in protected run files, not model context.
4. Write through the governed destination tool.
5. Read back the destination and reconcile source, written, and verified
   counts before claiming completion.

Active sources of truth:

- `plans/cloud-pi-runtime-optimization-consistency-and-proof.md`
- `plans/cloud-pi-skills-rewrite-and-db-rollout.md`
- `plans/cloud-pi-production-tool-e2e-tracker.md`
- `advance-backend/docs/cloud-pi-testing/07-local-runtime-harness-framework.md`

Google Sheet reference resolution and Drive XLSX conversion remain ordinary
Google Workspace capabilities. They are not an export-planner fallback.
