"""In-memory psycopg-style connection for enterprise session repository tests."""

from __future__ import annotations

import json
import re
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any


class MemoryCursor:
    def __init__(self, rows: list[dict[str, Any]]):
        self._rows = rows
        self._index = 0

    def fetchone(self):
        if self._index >= len(self._rows):
            return None
        row = self._rows[self._index]
        self._index += 1
        return row

    def fetchall(self):
        return list(self._rows)

    def close(self):
        return None


class MemoryEnterpriseConnection:
    def __init__(self):
        self.conversations: dict[str, dict[str, Any]] = {}
        self.bindings: dict[tuple[str, str], dict[str, Any]] = {}
        self.messages: list[dict[str, Any]] = []
        self.companies: dict[str, dict[str, Any]] = {}
        self.company_users: dict[str, dict[str, Any]] = {}
        self.channel_identities: dict[str, dict[str, Any]] = {}

    def execute(self, sql: str, args: tuple[Any, ...]):
        sql_norm = " ".join(sql.split())
        if 'INSERT INTO "RuntimeConversation"' in sql_norm and "ON CONFLICT" in sql_norm:
            conv_id = str(args[0])
            row = {
                "id": conv_id,
                "companyId": args[1],
                "departmentId": args[2] or "",
                "channel": args[3],
                "channelConversationKey": args[4],
                "rawChannelKey": args[5],
                "createdByUserId": args[6] or "",
                "createdByEmail": args[7] or "",
                "title": None,
                "status": "active",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
                "lastMessageSequence": 0,
            }
            key = (args[1], args[3], args[4])
            existing = next(
                (
                    item
                    for item in self.conversations.values()
                    if (
                        item["companyId"],
                        item["channel"],
                        item["channelConversationKey"],
                    )
                    == key
                ),
                None,
            )
            if existing:
                existing.update(
                    {
                        "departmentId": row["departmentId"] or existing["departmentId"],
                        "rawChannelKey": row["rawChannelKey"],
                        "updatedAt": datetime.now(timezone.utc),
                    }
                )
                return MemoryCursor([{"id": existing["id"]}])
            self.conversations[conv_id] = row
            return MemoryCursor([{"id": conv_id}])

        if 'INSERT INTO "HermesSessionBinding"' in sql_norm and "ON CONFLICT" in sql_norm:
            company_id = args[1]
            session_id = args[2]
            binding = {
                "id": args[0],
                "companyId": company_id,
                "hermesSessionId": session_id,
                "sessionKey": args[3],
                "conversationId": args[4],
                "channelIdentityId": args[5] or "",
                "resolvedUserId": args[6] or "",
                "platform": args[7],
                "chatId": args[8],
                "threadId": args[9] or "",
                "source": args[10] if len(args) > 10 else "runtime",
                "lastSeenAt": datetime.now(timezone.utc),
            }
            self.bindings[(company_id, session_id)] = binding
            return MemoryCursor([])

        if 'INSERT INTO "RuntimeConversationMessage"' in sql_norm:
            message = {
                "id": args[0],
                "conversationId": args[1],
                "sequence": args[2],
                "role": args[3],
                "messageKind": args[4],
                "sourceChannel": args[5],
                "contentText": args[7],
                "contentJson": json.loads(args[8]) if args[8] else {},
                "toolCallJson": json.loads(args[9]) if args[9] else None,
                "actingCompanyUserId": args[10],
                "actingChannelIdentityId": args[11],
                "toolCallId": args[14],
                "finishReason": args[13],
                "active": True,
                "createdAt": datetime.now(timezone.utc),
            }
            self.messages.append(message)
            return MemoryCursor([])

        if 'UPDATE "RuntimeConversation"' in sql_norm and "lastMessageSequence" in sql_norm:
            conv_id = args[1]
            if conv_id in self.conversations:
                self.conversations[conv_id]["lastMessageSequence"] = max(
                    int(self.conversations[conv_id].get("lastMessageSequence") or 0),
                    int(args[0]),
                )
                self.conversations[conv_id]["updatedAt"] = datetime.now(timezone.utc)
            return MemoryCursor([])

        if 'UPDATE "RuntimeConversation"' in sql_norm and '"title"' in sql_norm:
            conv_id = args[1]
            if conv_id in self.conversations:
                self.conversations[conv_id]["title"] = args[0] or None
            return MemoryCursor([])

        if 'UPDATE "RuntimeConversation"' in sql_norm and '"status"' in sql_norm:
            conv_id = args[1]
            if conv_id in self.conversations:
                self.conversations[conv_id]["status"] = args[0]
            return MemoryCursor([])

        if 'UPDATE "RuntimeConversationMessage"' in sql_norm and '"active"' in sql_norm:
            conv_id = args[0]
            for message in self.messages:
                if message["conversationId"] == conv_id:
                    message["active"] = False
            return MemoryCursor([])

        if 'UPDATE "HermesSessionBinding"' in sql_norm and '"lastSeenAt"' in sql_norm:
            binding = self.bindings.get((args[0], args[1]))
            if binding:
                binding["lastSeenAt"] = datetime.now(timezone.utc)
            return MemoryCursor([])

        if 'DELETE FROM "HermesSessionBinding"' in sql_norm:
            self.bindings.pop((args[0], args[1]), None)
            return MemoryCursor([])

        if 'SELECT COALESCE(MAX("sequence"), 0) + 1 AS next_sequence' in sql_norm:
            conv_id = args[0]
            seq = max(
                [
                    int(m["sequence"])
                    for m in self.messages
                    if m["conversationId"] == conv_id
                ]
                or [0],
            ) + 1
            return MemoryCursor([{"next_sequence": seq}])

        if 'SELECT COUNT(*) AS total' in sql_norm:
            rows = self._filter_bindings(sql_norm, args)
            return MemoryCursor([{"total": len(rows)}])

        if 'FROM "HermesSessionBinding" b' in sql_norm and 'LIMIT %s OFFSET %s' in sql_norm:
            rows = self._filter_bindings(sql_norm, args)
            limit = int(args[-2])
            offset = int(args[-1])
            return MemoryCursor(rows[offset : offset + limit])

        if (
            'FROM "HermesSessionBinding" b' in sql_norm
            and 'b."hermesSessionId" = %s' in sql_norm
            and 'LIMIT 1' in sql_norm
        ):
            company_id, user_id, session_id = args[:3]
            binding = self.bindings.get((company_id, session_id))
            if not binding or binding.get("resolvedUserId") != user_id:
                return MemoryCursor([])
            conv = self.conversations.get(binding["conversationId"], {})
            return MemoryCursor(
                [
                    {
                        "hermesSessionId": binding["hermesSessionId"],
                        "conversationId": binding["conversationId"],
                        "platform": binding.get("platform"),
                        "source": binding.get("source"),
                        "title": conv.get("title"),
                        "createdAt": conv.get("createdAt"),
                        "updatedAt": conv.get("updatedAt"),
                        "status": conv.get("status"),
                    }
                ]
            )

        if 'FROM "RuntimeConversationMessage"' in sql_norm and 'ORDER BY "sequence" ASC' in sql_norm:
            conv_id = args[0]
            rows = [
                deepcopy(m)
                for m in self.messages
                if m["conversationId"] == conv_id and m.get("active", True)
            ]
            rows.sort(key=lambda item: item["sequence"])
            return MemoryCursor(rows)

        if (
            'SELECT b."hermesSessionId" AS id' in sql_norm
            and 'LIKE %s' in sql_norm
        ):
            company_id, user_id, prefix = args
            matches = [
                {"id": binding["hermesSessionId"]}
                for (cid, sid), binding in self.bindings.items()
                if cid == company_id
                and binding.get("resolvedUserId") == user_id
                and sid.startswith(prefix.replace("%", ""))
            ]
            return MemoryCursor(matches[:2])

        if 'INSERT INTO "CompanyUser"' in sql_norm:
            return MemoryCursor([])

        if 'INSERT INTO "ChannelIdentity"' in sql_norm:
            return MemoryCursor([])

        if 'INSERT INTO "Company"' in sql_norm:
            return MemoryCursor([])

        raise AssertionError(f"Unhandled SQL in MemoryEnterpriseConnection: {sql_norm[:160]}")

    def _filter_bindings(self, sql: str, args: tuple[Any, ...]) -> list[dict[str, Any]]:
        company_id = args[0]
        user_id = args[1]
        min_messages = int(args[-3]) if "LIMIT %s OFFSET %s" in sql else int(args[-1])
        archived_only = 'c."status" = %s' in sql and "archived" in args
        exclude_archived = (
            'c."status" IS NULL OR c."status" <>' in sql or 'c."status" <> %s' in sql
        )
        rows: list[dict[str, Any]] = []
        for binding in self.bindings.values():
            if binding["companyId"] != company_id:
                continue
            if binding.get("resolvedUserId") != user_id:
                continue
            conv = self.conversations.get(binding["conversationId"], {})
            status = conv.get("status") or "active"
            if archived_only and status != "archived":
                continue
            if exclude_archived and status == "archived":
                continue
            message_count = sum(
                1
                for message in self.messages
                if message["conversationId"] == binding["conversationId"]
                and message.get("active", True)
            )
            if message_count < min_messages:
                continue
            preview = next(
                (
                    (message.get("contentText") or "")[:63]
                    for message in sorted(
                        [
                            m
                            for m in self.messages
                            if m["conversationId"] == binding["conversationId"]
                            and m.get("role") == "user"
                        ],
                        key=lambda item: item["sequence"],
                    )
                ),
                "",
            )
            rows.append(
                {
                    "id": binding["hermesSessionId"],
                    "source": binding.get("platform") or "tui",
                    "title": conv.get("title"),
                    "started_at": conv.get("createdAt"),
                    "ended_at": conv.get("updatedAt"),
                    "status": status,
                    "message_count": message_count,
                    "tool_call_count": sum(
                        1
                        for message in self.messages
                        if message["conversationId"] == binding["conversationId"]
                        and message.get("messageKind") == "tool"
                    ),
                    "last_active": conv.get("updatedAt"),
                    "_preview_raw": preview,
                }
            )
        rows.sort(key=lambda item: item.get("started_at") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
        return rows


def seed_company_session(
    connection: MemoryEnterpriseConnection,
    *,
    company_id: str,
    company_user_id: str,
    channel_identity_id: str,
    session_id: str,
    messages: list[tuple[str, str]],
) -> None:
    from enterprise.identity_repository import EnterpriseIdentityRepository, ResolvedCompanyIdentity
    from enterprise.session_repository import CompanySessionScope, EnterpriseSessionRepository

    identity = ResolvedCompanyIdentity(
        company_id=company_id,
        company_user_id=company_user_id,
        channel_identity_id=channel_identity_id,
        identity_key=session_id,
    )
    EnterpriseIdentityRepository(connection).bind_session_identity(
        session_id=session_id,
        session_key=session_id,
        identity=identity,
        platform="tui",
        chat_id=session_id,
    )
    repo = EnterpriseSessionRepository(connection)
    scope = CompanySessionScope(
        company_id=company_id,
        company_user_id=company_user_id,
        channel_identity_id=channel_identity_id,
    )
    payload = [{"role": role, "content": content} for role, content in messages]
    repo.append_session_messages(scope, session_id, payload, start_idx=0, platform="tui")
