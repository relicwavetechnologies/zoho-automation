---
name: lark-workspace
description: "First-class Lark/Feishu workspace workflows using native Hermes tools for Docs, Tasks, Calendar, Messaging, Base, Contacts, and Approvals."
version: 1.0.0
author: Nous Research
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Lark, Feishu, Docs, Tasks, Calendar, Messaging, Base, Approvals]
    homepage: https://github.com/NousResearch/hermes-agent
---

# Lark Workspace

Use this skill when the user asks to create or edit Lark/Feishu docs, tasks,
calendar events, messages, Base records, contacts, or approvals.

Prefer native tools whenever they are present in the active tool schema:

- `lark_doc`
- `lark_task`
- `lark_calendar`
- `lark_messaging`
- `lark_base`
- `lark_contacts`
- `lark_approval`

Do not use terminal scripts or external skills for these actions when native
Lark tools are available. If the native Lark tools are not visible, say the
Lark connector/toolset is not active instead of pretending to complete the task.

## Routing

- Docs, pages, notes, writeups, proposals, specs: `lark_doc`
- Tasks, todos, reminders, action items: `lark_task`
- Meetings, calendar events, availability, free/busy: `lark_calendar`
- DMs, group posts, replies, mentions, message search: `lark_messaging`
- Base/bitable records: `lark_base`
- People lookup: `lark_contacts`
- Approval requests/status: `lark_approval`

## Lark Docs

For new polished documents, use `lark_doc` with `op: "create_markdown"`.
Do not create a blank document and then add one paragraph unless the user
explicitly asked for a blank document.

Recommended shape:

```json
{
  "op": "create_markdown",
  "title": "Clear Document Title",
  "markdown": "# Clear Document Title\n\n## Summary\n...\n\n## Action Items\n- ...\n\n| Area | Owner | Status |\n| --- | --- | --- |\n| ... | ... | ... |"
}
```

The tool returns:

- `docToken`
- `url` / `docUrl` resolved through Lark Drive metadata (`with_url=true`)
- `urlHint` only when Lark metadata lookup did not return a URL

Always report the document title and either the URL or the doc token. If only
`urlHint` is present, tell the user the doc was created and give the `docToken`;
also mention that Drive metadata URL lookup did not return a clickable URL.

For additions to an existing document, use `op: "append_markdown"` with the
same structured markdown style.

For precise edits:

1. Use `op: "list_blocks"` to find block IDs.
2. Use `op: "update_block"` or `op: "delete_block"` with the target block ID.

## Tasks

- Create tasks only when the user asks for a task/todo/reminder/action item.
- If no assignee is named, assign to the requester when the tool supports it.
- Due dates must be concrete. Convert relative dates into ISO-style date/time
  before calling the tool.

## Calendar

- Meetings/calls/syncs are calendar events, not tasks.
- Default duration is 30 minutes if the user did not specify one.
- Add attendees only when explicitly named.
- Use free/busy for availability questions.

## Messaging

- Send only to explicitly named people or chats.
- For named group chats, list/search chats first if the chat ID is unknown.
- Never claim a message was sent unless the tool result says success.

## Final Response

Keep the final response short and operational:

- Task: title, assignee, due date if any
- Doc: title plus `url`/`docUrl`, or `docToken` if no URL is available
- Calendar: title, date/time, attendees if any
- Failure: one sentence with the exact reason from the tool
