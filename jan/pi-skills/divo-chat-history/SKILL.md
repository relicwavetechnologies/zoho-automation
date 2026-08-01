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

1. `divo_search_chats` with a focused query and one variant:
   - `keyword` — default for names, errors, file paths
   - `recent` — "last week / recently"
   - `oldest` — "when did we first"
   - `title` — find a chat by title
   - `broad` — if keyword is too narrow
2. Pick the best hit (`threadId` + `messageId`).
3. `divo_read_chat` with that `threadId` and `aroundMessageId` for a short window.
4. Answer citing when it was said. Do not expose internal thread IDs. Never invent past turns.
