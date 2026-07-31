---
name: divo-chat-history
description: Search and read this person's own earlier sessions with Divo. Use when they ask about prior decisions, earlier debugging, previous chats, or "what did we do before".
---

# Past chat recall

Use the local tools — do not guess history.

Where the two tools' own guidance differs from this skill, follow this skill: it
describes the runtime you are actually running in.

The corpus is this one person's own past sessions in this workspace — their
direct messages with Divo, and their own scheduled runs. It is a small number of
long-running sessions rather than many separate chats, so recall here is usually
finding a moment in time, not finding a different chat.

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
