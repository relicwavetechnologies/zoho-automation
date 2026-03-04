# Tasks Operating Guide

## Folder Naming

Use numbered folders for sequence and visibility:

```txt
NN-short-kebab-name
```

Example: `03-channel-abstraction-and-lark-adapter`

## Mandatory Files Per Task

Every task folder must contain:

1. `context.md`
2. `todo.md`
3. `progress.md`

Optional:
- `notes.md` for deep technical exploration.
- `handoff.md` for explicit transfer to another owner.

Task programs (for example `tasks/v0-emiac`) should also include:
- `README.md` for ordered dependency flow.
- `CONTEXT.md` for shared baseline that applies to every task in the program.

## File Responsibilities

### `context.md`
- Why this task exists.
- In-scope / out-of-scope.
- Dependencies.
- Acceptance criteria.

### `todo.md`
- Checklist of concrete work items.
- Each item must include owner and status marker.
- Status markers: `todo`, `in_progress`, `blocked`, `done`.

### `progress.md`
- Append-only session log.
- Include date/time, actor, what changed, blockers, next step.

## Update Protocol (Non-Negotiable)

1. Before coding: set task item to `in_progress` with owner.
2. After coding/testing: set item to `done` or `blocked`.
3. Every work session must append one entry in `progress.md`.
4. If blocked, log clear unblock condition.
5. If handing off, include exact next action for assignee.

## Parallel Collaboration Rules

1. One active owner per task folder.
2. Multiple contributors can work in same task only with split TODO ownership.
3. Cross-task dependencies must be recorded in both task `context.md` files.
4. Never start dependent task implementation before dependency status is explicit.

## Program Notes

1. Completed historical task programs were folded/archived from `tasks/`.
2. Use `tasks/templates` as the baseline when starting the next execution program.
3. Current architecture/runtime state is documented in:
   - `/docs/APP-STATUS-2026-03-05.md`

## Quality Gate For Task Completion

A task is complete only when all are true:

1. All `todo.md` items are `done` or explicitly deferred.
2. `progress.md` includes final summary and verification notes.
3. Acceptance criteria in `context.md` are checked against output.
