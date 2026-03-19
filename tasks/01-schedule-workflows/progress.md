# Progress Log

- 2026-03-19 16:00 IST — Codex
  - Created initial task folder for scheduled workflows.
  - Captured agreed architecture direction: DB as source of truth, backend scheduler loop, BullMQ for execution, existing Vercel runtime for actual runs.
  - Added comprehensive handoff in `handoff.md`.

- 2026-03-19 — Codex
  - Added Phase 1 backend contracts in code for scheduled workflows.
  - Defined Prisma entities for `ScheduledWorkflow` and `ScheduledWorkflowRun`, including claim fields for duplicate-safe scheduling.
  - Added typed workflow spec, schedule, output, approval-grant, and capability-summary schemas plus a compiler helper and contract tests.

- 2026-03-19 — Codex
  - Added the first Electron `Schedule Work` authoring surface in the desktop renderer.
  - Wired desktop navigation so the sidebar can switch between chat, schedule authoring, and settings.
  - Implemented local workflow drafts, schedule controls, destination controls, generated workflow preview, compiled-prompt preview, and publish-review state in the desktop app.
