# Scheduled Workflows Handoff

## Executive Summary

Do not integrate n8n right now.

Build a first-party `Schedule Work` feature inside the app:

1. User describes recurring work in natural language.
2. System converts that into a structured workflow spec.
3. User reviews/edits it in a visual workflow UI.
4. System compiles the workflow spec into a controlled runtime prompt.
5. User publishes it with up-front approval grants for any write-capable actions.
6. Backend scheduler loop enqueues due runs into BullMQ.
7. Each run executes through the existing Vercel runtime and tools stack.

The visual flow is the source of truth. The compiled prompt is derived output.

## Product Decisions Already Made

- No n8n integration for now.
- Add a new section called `Schedule Work`.
- User defines the work in natural language.
- User also sets frequency and time details in the UI.
- System converts the request into a workflow-style UI, likely with React Flow or similar.
- User can edit the flow visually.
- The final runtime still uses the normal thread/backend execution path.
- Scheduled workflows should support create/update/delete/edit/pause/resume cleanly.
- Scheduled write-capable workflows require approval up front at publish time.
- Normal chat can keep runtime HITL; scheduled workflows should use publish-time approval grants.
- Desktop and Lark both matter. Lark constraints must always be considered.

## Why This Architecture

This keeps a single execution engine.

Instead of:
- one runtime for chat
- another orchestration system for scheduled work

we keep:
- one runtime and tool system
- one permission model
- one audit trail
- one HITL/approval model

That reduces complexity and drift.

## Core Architecture

### Source Of Truth

Do not store only a raw prompt.

Store three layers:

1. `userIntent`
   - Original natural-language request from the user.

2. `workflowSpec`
   - Structured JSON workflow.
   - This is the true source of truth.

3. `compiledPrompt`
   - Controlled prompt generated from `workflowSpec`.
   - This is what gets sent into the normal Vercel runtime.

### Scheduling Stack

Use:
- DB as source of truth
- backend scheduler loop to find due workflows
- BullMQ to execute runs

Do not use plain cron as the main scheduler.

Reason:
- user-defined schedules are dynamic
- workflows need pause/edit/delete/resume
- duplicate prevention and retries are cleaner with DB + queue
- auditability is better

### Execution Flow

1. Workflow is published.
2. DB stores `nextRunAt`.
3. Backend scheduler loop wakes up every minute.
4. It finds due workflows.
5. It atomically claims them.
6. It enqueues BullMQ jobs.
7. Worker executes the run through the normal Vercel runtime.
8. Run result is stored and delivered to configured outputs.

### Duplicate Prevention

The scheduler loop must not enqueue the same workflow twice.

Use a claim step like:
- find due workflow rows
- atomically update a claim token / claimedAt / nextRunAt
- enqueue only successfully claimed rows

Do not rely on in-memory timing only.

## Workflow Authoring Model

### User Input

The authoring surface should collect:
- natural-language job description
- frequency
- timezone
- schedule details
- preferred output destination

Examples:
- daily at 9 AM
- weekly on Monday at 8 PM
- monthly on the 1st
- one-time on a specific date/time

### Workflow Spec

The visual flow should edit structured nodes, not prompt text.

Recommended node types:
- `read`
- `search`
- `analyze`
- `transform`
- `createDraft`
- `updateSystem`
- `send`
- `notify`
- `requireApproval`
- `branch`
- `deliver`

Each node should carry:
- step id
- title
- tool family
- action group
- required inputs
- expected output
- retry policy if needed

### Compiler

Compiler takes `workflowSpec` and produces:
- `compiledPrompt`
- `requiredTools`
- `requiredActionGroups`
- `expectedDestinations`

The compiled prompt should be very controlled and step-based.

The user should not be manually editing the final prompt directly.

## Approval Model For Scheduled Work

### Up-Front Approval

Scheduled workflows are different from ad hoc chat.

For chat:
- runtime can ask at the moment of write/update/delete/send/execute

For scheduled workflows:
- that is not enough
- approval must happen before publish

### What To Show At Publish Time

The publish review should show:
- tools the workflow may use
- action groups it may use
- systems it may modify
- delivery destinations
- whether it can create/update/delete/send/execute

Example capabilities:
- `zoho.read`
- `zoho.update`
- `books.create`
- `gmail.send`
- `drive.create`
- `larkTask.create`

### Saved Approval Grant

Save an approval grant with the workflow:
- workflow id
- approved action groups by tool
- approved by user id
- approved at
- optional expiry/re-review rules

At runtime:
- if execution stays within approved capabilities, proceed
- if runtime tries to exceed them, block

## Desktop And Lark Requirements

### Desktop

Desktop scheduled runs can:
- use full runtime surface subject to RBAC and approval grants
- include coding/workspace tools where allowed
- write results to app inbox/history

### Lark

