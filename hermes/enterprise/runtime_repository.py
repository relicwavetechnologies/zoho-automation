"""Repository primitives for Hermes-owned runtime persistence."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any, Mapping

from .runtime_events import RuntimeEvent, RuntimeRunContext


@dataclass(frozen=True)
class SessionBindingInput:
    company_id: str
    hermes_session_id: str
    session_key: str
    conversation_id: str
    run_id: str = ""
    channel_identity_id: str = ""
    resolved_user_id: str = ""
    parent_hermes_session_id: str = ""
    platform: str = ""
    chat_id: str = ""
    thread_id: str = ""
    source: str = "runtime"

    def missing_required_fields(self) -> tuple[str, ...]:
        missing = []
        for field_name in ("company_id", "hermes_session_id", "session_key", "conversation_id"):
            if not getattr(self, field_name):
                missing.append(field_name)
        return tuple(missing)


class EnterpriseRuntimeRepository:
    """Postgres repository for canonical runtime rows.

    The connection object is intentionally injected. Production can pass an
    asyncpg connection/pool transaction; tests pass a small fake connection.
    """

    def __init__(self, connection: Any):
        self._connection = connection

    async def bind_session(self, binding: SessionBindingInput) -> str | None:
        missing = binding.missing_required_fields()
        if missing:
            raise ValueError(f"Missing required session binding fields: {', '.join(missing)}")

        binding_id = _new_id()
        sql = """
        INSERT INTO "HermesSessionBinding" (
            "id",
            "companyId",
            "hermesSessionId",
            "sessionKey",
            "conversationId",
            "runId",
            "channelIdentityId",
            "resolvedUserId",
            "parentHermesSessionId",
            "platform",
            "chatId",
            "threadId",
            "source"
        )
        VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)
        ON CONFLICT ("companyId", "hermesSessionId") DO UPDATE SET
            "sessionKey" = excluded."sessionKey",
            "conversationId" = excluded."conversationId",
            "runId" = excluded."runId",
            "channelIdentityId" = excluded."channelIdentityId",
            "resolvedUserId" = excluded."resolvedUserId",
            "parentHermesSessionId" = excluded."parentHermesSessionId",
            "platform" = excluded."platform",
            "chatId" = excluded."chatId",
            "threadId" = excluded."threadId",
            "source" = excluded."source",
            "lastSeenAt" = now()
        RETURNING "id"
        """
        args = (
            binding_id,
            binding.company_id,
            binding.hermes_session_id,
            binding.session_key,
            binding.conversation_id,
            binding.run_id,
            binding.channel_identity_id,
            binding.resolved_user_id,
            binding.parent_hermes_session_id,
            binding.platform,
            binding.chat_id,
            binding.thread_id,
            binding.source,
        )

        fetchrow = getattr(self._connection, "fetchrow", None)
        if fetchrow is not None:
            row = await fetchrow(sql, *args)
            if row is None:
                return None
            try:
                return row["id"]
            except (KeyError, TypeError):
                return row[0] if row else None

        await self._connection.execute(sql, *args)
        return None


class EnterpriseRuntimeHistoryWriter:
    """Synchronous writer for canonical runtime conversation/run history."""

    def __init__(self, connection: Any):
        self._connection = connection
        self._conversation_ids: dict[str, str] = {}
        self._started_runs: set[str] = set()

    def start_run(self, context: RuntimeRunContext) -> str:
        conversation_id = self._ensure_conversation(context)
        self._ensure_run(context, conversation_id)
        self._bind_session(context, conversation_id)
        return conversation_id

    def record_event(self, context: RuntimeRunContext, event: RuntimeEvent | Mapping[str, Any]) -> None:
        runtime_event = _coerce_runtime_event(event)
        conversation_id = self.start_run(context)
        if runtime_event.message_kind:
            self._insert_message(context, conversation_id, runtime_event)
        if runtime_event.status:
            self._update_run_status(context, runtime_event)
        if runtime_event.event_type == "run.completed":
            self._upsert_run_stats(context, runtime_event)

    def _ensure_conversation(self, context: RuntimeRunContext) -> str:
        cache_key = _conversation_cache_key(context)
        cached = self._conversation_ids.get(cache_key)
        if cached:
            return cached

        conversation_id = _new_id()
        sql = """
        INSERT INTO "RuntimeConversation" (
            "id",
            "companyId",
            "departmentId",
            "channel",
            "channelConversationKey",
            "rawChannelKey",
            "createdByUserId",
            "createdByEmail",
            "refsJson",
            "updatedAt"
        )
        VALUES (%s, %s, NULLIF(%s, ''), %s, %s, %s, NULLIF(%s, ''), NULLIF(%s, ''), %s::jsonb, now())
        ON CONFLICT ("companyId", "channel", "channelConversationKey") DO UPDATE SET
            "departmentId" = COALESCE(excluded."departmentId", "RuntimeConversation"."departmentId"),
            "rawChannelKey" = excluded."rawChannelKey",
            "createdByUserId" = COALESCE("RuntimeConversation"."createdByUserId", excluded."createdByUserId"),
            "createdByEmail" = COALESCE("RuntimeConversation"."createdByEmail", excluded."createdByEmail"),
            "updatedAt" = now()
        RETURNING "id"
        """
        row = self._fetchone(
            sql,
            (
                conversation_id,
                context.company_id,
                context.department_id,
                context.channel,
                context.channel_conversation_key,
                context.raw_channel_key,
                context.created_by_user_id,
                context.created_by_email,
                _json_dumps({"session_key": context.session_key}),
            ),
        )
        conversation_id = _row_get(row, "id")
        if not conversation_id:
            raise RuntimeError("RuntimeConversation upsert did not return an id")
        self._conversation_ids[cache_key] = str(conversation_id)
        return str(conversation_id)

    def _ensure_run(self, context: RuntimeRunContext, conversation_id: str) -> None:
        if context.run_id in self._started_runs:
            return
        sql = """
        INSERT INTO "RuntimeRun" (
            "id",
            "conversationId",
            "parentRunId",
            "engine",
            "engineMode",
            "channel",
            "entrypoint",
            "status",
            "metadataJson",
            "hermesSessionId",
            "parentHermesSessionId",
            "modelId",
            "systemPromptSnapshot",
            "cwd",
            "updatedAt"
        )
        VALUES (%s, %s, NULLIF(%s, ''), %s, %s, %s, %s, 'running', %s::jsonb, NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), now())
        ON CONFLICT ("id") DO UPDATE SET
            "conversationId" = excluded."conversationId",
            "parentRunId" = excluded."parentRunId",
            "engine" = excluded."engine",
            "engineMode" = excluded."engineMode",
            "channel" = excluded."channel",
            "entrypoint" = excluded."entrypoint",
            "metadataJson" = excluded."metadataJson",
            "hermesSessionId" = excluded."hermesSessionId",
            "parentHermesSessionId" = excluded."parentHermesSessionId",
            "modelId" = excluded."modelId",
            "systemPromptSnapshot" = excluded."systemPromptSnapshot",
            "cwd" = excluded."cwd",
            "updatedAt" = now()
        """
        self._execute(
            sql,
            (
                context.run_id,
                conversation_id,
                context.parent_run_id,
                context.engine,
                context.engine_mode,
                context.channel,
                context.entrypoint,
                _json_dumps({"session_key": context.session_key}),
                context.hermes_session_id,
                context.parent_hermes_session_id,
                context.model_id,
                context.system_prompt_snapshot,
                context.cwd,
            ),
        )
        self._started_runs.add(context.run_id)

    def _bind_session(self, context: RuntimeRunContext, conversation_id: str) -> None:
        binding_id = _new_id()
        sql = """
        INSERT INTO "HermesSessionBinding" (
            "id",
            "companyId",
            "hermesSessionId",
            "sessionKey",
            "conversationId",
            "runId",
            "channelIdentityId",
            "resolvedUserId",
            "parentHermesSessionId",
            "platform",
            "chatId",
            "threadId",
            "source"
        )
        VALUES (%s, %s, %s, %s, %s, %s, NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), %s, NULLIF(%s, ''), NULLIF(%s, ''), 'runtime')
        ON CONFLICT ("companyId", "hermesSessionId") DO UPDATE SET
            "sessionKey" = excluded."sessionKey",
            "conversationId" = excluded."conversationId",
            "runId" = excluded."runId",
            "channelIdentityId" = excluded."channelIdentityId",
            "resolvedUserId" = excluded."resolvedUserId",
            "parentHermesSessionId" = excluded."parentHermesSessionId",
            "platform" = excluded."platform",
            "chatId" = excluded."chatId",
            "threadId" = excluded."threadId",
            "source" = excluded."source",
            "lastSeenAt" = now()
        """
        self._execute(
            sql,
            (
                binding_id,
                context.company_id,
                context.hermes_session_id,
                context.session_key,
                conversation_id,
                context.run_id,
                context.channel_identity_id,
                context.created_by_user_id,
                context.parent_hermes_session_id,
                context.channel,
                context.raw_channel_key,
                "",
            ),
        )

    def _insert_message(
        self,
        context: RuntimeRunContext,
        conversation_id: str,
        event: RuntimeEvent,
    ) -> None:
        message_id = _new_id()
        sql = """
        INSERT INTO "RuntimeConversationMessage" (
            "id",
            "conversationId",
            "runId",
            "sequence",
            "role",
            "messageKind",
            "sourceChannel",
            "sourceMessageId",
            "dedupeKey",
            "contentText",
            "contentJson",
            "toolCallJson",
            "visibility",
            "actingCompanyUserId",
            "actingChannelIdentityId",
            "senderExternalId",
            "senderDisplayName",
            "hermesMessageId",
            "finishReason",
            "tokenCount",
            "reasoningJson",
            "toolCallId"
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, NULLIF(%s, ''), %s, NULLIF(%s, ''), %s::jsonb, %s::jsonb, 'internal', NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), NULLIF(%s, ''), %s, NULLIF(%s, ''), %s, %s::jsonb, NULLIF(%s, ''))
        ON CONFLICT ("conversationId", "sequence") DO UPDATE SET
            "runId" = excluded."runId",
            "role" = excluded."role",
            "messageKind" = excluded."messageKind",
            "sourceChannel" = excluded."sourceChannel",
            "sourceMessageId" = excluded."sourceMessageId",
            "dedupeKey" = excluded."dedupeKey",
            "contentText" = excluded."contentText",
            "contentJson" = excluded."contentJson",
            "toolCallJson" = excluded."toolCallJson",
            "actingCompanyUserId" = excluded."actingCompanyUserId",
            "actingChannelIdentityId" = excluded."actingChannelIdentityId",
            "senderExternalId" = excluded."senderExternalId",
            "senderDisplayName" = excluded."senderDisplayName",
            "hermesMessageId" = excluded."hermesMessageId",
            "finishReason" = excluded."finishReason",
            "tokenCount" = excluded."tokenCount",
            "reasoningJson" = excluded."reasoningJson",
            "toolCallId" = excluded."toolCallId"
        """
        usage = dict(event.usage or {})
        token_count = _int_or_none(usage.get("total_tokens"))
        self._execute(
            sql,
            (
                message_id,
                conversation_id,
                context.run_id,
                event.sequence,
                event.message_role or "system",
                event.message_kind,
                context.channel,
                event.raw.get("message_id") or event.raw.get("source_message_id") or "",
                event.idempotency_key,
                event.content_text,
                _json_dumps(event.as_dict()),
                _json_dumps(_tool_json(event)),
                event.identity.company_user_id,
                event.identity.channel_identity_id,
                event.raw.get("sender_external_id") or "",
                event.raw.get("sender_display_name") or "",
                event.idempotency_key,
                event.finish_reason,
                token_count,
                _json_dumps({"text": event.content_text} if event.message_kind == "reasoning" else {}),
                event.tool_call_id,
            ),
        )
        self._execute(
            """
            UPDATE "RuntimeConversation"
            SET "lastMessageSequence" = GREATEST("lastMessageSequence", %s),
                "updatedAt" = now()
            WHERE "id" = %s
            """,
            (event.sequence, conversation_id),
        )

    def _update_run_status(self, context: RuntimeRunContext, event: RuntimeEvent) -> None:
        terminal = event.status in {"completed", "failed", "cancelled"}
        sql = """
        UPDATE "RuntimeRun"
        SET "status" = %s,
            "stopReason" = NULLIF(%s, ''),
            "errorJson" = %s::jsonb,
            "finishedAt" = CASE WHEN %s THEN now() ELSE "finishedAt" END,
            "updatedAt" = now()
        WHERE "id" = %s
        """
        self._execute(
            sql,
            (
                event.status,
                event.finish_reason,
                _json_dumps({"message": event.error} if event.error else {}),
                terminal,
                context.run_id,
            ),
        )

    def _upsert_run_stats(self, context: RuntimeRunContext, event: RuntimeEvent) -> None:
        usage = dict(event.usage or {})
        stats_id = _new_id()
        sql = """
        INSERT INTO "HermesRunStats" (
            "id",
            "runId",
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "reasoningTokens",
            "totalTokens",
            "messageCount",
            "toolCallCount",
            "metadataJson",
            "updatedAt"
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, now())
        ON CONFLICT ("runId") DO UPDATE SET
            "inputTokens" = excluded."inputTokens",
            "outputTokens" = excluded."outputTokens",
            "cacheReadTokens" = excluded."cacheReadTokens",
            "cacheWriteTokens" = excluded."cacheWriteTokens",
            "reasoningTokens" = excluded."reasoningTokens",
            "totalTokens" = excluded."totalTokens",
            "messageCount" = excluded."messageCount",
            "toolCallCount" = excluded."toolCallCount",
            "metadataJson" = excluded."metadataJson",
            "updatedAt" = now()
        """
        self._execute(
            sql,
            (
                stats_id,
                context.run_id,
                _int_or_zero(usage.get("input_tokens")),
                _int_or_zero(usage.get("output_tokens")),
                _int_or_zero(usage.get("cache_read_tokens")),
                _int_or_zero(usage.get("cache_write_tokens")),
                _int_or_zero(usage.get("reasoning_tokens")),
                _int_or_zero(usage.get("total_tokens")),
                event.sequence,
                0,
                _json_dumps({"usage": usage}),
            ),
        )

    def _execute(self, sql: str, args: tuple[Any, ...]) -> None:
        result = self._connection.execute(sql, args)
        close = getattr(result, "close", None)
        if close is not None:
            close()

    def _fetchone(self, sql: str, args: tuple[Any, ...]) -> Any:
        result = self._connection.execute(sql, args)
        fetchone = getattr(result, "fetchone", None)
        if fetchone is None:
            return None
        try:
            return fetchone()
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()


def _coerce_runtime_event(event: RuntimeEvent | Mapping[str, Any]) -> RuntimeEvent:
    if isinstance(event, RuntimeEvent):
        return event
    identity = event.get("identity") if isinstance(event.get("identity"), Mapping) else {}
    from .runtime_events import RuntimeIdentityContext

    return RuntimeEvent(
        run_id=str(event.get("run_id") or ""),
        sequence=int(event.get("sequence") or 0),
        event_type=str(event.get("event_type") or ""),
        timestamp=float(event.get("timestamp") or 0),
        idempotency_key=str(event.get("idempotency_key") or ""),
        status=str(event.get("status") or ""),
        message_role=str(event.get("message_role") or ""),
        message_kind=str(event.get("message_kind") or ""),
        content_text=str(event.get("content_text") or ""),
        tool_name=str(event.get("tool_name") or ""),
        tool_call_id=str(event.get("tool_call_id") or ""),
        approval_id=str(event.get("approval_id") or ""),
        error=str(event.get("error") or ""),
        finish_reason=str(event.get("finish_reason") or ""),
        usage=event.get("usage") if isinstance(event.get("usage"), Mapping) else {},
        identity=RuntimeIdentityContext(
            company_id=str(identity.get("company_id") or ""),
            company_user_id=str(identity.get("company_user_id") or ""),
            channel_identity_id=str(identity.get("channel_identity_id") or ""),
            company_role=str(identity.get("company_role") or ""),
            department_id=str(identity.get("department_id") or ""),
            session_key=str(identity.get("session_key") or ""),
        ),
        raw=event.get("raw") if isinstance(event.get("raw"), Mapping) else {},
    )


def _conversation_cache_key(context: RuntimeRunContext) -> str:
    return f"{context.company_id}\x1f{context.channel}\x1f{context.channel_conversation_key}"


def _json_dumps(value: Mapping[str, Any]) -> str:
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"))


def _row_get(row: Any, key: str) -> Any:
    if row is None:
        return None
    if isinstance(row, Mapping):
        return row.get(key)
    try:
        return row[key]
    except (KeyError, TypeError, IndexError):
        return None


def _int_or_zero(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _new_id() -> str:
    return str(uuid.uuid4())


def _tool_json(event: RuntimeEvent) -> dict[str, Any]:
    if event.message_kind != "tool":
        return {}
    return {
        "tool": event.tool_name,
        "tool_call_id": event.tool_call_id,
        "event_type": event.event_type,
        "raw": dict(event.raw or {}),
    }
