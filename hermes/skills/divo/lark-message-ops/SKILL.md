---
name: lark-message-ops
description: "Send, reply, DM, mention, list, and search Lark messages using native lark_messaging."
version: 1.0.0
author: Divo
license: proprietary
metadata:
  hermes:
    tags: [Divo, Lark, Messaging, DM, Chat, Reply]
    requires_toolsets: [lark]
---

# Lark Message Ops

Use this skill for Lark DMs, group messages, replies, mentions, chat listing, or message search.

## Native Tool

Use `lark_messaging`.

Supported operations:

- `send`
- `reply`
- `send_dm`
- `mention`
- `list`
- `get`
- `list_chats`
- `search`
- `listMentionsMine`

## Send Rules

- Current Lark chat: use `op="send"` and omit `chatId` when the session provides the current chat.
- Named person: use `op="send_dm"` with `recipientName`, or resolve via `lark-contact-ops` and pass `receiveId` as open id.
- Known group/chat: use `op="send"` with `chatId` and `receiveIdType="chat_id"`.
- Reply to a message: use `op="reply"` with `messageId`.
- Mentions: use `op="mention"` with `mentionNames`.

## Content Rules

- Plain text is fine.
- Markdown tables and structured markdown are supported by the tool renderer; pass the full `text`.
- Do not output Chinese unless the user asked for Chinese.

## Confirmation

If the user clearly said "send", "reply", "DM", or "post", call the tool. If the user says "draft" or "write a message", produce draft text and ask before sending.

## Final Response

Report `messageId` and recipient/chat. Never say "sent" without `success: true`.
