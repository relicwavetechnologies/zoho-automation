---
name: divo-chat-history
description: Search and read this person's own earlier Divo conversations when they explicitly ask what was said, discussed, debugged, or done before.
---

# Past chat recall

Use the local tools — do not guess history.

This is historical transcript evidence, not durable knowledge. For the user's
preferences or current personal, department, or company facts, rules,
decisions, and procedures, use `divo_memory_recall`. Never use chat search as a
fallback when canonical recall is missing or unavailable. An assistant message
in an old transcript is not proof that its claim was true, approved, or saved.

Where the two tools' own guidance differs from this skill, follow this skill: it
describes the runtime you are actually running in.

The corpus is this one person's own past sessions in this workspace — their
current and earlier `/new` direct-message chats with Divo, plus their own
scheduled runs. Search across chats first; never assume the active chat contains
the history the user is referring to.

A hit may occasionally come from a group room this person was in, left over from
an older version of Divo. Read what you find before repeating it: if a hit shows
several different people talking to each other, it came from a room rather than
from this person, so do not describe it back to them as something they said.

1. `divo_search_chats` with a focused query and one variant:
   - `keyword` — default for names, errors, file paths
   - `recent` — "last week / recently"
   - `oldest` — "when did we first"
   - `broad` — if keyword is too narrow

   Do not use the `title` variant. Threads here are named by an internal
   identifier and carry no readable title, so it matches nothing.
2. Pick the best hit (`threadId` + `messageId`).
3. `divo_read_chat` with that `threadId` and `aroundMessageId` for a short window.
4. Answer citing **when** it was said, from the hit's `createdAt`. Do not cite
the thread title or id — they are internal identifiers and mean nothing to
   the person reading your answer. Never invent past turns.

If a search reports a non-empty `skippedThreads`, some history could not be
read. Say so rather than answering as though nothing was found.

These tools exist only in a direct message; in a group chat they are absent. If
someone asks about past chats there, say you can only recall that in a direct
message. Do not go looking for the transcripts by other means to answer anyway —
that history belongs to one person and a room is not that person.
