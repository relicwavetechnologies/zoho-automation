---
name: lark-task-ops
description: "Create, list, update, complete, organize, and comment on Lark Tasks using native lark_task."
version: 1.0.0
author: Divo
license: proprietary
metadata:
  hermes:
    tags: [Divo, Lark, Tasks, Todos, Action Items]
    requires_toolsets: [lark]
---

# Lark Task Ops

Use this skill for Lark tasks, todos, reminders, action items, tasklists, subtasks, and task comments.

## Native Tool

Use `lark_task`.

Supported operations:

- `create`
- `get`
- `list`
- `listMine`
- `listOpenMine`
- `update`
- `delete`
- `complete`
- `create_subtask`
- `list_subtasks`
- `create_tasklist`
- `list_tasklists`
- `add_to_tasklist`
- `remove_from_tasklist`
- `comment`

## Creation Rules

- Required: `title`.
- Optional: `notes`, `dueDate`, `assigneeNames`, `followerIds`, `tasklistId` / `tasklist`.
- If no assignee is named, let the tool default to the requester when supported.
- Convert relative dates into concrete ISO 8601 datetimes before calling the tool.
- Use `assigneeNames` for natural person names. Do not guess raw ids.

## Task vs Calendar

- "todo", "task", "remind me", "action item" -> `lark_task`
- "meeting", "call", "sync", "calendar invite" -> `lark_calendar`

## Attach Docs

If a task needs a doc/reference:

1. Create/read the doc with `lark-doc-ops`.
2. Add the URL or doc token using `op="comment"` on the task.

## Final Response

Report:

- title
- assignee
- due date
- `taskId`
- tasklist if used
