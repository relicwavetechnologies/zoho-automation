"""Postgres-backed company session list/detail/message persistence."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping

from .runtime_events import RuntimeIdentityContext
from .session_message_codec import (
    message_row_to_api_dict,
    prepare_message_for_insert,
)


@dataclass(frozen=True)
class CompanySessionScope:
    company_id: str
    company_user_id: str
    channel_identity_id: str = ""
    company_role: str = ""
    department_id: str = ""


class EnterpriseSessionRepository:
    """Read/write company chat sessions from canonical Postgres runtime tables."""

    def __init__(self, connection: Any):
        self._connection = connection

    def list_sessions_for_user(
        self,
        scope: CompanySessionScope,
        *,
        limit: int = 20,
        offset: int = 0,
        min_message_count: int = 0,
        include_archived: bool = False,
        archived_only: bool = False,
        order_by_last_active: bool = False,
    ) -> tuple[list[dict[str, Any]], int]:
        self._require_scope(scope)
        archived_clause, archived_params = _archived_filter(include_archived, archived_only)
        order_clause = (
            'ORDER BY COALESCE(stats.last_active, c."createdAt") DESC, c."createdAt" DESC'
            if order_by_last_active
            else 'ORDER BY c."createdAt" DESC'
        )
        sql = f"""
        SELECT
            b."hermesSessionId" AS id,
            COALESCE(b."platform", b."source", 'tui') AS source,
            c."title",
            c."createdAt" AS started_at,
            c."updatedAt" AS ended_at,
            c."status",
            COALESCE(stats.message_count, 0) AS message_count,
            COALESCE(stats.tool_call_count, 0) AS tool_call_count,
            COALESCE(stats.last_active, c."createdAt") AS last_active,
            preview.preview AS _preview_raw
        FROM "HermesSessionBinding" b
        JOIN "RuntimeConversation" c ON c."id" = b."conversationId"
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*) FILTER (WHERE m."active" = true) AS message_count,
                COUNT(*) FILTER (
                    WHERE m."active" = true AND m."messageKind" = 'tool'
                ) AS tool_call_count,
                MAX(m."createdAt") AS last_active
            FROM "RuntimeConversationMessage" m
            WHERE m."conversationId" = c."id"
        ) stats ON true
        LEFT JOIN LATERAL (
            SELECT SUBSTRING(m."contentText", 1, 63) AS preview
            FROM "RuntimeConversationMessage" m
            WHERE m."conversationId" = c."id"
              AND m."role" = 'user'
              AND m."contentText" IS NOT NULL
              AND m."active" = true
            ORDER BY m."sequence" ASC
            LIMIT 1
        ) preview ON true
        WHERE b."companyId" = %s
          AND b."resolvedUserId" = %s
          {archived_clause}
          AND COALESCE(stats.message_count, 0) >= %s
        {order_clause}
        LIMIT %s OFFSET %s
        """
        count_sql = f"""
        SELECT COUNT(*) AS total
        FROM "HermesSessionBinding" b
        JOIN "RuntimeConversation" c ON c."id" = b."conversationId"
        LEFT JOIN LATERAL (
            SELECT COUNT(*) FILTER (WHERE m."active" = true) AS message_count
            FROM "RuntimeConversationMessage" m
            WHERE m."conversationId" = c."id"
        ) stats ON true
        WHERE b."companyId" = %s
          AND b."resolvedUserId" = %s
          {archived_clause}
          AND COALESCE(stats.message_count, 0) >= %s
        """
        base_args = (
            scope.company_id,
            scope.company_user_id,
            *archived_params,
            max(0, min_message_count),
        )
        count_row = self._fetchone(count_sql, base_args)
        total = int((count_row or {}).get("total") or 0)
        rows = self._fetchall(sql, base_args + (limit, offset))
        return [_session_list_row_to_api(row) for row in rows], total

    def get_session_for_user(
        self,
        scope: CompanySessionScope,
        session_id: str,
    ) -> dict[str, Any] | None:
        self._require_scope(scope)
        row = self._fetch_binding_session(scope, session_id)
        return _session_detail_row_to_api(row) if row else None

    def resolve_session_id(
        self,
        scope: CompanySessionScope,
        session_id_or_prefix: str,
    ) -> str | None:
        self._require_scope(scope)
        exact = self.get_session_for_user(scope, session_id_or_prefix)
        if exact:
            return str(exact["id"])
        prefix = str(session_id_or_prefix or "")
        if not prefix:
            return None
        rows = self._fetchall(
            """
            SELECT b."hermesSessionId" AS id
            FROM "HermesSessionBinding" b
            WHERE b."companyId" = %s
              AND b."resolvedUserId" = %s
              AND b."hermesSessionId" LIKE %s
            ORDER BY b."lastSeenAt" DESC NULLS LAST
            LIMIT 2
            """,
            (scope.company_id, scope.company_user_id, f"{prefix}%"),
        )
        if len(rows) == 1:
            return str(rows[0]["id"])
        return None

    def list_messages_for_session(
        self,
        scope: CompanySessionScope,
        session_id: str,
    ) -> list[dict[str, Any]]:
        self._require_scope(scope)
        binding = self._fetch_binding_session(scope, session_id)
        if not binding:
            return []
        conversation_id = binding.get("conversationId")
        rows = self._fetchall(
            """
            SELECT *
            FROM "RuntimeConversationMessage"
            WHERE "conversationId" = %s
              AND "active" = true
            ORDER BY "sequence" ASC
            """,
            (conversation_id,),
        )
        sid = str(binding.get("hermesSessionId") or session_id)
        return [message_row_to_api_dict(row, session_id=sid) for row in rows]

    def append_session_messages(
        self,
        scope: CompanySessionScope,
        session_id: str,
        messages: list[Mapping[str, Any]],
        *,
        start_idx: int = 0,
        platform: str = "tui",
    ) -> int:
        self._require_scope(scope)
        binding = self._ensure_binding(scope, session_id, platform=platform)
        conversation_id = str(binding["conversationId"])
        next_sequence = self._next_message_sequence(conversation_id)
        written = 0
        for msg in messages[start_idx:]:
            role = str(msg.get("role") or "unknown")
            content_text, content_json, tool_json, tool_call_id = prepare_message_for_insert(
                msg,
                role=role,
            )
            message_id = str(uuid.uuid4())
            sequence = next_sequence
            next_sequence += 1
            self._execute(
                """
                INSERT INTO "RuntimeConversationMessage" (
                    "id",
                    "conversationId",
                    "runId",
                    "sequence",
                    "role",
                    "messageKind",
                    "sourceChannel",
                    "dedupeKey",
                    "contentText",
                    "contentJson",
                    "toolCallJson",
                    "visibility",
                    "actingCompanyUserId",
                    "actingChannelIdentityId",
                    "hermesMessageId",
                    "finishReason",
                    "toolCallId",
                    "active"
                )
                VALUES (
                    %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb,
                    'internal', %s, %s, %s, %s, %s, true
                )
                ON CONFLICT ("conversationId", "sequence") DO NOTHING
                """,
                (
                    message_id,
                    conversation_id,
                    sequence,
                    role,
                    role,
                    platform,
                    f"{session_id}:{sequence}",
                    content_text,
                    _json_dumps(content_json),
                    _json_dumps(tool_json) if tool_json else None,
                    scope.company_user_id,
                    scope.channel_identity_id or None,
                    message_id,
                    str(msg.get("finish_reason") or "") or None,
                    tool_call_id,
                ),
            )
            written += 1
        if written:
            self._execute(
                """
                UPDATE "RuntimeConversation"
                SET "lastMessageSequence" = GREATEST(
                        COALESCE("lastMessageSequence", 0),
                        %s
                    ),
                    "updatedAt" = now()
                WHERE "id" = %s
                """,
                (next_sequence - 1, conversation_id),
            )
            self._execute(
                """
                UPDATE "HermesSessionBinding"
                SET "lastSeenAt" = now()
                WHERE "companyId" = %s AND "hermesSessionId" = %s
                """,
                (scope.company_id, session_id),
            )
        return written

    def update_session_title(
        self,
        scope: CompanySessionScope,
        session_id: str,
        title: str | None,
    ) -> None:
        self._require_scope(scope)
        from hermes_state import SessionDB

        cleaned = SessionDB.sanitize_title(title) if title is not None else None
        binding = self._fetch_binding_session(scope, session_id)
        if not binding:
            raise KeyError(session_id)
        self._execute(
            """
            UPDATE "RuntimeConversation"
            SET "title" = NULLIF(%s, ''), "updatedAt" = now()
            WHERE "id" = %s
            """,
            (cleaned or "", binding["conversationId"]),
        )

    def set_session_archived(
        self,
        scope: CompanySessionScope,
        session_id: str,
        archived: bool,
    ) -> None:
        self._require_scope(scope)
        binding = self._fetch_binding_session(scope, session_id)
        if not binding:
            raise KeyError(session_id)
        status = "archived" if archived else "active"
        self._execute(
            """
            UPDATE "RuntimeConversation"
            SET "status" = %s, "updatedAt" = now()
            WHERE "id" = %s
            """,
            (status, binding["conversationId"]),
        )

    def delete_session(
        self,
        scope: CompanySessionScope,
        session_id: str,
    ) -> bool:
        self._require_scope(scope)
        binding = self._fetch_binding_session(scope, session_id)
        if not binding:
            return False
        conversation_id = binding["conversationId"]
        self._execute(
            """
            UPDATE "RuntimeConversationMessage"
            SET "active" = false
            WHERE "conversationId" = %s
            """,
            (conversation_id,),
        )
        self._execute(
            """
            DELETE FROM "HermesSessionBinding"
            WHERE "companyId" = %s AND "hermesSessionId" = %s
            """,
            (scope.company_id, session_id),
        )
        return True

    def delete_sessions(
        self,
        scope: CompanySessionScope,
        session_ids: list[str],
    ) -> int:
        deleted = 0
        for session_id in session_ids:
            if self.delete_session(scope, session_id):
                deleted += 1
        return deleted

    def export_session(
        self,
        scope: CompanySessionScope,
        session_id: str,
    ) -> dict[str, Any] | None:
        session = self.get_session_for_user(scope, session_id)
        if not session:
            return None
        messages = self.list_messages_for_session(scope, session_id)
        return {"session": session, "messages": messages}

    def identity_context(self, scope: CompanySessionScope, session_id: str) -> RuntimeIdentityContext:
        return RuntimeIdentityContext(
            company_id=scope.company_id,
            company_user_id=scope.company_user_id,
            channel_identity_id=scope.channel_identity_id,
            company_role=scope.company_role,
            department_id=scope.department_id,
            session_key=session_id,
        )

    def _ensure_binding(
        self,
        scope: CompanySessionScope,
        session_id: str,
        *,
        platform: str,
    ) -> dict[str, Any]:
        existing = self._fetch_binding_session(scope, session_id)
        if existing:
            return existing
        from enterprise.identity_repository import EnterpriseIdentityRepository, ResolvedCompanyIdentity

        repo = EnterpriseIdentityRepository(self._connection)
        identity = ResolvedCompanyIdentity(
            company_id=scope.company_id,
            company_user_id=scope.company_user_id,
            channel_identity_id=scope.channel_identity_id,
            identity_key=session_id,
            company_role=scope.company_role or "MEMBER",
            department_id=scope.department_id,
        )
        repo.bind_session_identity(
            session_id=session_id,
            session_key=session_id,
            identity=identity,
            platform=platform,
            chat_id=session_id,
            binding_source="runtime",
        )
        binding = self._fetch_binding_session(scope, session_id)
        if not binding:
            raise RuntimeError(f"Failed to bind enterprise session {session_id}")
        return binding

    def _fetch_binding_session(
        self,
        scope: CompanySessionScope,
        session_id: str,
    ) -> dict[str, Any] | None:
        row = self._fetchone(
            """
            SELECT
                b."hermesSessionId",
                b."conversationId",
                b."platform",
                b."source",
                c."title",
                c."createdAt",
                c."updatedAt",
                c."status"
            FROM "HermesSessionBinding" b
            JOIN "RuntimeConversation" c ON c."id" = b."conversationId"
            WHERE b."companyId" = %s
              AND b."resolvedUserId" = %s
              AND b."hermesSessionId" = %s
            LIMIT 1
            """,
            (scope.company_id, scope.company_user_id, session_id),
        )
        return dict(row) if row else None

    def _next_message_sequence(self, conversation_id: str) -> int:
        row = self._fetchone(
            """
            SELECT COALESCE(MAX("sequence"), 0) + 1 AS next_sequence
            FROM "RuntimeConversationMessage"
            WHERE "conversationId" = %s
            """,
            (conversation_id,),
        )
        return int((row or {}).get("next_sequence") or 1)

    def _require_scope(self, scope: CompanySessionScope) -> None:
        if not scope.company_id or not scope.company_user_id:
            raise ValueError("company_id and company_user_id are required")

    def _execute(self, sql: str, args: tuple[Any, ...]) -> None:
        result = self._connection.execute(sql, args)
        close = getattr(result, "close", None)
        if close is not None:
            close()

    def _fetchone(self, sql: str, args: tuple[Any, ...]) -> Any:
        result = self._connection.execute(sql, args)
        try:
            fetchone = getattr(result, "fetchone", None)
            return fetchone() if fetchone else None
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()

    def _fetchall(self, sql: str, args: tuple[Any, ...]) -> list[dict[str, Any]]:
        result = self._connection.execute(sql, args)
        try:
            fetchall = getattr(result, "fetchall", None)
            if fetchall:
                rows = fetchall()
                return [dict(row) for row in rows]
            return []
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()


def _archived_filter(include_archived: bool, archived_only: bool) -> tuple[str, tuple[Any, ...]]:
    if archived_only:
        return 'AND c."status" = %s', ("archived",)
    if not include_archived:
        return 'AND (c."status" IS NULL OR c."status" <> %s)', ("archived",)
    return "", ()


def _session_list_row_to_api(row: Mapping[str, Any]) -> dict[str, Any]:
    raw_preview = str(row.get("_preview_raw") or "").strip()
    preview = raw_preview[:60] + ("..." if len(raw_preview) > 60 else "") if raw_preview else ""
    started_at = _to_epoch(row.get("started_at"))
    last_active = _to_epoch(row.get("last_active")) or started_at
    archived = str(row.get("status") or "") == "archived"
    return {
        "id": row.get("id"),
        "source": row.get("source") or "tui",
        "model": None,
        "title": row.get("title"),
        "started_at": started_at,
        "ended_at": _to_epoch(row.get("ended_at")),
        "end_reason": None,
        "message_count": int(row.get("message_count") or 0),
        "tool_call_count": int(row.get("tool_call_count") or 0),
        "preview": preview,
        "last_active": last_active,
        "archived": archived,
        "parent_session_id": None,
        "cwd": None,
    }


def _session_detail_row_to_api(row: Mapping[str, Any]) -> dict[str, Any]:
    base = _session_list_row_to_api(
        {
            "id": row.get("hermesSessionId"),
            "source": row.get("platform") or row.get("source") or "tui",
            "title": row.get("title"),
            "started_at": row.get("createdAt"),
            "ended_at": row.get("updatedAt"),
            "status": row.get("status"),
            "message_count": 0,
            "tool_call_count": 0,
            "last_active": row.get("updatedAt"),
            "_preview_raw": "",
        }
    )
    base["system_prompt"] = None
    base["user_id"] = None
    base["model_config"] = None
    return base


def _to_epoch(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp()
    return None


def _json_dumps(value: Mapping[str, Any]) -> str:
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"))
