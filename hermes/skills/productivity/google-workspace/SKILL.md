---
name: google-workspace
description: "Divo-native Google Workspace: Gmail, Calendar, Drive, Docs, Sheets, and Slides through connector tools."
version: 2.0.0
author: Nous Research
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Google, Gmail, Calendar, Drive, Sheets, Docs, Slides, Email, OAuth]
    homepage: https://github.com/NousResearch/hermes-agent
    requires_toolsets: [google]
---

# Google Workspace

Use this skill to route Google Workspace requests through Divo's native connector tools. In Divo Dex, Google Workspace is a first-class integration connected from the Plugins section. Do not use terminal mail clients, `himalaya`, `gws`, or `scripts/google_api.py` for execution when the native Google tools are active.

## Native Tool Map

| User intent | Native tool | Typical operations |
| --- | --- | --- |
| Gmail, email, inbox, unread mail, drafts, reply, forward, labels | `gmail` | `profile`, `list`, `search`, `get`, `send`, `draft_create`, `draft_update`, `draft_send`, `reply`, `forward`, `labels_list`, `labels_modify` |
| Calendar, meetings, availability, Google Meet | `google_calendar` | `calendars_list`, `events_list`, `event_create`, `event_update`, `event_delete`, `free_busy`, `event_create_meet` |
| Drive files/folders, search, upload, download, export, sharing | `google_drive` | `list`, `search`, `get`, `download`, `export`, `upload`, `create`, `share`, `permissions_update` |
| Google Docs, writeups, notes, document editing | `google_docs` | `create`, `read`, `append`, `patch`, `export`, `share` |
| Google Sheets, spreadsheets, tables, ranges | `google_sheets` | `create`, `read_range`, `append_rows`, `update_range`, `batch_update`, `export`, `share` |
| Google Slides, decks, presentations | `google_slides` | `create`, `get`, `read_content`, `update_text`, `export`, `share` |

## Routing Rules

1. For Google Workspace tasks, call the matching native tool immediately when it is available.
2. Do not run terminal probes such as `which himalaya`, `himalaya --help`, `gws --help`, or `python scripts/google_api.py`.
3. Do not web-search for Google clients or setup instructions before using the native tool.
4. If the native Google tool is not visible, say the Google Workspace connector or required scope is missing and ask the user to connect or reconnect Google Workspace from Plugins.
5. If a tool returns `reconnect_required`, tell the user to connect Google Workspace in Plugins.
6. If a tool returns `scope_upgrade_required`, tell the user which scopes are missing and ask them to reconnect Google Workspace in Plugins.
7. Return created file URLs from the tool result. Docs, Sheets, Slides, Drive, and Calendar create/read/search responses should be treated as the source of truth for IDs and URLs.
8. Respond in English unless the user explicitly asks for another language.

## Safety Rules

Ask for confirmation before write actions that send, modify, share, delete, or invite:

- Sending, replying to, forwarding, or drafting email for later send.
- Creating, updating, or deleting calendar events.
- Uploading, creating, editing, deleting, sharing, or changing permissions on Drive files.
- Creating or modifying Docs, Sheets, or Slides.

For read-only requests such as "check my latest email", "find Drive files", "read this doc", "what is on my calendar", or "list upcoming events", use the tool directly without asking a setup question.

## Gmail Patterns

Use Gmail search syntax through `gmail` `search`:

- Latest inbox mail: `in:inbox`
- Unread mail: `is:unread`
- Recent mail: `newer_than:7d`
- From someone: `from:person@example.com`
- Attachments: `has:attachment`
- PDFs: `filename:pdf`

For more search operators, load `references/gmail-search-syntax.md`.

## Calendar Patterns

- List upcoming events with `google_calendar` `events_list`.
- Use ISO 8601 timestamps with timezone offsets for event creation and updates.
- Use `free_busy` before proposing meeting times when attendees are provided.
- Use `event_create_meet` when the user asks for a Google Meet link.

## Drive Patterns

- Search first when the user gives a natural-language file name.
- Use `get` after `search` when more metadata is needed.
- Prefer `export` for Google-native Docs/Sheets/Slides when the user asks to download content.
- Use sharing tools only after confirmation and include target email, role, file ID/name, and whether link access changes.

## Docs, Sheets, And Slides Patterns

- For new written documents, use `google_docs create` with the title and body text.
- For existing documents, use `read` before `append` or `patch` unless the requested target is unambiguous.
- For spreadsheets, use A1 notation ranges and prefer `append_rows` for adding rows.
- For decks, use `google_slides create` for a new presentation and `read_content` before targeted edits.

## Troubleshooting

| Tool error | Agent response |
| --- | --- |
| `reconnect_required` | "Google Workspace is not connected for this Divo user. Please connect Google Workspace from Plugins, then retry." |
| `scope_upgrade_required` | "Google Workspace is connected but missing required scopes: ... Please reconnect Google Workspace from Plugins to grant them." |
| 401 from Google | Treat as reconnect required. |
| 403 or insufficient scope | Treat as scope upgrade required. |

## Legacy Notes

The bundled CLI scripts remain in the repository for standalone Hermes compatibility and debugging only. They are not the execution path for Divo Dex when native Google tools are active.
