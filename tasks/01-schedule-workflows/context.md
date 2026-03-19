# Scheduled Workflows

## Why This Task Exists

We need a first-party scheduled workflow system inside the app instead of integrating n8n right now. The feature will let a user describe recurring work in natural language, review it as a visual workflow, approve any write-capable actions up front, and then run it on a schedule through the existing Vercel runtime and tools stack.

## In Scope

- New `Schedule Work` product surface.
- Natural-language workflow authoring.
- Structured workflow spec as the source of truth.
- Visual workflow editor/viewer.
- Prompt compiler that turns workflow spec into a controlled runtime prompt.
- Scheduler architecture using app backend + DB + BullMQ.
- Publish-time approval grants for scheduled write/update/delete/send/execute actions.
- Explicit desktop and Lark delivery considerations.

## Out Of Scope

- n8n integration.
- Replacing the existing ad hoc runtime-HITL flow for normal chat.
- New external scheduler infrastructure.
- Full implementation of every workflow node type.

## Dependencies

- Existing Vercel runtime for desktop:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/modules/desktop-chat/vercel-desktop.engine.ts)
- Existing Vercel runtime for Lark:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/engine/vercel-orchestration.engine.ts)
- Department prompt/skills/RBAC resolution:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/departments/department.service.ts)
- Tool exposure and action-group permissions:
  - [/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/vercel/tools.ts](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/backend/src/company/orchestration/vercel/tools.ts)

## Acceptance Criteria

1. Users can create, edit, pause, resume, and delete scheduled workflows cleanly.
2. Workflow source of truth is structured JSON, not a free-form prompt.
3. Publish step clearly shows tools, action groups, and destinations involved.
4. Up-front approval grants are captured before publish for scheduled write-capable workflows.
5. Scheduler runs in backend, reads from DB, and enqueues BullMQ jobs without duplicate firing.
6. Execution uses the existing Vercel runtime path, not a second orchestration engine.
7. Desktop and Lark delivery/output behavior is explicitly defined.
