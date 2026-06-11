import uuid

import pytest

from enterprise.runtime_events import RuntimeEventNormalizer, RuntimeIdentityContext, RuntimeRunContext
from enterprise.runtime_repository import (
    EnterpriseRuntimeHistoryWriter,
    EnterpriseRuntimeRepository,
    SessionBindingInput,
)


class FakeFetchConnection:
    def __init__(self):
        self.calls = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return {"id": "binding_1"}


class FakeCursor:
    def __init__(self, row=None):
        self._row = row
        self.closed = False

    def fetchone(self):
        return self._row

    def close(self):
        self.closed = True


class FakeSyncConnection:
    def __init__(self):
        self.calls = []

    def execute(self, sql, args):
        self.calls.append((sql, args))
        if 'RETURNING "id"' in sql:
            return FakeCursor({"id": "conv_1"})
        return FakeCursor()


@pytest.mark.asyncio
async def test_bind_session_upserts_by_company_and_hermes_session():
    connection = FakeFetchConnection()
    repo = EnterpriseRuntimeRepository(connection)

    binding_id = await repo.bind_session(
        SessionBindingInput(
            company_id="company_1",
            hermes_session_id="20260607_001122_abcd",
            session_key="agent:main:lark:dm:chat",
            conversation_id="conv_1",
            run_id="run_1",
            channel_identity_id="ci_1",
            resolved_user_id="cu_1",
            platform="lark",
            chat_id="chat",
        )
    )

    assert binding_id == "binding_1"
    sql, args = connection.calls[0]
    assert 'INSERT INTO "HermesSessionBinding"' in sql
    assert 'ON CONFLICT ("companyId", "hermesSessionId")' in sql
    assert uuid.UUID(args[0])
    assert args[1:5] == (
        "company_1",
        "20260607_001122_abcd",
        "agent:main:lark:dm:chat",
        "conv_1",
    )


@pytest.mark.asyncio
async def test_bind_session_requires_canonical_conversation():
    repo = EnterpriseRuntimeRepository(FakeFetchConnection())

    with pytest.raises(ValueError, match="conversation_id"):
        await repo.bind_session(
            SessionBindingInput(
                company_id="company_1",
                hermes_session_id="session_1",
                session_key="session-key",
                conversation_id="",
            )
        )


def test_history_writer_starts_run_with_real_conversation_and_binding():
    connection = FakeSyncConnection()
    writer = EnterpriseRuntimeHistoryWriter(connection)

    conversation_id = writer.start_run(
        RuntimeRunContext(
            run_id="run_1",
            company_id="company_1",
            department_id="dept_1",
            channel="api_server",
            channel_conversation_key="session-key",
            raw_channel_key="session_1",
            hermes_session_id="session_1",
            session_key="session-key",
            created_by_user_id="cu_1",
            model_id="deepseek-chat",
        )
    )

    assert conversation_id == "conv_1"
    assert 'INSERT INTO "RuntimeConversation"' in connection.calls[0][0]
    assert uuid.UUID(connection.calls[0][1][0])
    assert connection.calls[0][1][1:6] == (
        "company_1",
        "dept_1",
        "api_server",
        "session-key",
        "session_1",
    )
    assert 'INSERT INTO "RuntimeRun"' in connection.calls[1][0]
    assert connection.calls[1][1][:7] == (
        "run_1",
        "conv_1",
        "",
        "hermes",
        "primary",
        "api_server",
        "api_server:/v1/runs",
    )
    assert 'INSERT INTO "HermesSessionBinding"' in connection.calls[2][0]
    assert uuid.UUID(connection.calls[2][1][0])
    assert connection.calls[2][1][1:6] == (
        "company_1",
        "session_1",
        "session-key",
        "conv_1",
        "run_1",
    )


def test_history_writer_records_message_status_and_stats():
    connection = FakeSyncConnection()
    writer = EnterpriseRuntimeHistoryWriter(connection)
    context = RuntimeRunContext(
        run_id="run_1",
        company_id="company_1",
        channel="api_server",
        channel_conversation_key="session-key",
        raw_channel_key="session_1",
        hermes_session_id="session_1",
        session_key="session-key",
        created_by_user_id="cu_1",
    )
    normalizer = RuntimeEventNormalizer(
        run_id="run_1",
        identity=RuntimeIdentityContext(
            company_id="company_1",
            company_user_id="cu_1",
            channel_identity_id="ci_1",
            session_key="session-key",
        ),
    )

    event = normalizer.normalize(
        {
            "event": "run.completed",
            "run_id": "run_1",
            "output": "done",
            "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
        }
    )
    writer.record_event(context, event)

    sql_text = "\n".join(sql for sql, _args in connection.calls)
    assert 'INSERT INTO "RuntimeConversationMessage"' in sql_text
    assert 'UPDATE "RuntimeRun"' in sql_text
    assert 'INSERT INTO "HermesRunStats"' in sql_text

    message_call = next(call for call in connection.calls if 'RuntimeConversationMessage' in call[0])
    assert uuid.UUID(message_call[1][0])
    assert message_call[1][1:9] == (
        "conv_1",
        "run_1",
        1,
        "assistant",
        "final",
        "api_server",
        "",
        "run_1:1:run.completed",
    )
    stats_call = next(call for call in connection.calls if 'HermesRunStats' in call[0])
    assert uuid.UUID(stats_call[1][0])
    assert stats_call[1][1:8] == ("run_1", 3, 2, 0, 0, 0, 5)