Lark must remain constrained:
- no coding/workspace execution tools
- no local filesystem assumptions
- outputs should be explicit, not implicit

Possible scheduled destinations:
- desktop inbox only
- Lark message only
- both

Do not assume every scheduled workflow should post into Lark.

## Existing Runtime Context That Matters

The new scheduler should compile into the same runtime context system already in place.

Important files:

- Desktop context assembly:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts)
- Lark context assembly:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts)
- Department resolution:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts)
- Tool permissions/action buckets:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/vercel/tools.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/vercel/tools.ts)

The scheduler feature should not invent a parallel permission system.

It should reuse:
- department membership
- role permissions
- action-group permissions
- approval grants

## Suggested Data Model

At minimum, add entities like:

### `ScheduledWorkflow`
- `id`
- `companyId`
- `departmentId`
- `createdByUserId`
- `name`
- `status` (`draft`, `active`, `paused`, `archived`)
- `userIntent`
- `workflowSpecJson`
- `compiledPrompt`
- `timezone`
- `scheduleType`
- `scheduleConfigJson`
- `nextRunAt`
- `lastRunAt`
- `outputConfigJson`
- `approvalGrantJson`
- `createdAt`
- `updatedAt`

### `ScheduledWorkflowRun`
- `id`
- `workflowId`
- `status`
- `scheduledFor`
- `startedAt`
- `finishedAt`
- `executionThreadId` or runtime execution id
- `resultSummary`
- `errorSummary`
- `deliveryStatusJson`

### `ScheduledWorkflowClaim`
Optional if needed for safer duplicate prevention.

## Suggested UI Structure

### New Section

Add a top-level section:
- `Schedule Work`

### Page Flow

1. Workflow list
   - active
   - paused
   - draft
   - archived

2. Create workflow
   - natural-language input
   - schedule input
   - output destination input

3. Review / visualize
   - React Flow graph
   - node inspector
   - compiled prompt preview
   - tools/actions preview

4. Publish review
   - required action groups
   - affected systems
   - output destinations
   - approve and publish

5. Run history
   - last runs
   - success/failure
   - output links

### Editing

User must be able to:
- edit workflow
- duplicate workflow
- pause/resume
- delete/archive
- change schedule
- change output destination

Editing a published workflow should recompile the prompt and re-run publish-time approval checks if capabilities changed.

## Suggested Delivery Model

Allow output destinations like:
- app inbox
- desktop thread
- Lark chat
- both

Keep it explicit in the workflow config.

## What Not To Do

- Do not store only a prompt.
- Do not use plain cron as the only scheduler.
- Do not create a separate orchestration engine for scheduled work.
- Do not let scheduled workflows silently gain new write permissions after publish.
- Do not assume Lark can do what desktop can do.

## Immediate Implementation Plan

### Phase 1: Spec And Backend Contracts

1. Define Prisma schema for scheduled workflows and runs.
2. Define workflow JSON schema.
3. Define compiled prompt contract.
4. Define approval grant contract.

### Phase 2: Scheduler Core

1. Add scheduler service in backend.
2. Add due-workflow finder + atomic claim logic.
3. Enqueue BullMQ jobs.
4. Add worker execution path into the current Vercel backend.

### Phase 3: Authoring UI

1. Add `Schedule Work` section.
2. Add NL input + schedule form.
3. Add workflow graph view/editor.
4. Add compiled prompt preview.

### Phase 4: Publish Flow

1. Compute required tools + action groups.
2. Show publish review.
3. Save approval grants.
4. Activate workflow.

### Phase 5: Delivery And Run History

1. Add output destination config.
2. Store run history.
3. Show run result cards.
4. Add pause/resume/edit/delete UX.

## Open Questions That Need Product Confirmation

1. Should monthly schedules support:
   - exact date only
   - weekday patterns too

2. Should one workflow be allowed to send both:
   - desktop output
   - Lark output

3. Should high-risk scheduled actions still require per-run approval even after publish approval?

4. Should editing a live workflow pause it automatically until re-approved?

## Recommendation On Those Open Questions

- Monthly schedules:
  - start simple with exact date/time patterns
- Output:
  - allow one or many explicit destinations
- High-risk actions:
  - keep publish-time approval first
  - optionally require re-approval later for the highest-risk categories
- Editing live workflows:
  - if capabilities change, require re-approval before next active run

## Exact Guidance For The Next Engineer

If you are implementing this next, start here:

1. Add DB entities for scheduled workflows and workflow runs.
2. Build the workflow JSON schema before touching React Flow.
3. Build the compiler from workflow JSON to runtime prompt.
4. Build the scheduler loop with DB-claim semantics.
5. Enqueue BullMQ jobs into the existing runtime path.
6. Only after backend contracts are clear, build the authoring UI.

Do not start with the graph UI first. The spec and compiler need to exist first.
