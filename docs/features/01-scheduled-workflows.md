# Feature: Scheduled Workflows

> **Status:** `in-progress`
> **Last updated:** 2026-03-19 by codex

---

## Overview

Build a first-party `Schedule Work` feature inside the app instead of integrating n8n. Users describe recurring work in natural language, review it as a visual workflow, approve any write-capable actions up front, then the system runs it on a schedule through the existing Vercel runtime and BullMQ stack.

The core design principle: **one execution engine**. Scheduled workflows compile into the same runtime context as normal chat. No parallel orchestration system, no separate permission model, no duplicate audit trail.

---

## Plan

### Phase 1: Spec & Backend Contracts ✅
- [x] Define workflow domain model: intent, spec, compiled prompt, schedule, approvals, outputs
- [x] Define workflow node types and compiler rules
- [x] Define publish-time approval grant model for scheduled writes
- [x] Add Prisma entities for `ScheduledWorkflow` and `ScheduledWorkflowRun`
- [x] Define typed workflow spec, schedule, output, approval-grant, capability-summary schemas
- [x] Add compiler helper and contract tests

### Phase 2: Scheduler Core 🔄
- [ ] Add scheduler service in backend (due-workflow finder + atomic claim logic)
- [ ] Enqueue BullMQ jobs from scheduler
- [ ] Add worker execution path into existing Vercel backend runtime
- [ ] Duplicate-safe claim: atomically update `claimedAt` / `nextRunAt` before enqueuing

### Phase 3: Authoring UI — Desktop 🔄
- [x] Add `Schedule Work` section in desktop Electron app
- [x] NL input + schedule/frequency controls
- [x] Local workflow drafts, compiled-prompt preview, publish-review state
- [ ] React Flow visual graph editor for workflow nodes

### Phase 4: Publish Flow
- [ ] Compute required tools + action groups from workflow spec
- [ ] Show publish review UI (tools, action groups, affected systems, destinations)
- [ ] Save approval grant with workflow
- [ ] Activate workflow after approval

### Phase 5: Delivery & Run History
- [ ] Output destination config (desktop inbox / Lark message / both)
- [ ] Store `ScheduledWorkflowRun` records
- [ ] Run history cards (success/failure/output links)
- [ ] Pause / resume / edit / delete / archive UX

### Out of scope (for now)
- n8n integration
- Replacing runtime HITL for normal chat
- New external scheduler infrastructure (use BullMQ + DB)

---

## Current State

<!-- AI: overwrite this entire section every session. Do not append. -->

**What is working:**
- Prisma schema entities defined for `ScheduledWorkflow` and `ScheduledWorkflowRun`
- Typed workflow spec, schedule, output, approval-grant, capability-summary schemas exist
- Compiler helper from workflow spec → `compiledPrompt` + `requiredTools` + `requiredActionGroups`
- Desktop Electron authoring surface: NL input, schedule controls, destination controls, workflow preview, compiled prompt preview, publish-review state

**What is in progress:**
- DB schema for scheduler backend loop (claim-safe `nextRunAt` / `claimedAt` fields)

**What is not started:**
- Backend scheduler loop service (finds due workflows, atomically claims them)
- BullMQ job enqueue from scheduler
- Worker execution path wiring into Vercel runtime
- React Flow visual graph editor
- Publish-review UI (Phase 4)
- Delivery + run history (Phase 5)
- Lark output for scheduled runs

**Blockers:**
- None

**Next action:**
> Implement the backend scheduler loop service.
> Start at `backend/src/company/scheduled-workflows/` (create if not exists).
> It should: query `ScheduledWorkflow` where `status = active AND nextRunAt <= now()`,
> atomically claim each row (set `claimedAt = now()`, compute and write `nextRunAt`),
> then enqueue a BullMQ job per claimed workflow.
> The BullMQ worker should call into `vercel-orchestration.engine.ts` with the `compiledPrompt`.

---

## Key Decisions

| Decision | Why |
|---|---|
| No n8n integration | Keeps single execution engine, single permission model, single audit trail |
| DB as source of truth for scheduling | Dynamic user schedules can't use static cron; need pause/resume/edit/delete |
| Claim-before-enqueue pattern | Prevents duplicate runs if scheduler loop runs on multiple instances |
| Publish-time approval (not runtime HITL) | Scheduled jobs run unattended — can't pause mid-run to ask user |
| `workflowSpec` JSON is the source of truth, `compiledPrompt` is derived | Editing the spec recompiles the prompt; user never edits the prompt directly |
| Reuse existing Vercel runtime | No parallel orchestration path — scheduled runs go through the same engine as chat |
| Monthly schedules: exact date/time only | Start simple; weekday patterns can be added later |
| Allow multiple output destinations | User can send to desktop inbox, Lark, or both per workflow |
| Editing live workflow: require re-approval if capabilities change | Safety — never silently gain new write permissions after initial publish |

---

## Open Questions

- [ ] Should high-risk actions (e.g. `zoho.delete`) still require per-run approval even after publish-time approval grant?
- [ ] Should editing a live workflow auto-pause it until re-approved?

**Recommendation:** Keep publish-time approval first. Optionally require re-approval for the highest-risk action groups. Auto-pause on edit if capabilities change.

---

## Data Model Reference

### `ScheduledWorkflow`
```
id, companyId, departmentId, createdByUserId,
name, status (draft|active|paused|archived),
userIntent, workflowSpecJson, compiledPrompt,
timezone, scheduleType, scheduleConfigJson,
nextRunAt, lastRunAt, claimedAt,
outputConfigJson, approvalGrantJson,
createdAt, updatedAt
```

### `ScheduledWorkflowRun`
```
id, workflowId, status,
scheduledFor, startedAt, finishedAt,
executionThreadId, resultSummary, errorSummary,
deliveryStatusJson
```

## Key Files

| File | Role |
|---|---|
| `backend/src/company/orchestration/engine/vercel-orchestration.engine.ts` | Existing Lark runtime — scheduler worker calls into this |
| `backend/src/modules/desktop-chat/vercel-desktop.engine.ts` | Existing desktop runtime — same entry point for desktop scheduled runs |
| `backend/src/company/departments/department.service.ts` | Dept prompt/skills/RBAC resolution — reuse for scheduled runs |
| `backend/src/company/orchestration/vercel/tools.ts` | Tool + action-group permissions — reuse approval check here |

---

## Progress Log

### 2026-03-19 — codex
- Added Phase 1 backend contracts in code.
- Defined Prisma entities for `ScheduledWorkflow` and `ScheduledWorkflowRun`, including claim fields.
- Added typed workflow spec, schedule, output, approval-grant, capability-summary schemas plus compiler helper and contract tests.
- Added first Electron `Schedule Work` authoring surface in desktop renderer.
- Wired desktop sidebar navigation to switch between chat, schedule authoring, settings.
- Implemented local workflow drafts, schedule controls, destination controls, workflow preview, compiled prompt preview, publish-review state.

### 2026-03-19 16:00 IST — codex
- Created initial task folder.
- Captured architecture direction: DB as source of truth, backend scheduler loop, BullMQ, existing Vercel runtime.
- Added comprehensive handoff in `handoff.md` (see `tasks/01-schedule-workflows/handoff.md`).
