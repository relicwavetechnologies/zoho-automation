---
name: lark-ops
description: "Divo Lark/Feishu operations router: pick the correct native Lark tool family and act without falling back to terminal scripts."
version: 1.0.0
author: Divo
license: proprietary
metadata:
  hermes:
    tags: [Divo, Lark, Feishu, Router, Contacts, Docs, Tasks, Calendar, Messaging, Base, Approvals]
    requires_toolsets: [lark]
---

# Lark Ops

Use this skill for any Lark/Feishu workspace request in Divo Hermes.

Lark is a native tool family. Do not use terminal scripts, `lark-cli`, browser search, or legacy backend assumptions when native Lark tools are visible.

## Tool Routing

| Intent | Skill to load next | Native tool |
| --- | --- | --- |
| Find a person, resolve name/email/open id | `lark-contact-ops` | `lark_contacts` |
| Send DM/group message, reply, mention, search chat | `lark-message-ops` | `lark_messaging` |
| Create/read/edit/share Lark document | `lark-doc-ops` | `lark_doc` |
| Create/list/update/complete tasks | `lark-task-ops` | `lark_task` |
| Create/search/update meetings, free/busy | `lark-calendar-ops` | `lark_calendar` |
| Base/Bitable records | `lark-base-ops` | `lark_base` |
| Approval inbox/instances | `lark-approval-ops` | `lark_approval` |

## Operating Rules

1. If the request names a person, resolve the person before calling downstream tools unless the downstream tool accepts `*Names` directly.
2. If the request is a write action, only ask confirmation when the user has not clearly asked to do it. If they explicitly asked "send/create/update", act.
3. Never say something was sent, created, updated, or deleted unless the tool result has `success: true`.
4. Return useful IDs and URLs. For docs, always return `url` / `docUrl` when present; otherwise return `docToken`.
5. Answer in English unless the user explicitly asks for another language.
6. If a Lark tool is not visible, say the Lark toolset is unavailable for this session and name the missing native tool.

## Common Multi-Step Flows

### Create task and message owner

1. Resolve owner with `lark_contacts` if needed.
2. Create task using `lark_task` `op="create"` with `title`, optional `notes`, `dueDate`, `assigneeNames`.
3. Send message with `lark_messaging` `op="send_dm"` or reply to current chat.
4. Report task title, assignee, due date, and `taskId`.

### Create doc and attach to task/message

1. Create doc using `lark_doc` `op="create_markdown"`.
2. Use returned `url` / `docUrl` in task comment or message.
3. If only `docToken` is returned, still report it and say URL metadata was unavailable.

### Schedule meeting with people

1. Resolve attendees using `lark_contacts` or pass `attendeeNames`.
2. Use `lark_calendar` `op="create"` with ISO `startTime` and `endTime`.
3. Report title, time, attendee names, and `eventId`.
