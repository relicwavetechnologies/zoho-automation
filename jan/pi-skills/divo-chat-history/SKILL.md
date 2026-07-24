---
name: divo-chat-history
description: Search and read past Divo/Pi chat sessions on this desktop. Use when the user asks about prior decisions, earlier debugging, previous chats, or "what did we do before".
---

# Past chat recall

Use the local tools — do not guess history.

1. `divo_search_chats` with a focused query and one variant:
   - `keyword` — default for names, errors, file paths
   - `recent` — "last week / recently"
   - `oldest` — "when did we first"
   - `title` — find a chat by title
   - `broad` — if keyword is too narrow
2. Pick the best hit (`threadId` + `messageId`).
3. `divo_read_chat` with that `threadId` and `aroundMessageId` for a short window.
4. Answer with citations (thread title / id). Never invent past turns.
