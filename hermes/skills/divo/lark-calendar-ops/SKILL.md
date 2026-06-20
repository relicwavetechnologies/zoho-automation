---
name: lark-calendar-ops
description: "List, create, update, delete, and check availability for Lark Calendar events."
version: 1.0.0
author: Divo
license: proprietary
metadata:
  hermes:
    tags: [Divo, Lark, Calendar, Meetings, Free Busy]
    requires_toolsets: [lark]
---

# Lark Calendar Ops

Use this skill for Lark meetings, calendar events, schedules, availability, attendees, and recurring events.

## Native Tool

Use `lark_calendar`.

Supported operations:

- `list`
- `get`
- `create`
- `create_recurring`
- `update`
- `delete`
- `free_busy`
- `list_attendees`
- `update_attendees`

## Time Rules

- Use ISO 8601 strings for `startTime`, `endTime`, `dateFrom`, and `dateTo`.
- If duration is missing, default to 30 minutes.
- Use the user's timezone when known; otherwise include timezone offset explicitly.
- Convert "today", "tomorrow", "next Monday" into concrete dates before calling the tool.

## Attendees

- Use `attendeeNames` or `names` for natural names.
- Use `attendeeIds` only when you already have raw Lark ids.
- For availability, use `op="free_busy"` before proposing time slots.

## Final Response

Report:

- event title
- start/end time
- attendees
- `eventId`
- meeting URL if returned
