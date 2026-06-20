---
name: lark-contact-ops
description: "Resolve Lark company contacts by fuzzy name/email/open id before messaging, tasks, calendar, approvals, or docs."
version: 1.0.0
author: Divo
license: proprietary
metadata:
  hermes:
    tags: [Divo, Lark, Contacts, People Resolution, Identity]
    requires_toolsets: [lark]
---

# Lark Contact Ops

Use this skill when a Lark request mentions a person, email, teammate, manager, owner, assignee, attendee, or recipient.

## Native Tool

Use `lark_contacts`.

Supported operations:

- `search`
- `get`
- `lookup`
- `list_department`

## Parameter Rules

- Use `op="search"` for names, partial names, fuzzy names, emails, and natural-language people references.
- Use `op="get"` when you already have `openIds`.
- Use `op="lookup"` when the user gives a direct identifier and you need a normalized identity.
- Use `op="list_department"` only when the user asks for department members.

## Resolution Discipline

1. Prefer exact email match when an email is present.
2. For names, search with the user's exact text first.
3. If multiple plausible matches are returned, do not guess for high-impact writes. Ask the user to pick.
4. If the downstream tool accepts `assigneeNames`, `attendeeNames`, `recipientName`, `mentionNames`, use those fields when unambiguous.
5. Preserve and reuse returned `openId`, `userId`, `displayName`, and `email` in later calls.

## Failure Handling

- Contact permission error: tell the user the Lark app needs `contact:user:search` approved and Lark login refreshed.
- User-token unsupported error: retry with the default tool path if available; otherwise report the exact tool error.
- No result: say the person could not be found in the company Lark workspace and ask for email or exact name.
