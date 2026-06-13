"""Tests for /v1/runs endpoints: start, status, events, and stop.

Covers:
- POST /v1/runs — start a run (202)
- GET /v1/runs/{run_id} — poll run status
- GET /v1/runs/{run_id}/events — SSE event stream
- POST /v1/runs/{run_id}/stop — interrupt a running agent
- Auth, error handling, and cleanup
"""

import asyncio
import threading
import time
from unittest.mock import MagicMock, patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import (
    APIServerAdapter,
    cors_middleware,
    security_headers_middleware,
)
from enterprise.runtime_events import (
    RuntimeEventNormalizer,
    RuntimeIdentityContext,
    RuntimeRunContext,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_adapter(api_key: str = "") -> APIServerAdapter:
    """Create an adapter with optional API key."""
    extra = {}
    if api_key:
        extra["key"] = api_key
    config = PlatformConfig(enabled=True, extra=extra)
    adapter = APIServerAdapter(config)
    return adapter


def _create_runs_app(adapter: APIServerAdapter) -> web.Application:
    """Create an aiohttp app with /v1/runs routes registered."""
    mws = [mw for mw in (cors_middleware, security_headers_middleware) if mw is not None]
    app = web.Application(middlewares=mws)
    app["api_server_adapter"] = adapter
    app.router.add_post("/v1/runs", adapter._handle_runs)
    app.router.add_get("/v1/runs/{run_id}", adapter._handle_get_run)
    app.router.add_get("/v1/runs/{run_id}/events", adapter._handle_run_events)
    app.router.add_post("/v1/runs/{run_id}/approval", adapter._handle_run_approval)
    app.router.add_post("/v1/runs/{run_id}/stop", adapter._handle_stop_run)
    return app


def _make_slow_agent(**kwargs):
    """Create a mock agent that blocks in run_conversation until interrupted.

    Returns (mock_agent, agent_ready_event, interrupt_event) where
    agent_ready_event is set once run_conversation starts, and
    interrupt_event is set when interrupt() is called.
    """
    ready = threading.Event()
    interrupted = threading.Event()

    mock_agent = MagicMock()

    def _do_interrupt(message=None):
        interrupted.set()

    mock_agent.interrupt = MagicMock(side_effect=_do_interrupt)

    def _slow_run(user_message=None, conversation_history=None, task_id=None):
        ready.set()
        # Block until interrupt() is called
        interrupted.wait(timeout=10)
        return {"final_response": "interrupted"}

    mock_agent.run_conversation.side_effect = _slow_run
    mock_agent.session_prompt_tokens = 0
    mock_agent.session_completion_tokens = 0
    mock_agent.session_total_tokens = 0

    return mock_agent, ready, interrupted


def _seed_run_events(
    adapter: APIServerAdapter,
    run_id: str,
    payloads: list[dict],
    *,
    status: str = "completed",
) -> None:
    adapter._run_streams[run_id] = True
    adapter._run_streams_created[run_id] = time.time()
    adapter._run_statuses[run_id] = {
        "object": "hermes.run",
        "run_id": run_id,
        "status": status,
        "updated_at": time.time(),
    }
    adapter._run_event_normalizers[run_id] = RuntimeEventNormalizer(
        run_id=run_id,
        identity=RuntimeIdentityContext(company_id="company_1"),
    )
    adapter._run_event_locks[run_id] = threading.Lock()
    for payload in payloads:
        adapter._record_runtime_event(run_id, payload)


@pytest.fixture
def adapter():
    return _make_adapter()


@pytest.fixture
def auth_adapter():
    return _make_adapter(api_key="sk-secret")


@pytest.fixture(autouse=True)
def _disable_enterprise_identity_env(monkeypatch):
    monkeypatch.delenv("HERMES_ENTERPRISE_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("HERMES_ENTERPRISE_POSTGRES", raising=False)


def test_record_runtime_event_normalizes_without_mutating_payload(adapter):
    adapter._run_event_normalizers["run_1"] = RuntimeEventNormalizer(
        run_id="run_1",
        identity=RuntimeIdentityContext(company_id="company_1"),
    )
    payload = {
        "event": "message.delta",
        "run_id": "run_1",
        "timestamp": 123.0,
        "delta": "hello",
    }

    adapter._record_runtime_event("run_1", payload)

    assert payload == {
        "event": "message.delta",
        "run_id": "run_1",
        "timestamp": 123.0,
        "delta": "hello",
    }
    recorded = adapter._run_runtime_events["run_1"][0]
    assert recorded["event_type"] == "message.delta"
    assert recorded["sequence"] == 1
    assert recorded["content_text"] == "hello"
    assert recorded["identity"]["company_id"] == "company_1"


@pytest.mark.asyncio
async def test_record_runtime_event_schedules_history_writer(adapter):
    class FakeWriter:
        def __init__(self):
            self.calls = []

        def record_event(self, context, event):
            self.calls.append((context, event))

    writer = FakeWriter()
    adapter._runtime_history_writer = writer
    adapter._run_event_normalizers["run_1"] = RuntimeEventNormalizer(
        run_id="run_1",
        identity=RuntimeIdentityContext(company_id="company_1"),
    )
    adapter._run_contexts["run_1"] = RuntimeRunContext(
        run_id="run_1",
        company_id="company_1",
        channel="api_server",
        channel_conversation_key="session-key",
        raw_channel_key="session_1",
        hermes_session_id="session_1",
        session_key="session-key",
    )
    adapter._run_loops["run_1"] = asyncio.get_running_loop()
    adapter._run_event_locks["run_1"] = threading.Lock()

    adapter._record_runtime_event(
        "run_1",
        {
            "event": "run.completed",
            "run_id": "run_1",
            "output": "done",
            "usage": {"total_tokens": 5},
        },
    )

    for _ in range(20):
        if writer.calls:
            break
        await asyncio.sleep(0.01)

    assert len(writer.calls) == 1
    context, event = writer.calls[0]
    assert context.company_id == "company_1"
    assert event.event_type == "run.completed"
    assert event.sequence == 1
    assert event.idempotency_key == "run_1:1:run.completed"


# ---------------------------------------------------------------------------
# POST /v1/runs — start a run
# ---------------------------------------------------------------------------


class TestStartRun:
    @pytest.mark.asyncio
    async def test_start_returns_202(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent = MagicMock()
                mock_agent.run_conversation.return_value = {"final_response": "done"}
                mock_agent.session_prompt_tokens = 10
                mock_agent.session_completion_tokens = 5
                mock_agent.session_total_tokens = 15
                mock_create.return_value = mock_agent

                resp = await cli.post("/v1/runs", json={"input": "hello"})
                assert resp.status == 202
                data = await resp.json()
                assert data["status"] == "started"
                assert data["run_id"].startswith("run_")

                status_resp = await cli.get(f"/v1/runs/{data['run_id']}")
                assert status_resp.status == 200
                status = await status_resp.json()
                assert status["run_id"] == data["run_id"]
                assert status["status"] in {"queued", "running", "completed"}
                assert status["object"] == "hermes.run"

    @pytest.mark.asyncio
    async def test_start_invalid_json_returns_400(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/v1/runs",
                data="not json",
                headers={"Content-Type": "application/json"},
            )
        assert resp.status == 400

    @pytest.mark.asyncio
    async def test_start_missing_input_returns_400(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post("/v1/runs", json={"model": "test"})
            assert resp.status == 400
            data = await resp.json()
            assert "input" in data["error"]["message"]

    @pytest.mark.asyncio
    async def test_start_empty_input_returns_400(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post("/v1/runs", json={"input": ""})
        assert resp.status == 400

    @pytest.mark.asyncio
    async def test_start_invalid_history_does_not_allocate_run(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/v1/runs",
                json={"input": "hello", "conversation_history": {"role": "user"}},
            )
        assert resp.status == 400
        assert adapter._run_streams == {}
        assert adapter._run_statuses == {}

    @pytest.mark.asyncio
    async def test_start_requires_auth(self, auth_adapter):
        app = _create_runs_app(auth_adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post("/v1/runs", json={"input": "hello"})
        assert resp.status == 401

    @pytest.mark.asyncio
    async def test_start_with_valid_auth(self, auth_adapter):
        app = _create_runs_app(auth_adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(auth_adapter, "_create_agent") as mock_create:
                mock_agent = MagicMock()
                mock_agent.run_conversation.return_value = {"final_response": "ok"}
                mock_agent.session_prompt_tokens = 0
                mock_agent.session_completion_tokens = 0
                mock_agent.session_total_tokens = 0
                mock_create.return_value = mock_agent

                resp = await cli.post(
                    "/v1/runs",
                    json={"input": "hello"},
                    headers={"Authorization": "Bearer sk-secret"},
                )
                assert resp.status == 202

    @pytest.mark.asyncio
    async def test_enterprise_runtime_history_failure_blocks_local_cache_fallback(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with (
                patch.object(
                    adapter,
                    "_get_runtime_history_writer",
                    side_effect=RuntimeError("postgres unavailable"),
                ),
                patch.object(adapter, "_create_agent") as mock_create,
                patch.object(adapter, "_ensure_session_db") as mock_session_db,
            ):
                resp = await cli.post("/v1/runs", json={"input": "hello"})
                assert resp.status == 500
                data = await resp.json()

        assert data["error"]["code"] == "runtime_history_failed"
        assert "postgres unavailable" in data["error"]["message"]
        mock_create.assert_not_called()
        mock_session_db.assert_not_called()
        assert adapter._run_streams == {}
        assert adapter._run_contexts == {}

    @pytest.mark.asyncio
    async def test_start_requires_company_identity_when_identity_mode_enabled(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with (
                patch(
                    "gateway.company_identity.is_enterprise_identity_enabled",
                    return_value=True,
                ),
                patch.object(adapter, "_get_runtime_history_writer", return_value=None),
                patch.object(adapter, "_create_agent") as mock_create,
            ):
                resp = await cli.post("/v1/runs", json={"input": "hello"})
                data = await resp.json()

        assert resp.status == 401
        assert data["error"]["code"] == "company_auth_required"
        mock_create.assert_not_called()

    @pytest.mark.asyncio
    async def test_start_company_run_binds_identity_and_runtime_context(self, adapter):
        app = _create_runs_app(adapter)
        captured_env = {}
        bind_calls = []
        captured_context = {}

        class FakeWriter:
            def start_run(self, context):
                captured_context["context"] = context
                return "conv_1"

        async with TestClient(TestServer(app)) as cli:
            with (
                patch(
                    "gateway.company_identity.is_enterprise_identity_enabled",
                    return_value=True,
                ),
                patch(
                    "gateway.company_identity.get_session_identity",
                    return_value=None,
                ),
                patch(
                    "gateway.company_identity.bind_explicit_session_identity",
                    side_effect=lambda **kwargs: bind_calls.append(dict(kwargs)),
                ),
                patch.object(adapter, "_get_runtime_history_writer", return_value=FakeWriter()),
                patch.object(adapter, "_create_agent") as mock_create,
            ):
                mock_agent = MagicMock()

                def _run_conversation(*, user_message=None, conversation_history=None, task_id=None):
                    from gateway.session_context import get_session_env

                    for key in (
                        "HERMES_SESSION_KEY",
                        "HERMES_COMPANY_ID",
                        "HERMES_COMPANY_USER_ID",
                        "HERMES_CHANNEL_IDENTITY_ID",
                        "HERMES_COMPANY_ROLE",
                        "HERMES_DEPARTMENT_ID",
                    ):
                        captured_env[key] = get_session_env(key)
                    return {"final_response": "done"}

                mock_agent.run_conversation.side_effect = _run_conversation
                mock_agent.session_prompt_tokens = 3
                mock_agent.session_completion_tokens = 2
                mock_agent.session_total_tokens = 5
                mock_create.return_value = mock_agent

                resp = await cli.post(
                    "/v1/runs",
                    json={
                        "input": "hello",
                        "session_id": "session-alice",
                        "session_key": "desktop-session-key",
                        "company_id": "company_1",
                        "company_user_id": "cu_alice",
                        "channel_identity_id": "ci_alice",
                        "company_role": "ADMIN",
                        "department_id": "dept_ops",
                    },
                )
                assert resp.status == 202
                data = await resp.json()
                run_id = data["run_id"]

                for _ in range(20):
                    status_resp = await cli.get(f"/v1/runs/{run_id}")
                    status = await status_resp.json()
                    if status["status"] == "completed":
                        break
                    await asyncio.sleep(0.05)

        context = captured_context["context"]
        assert context.company_id == "company_1"
        assert context.created_by_user_id == "cu_alice"
        assert context.channel_identity_id == "ci_alice"
        assert context.session_key == "desktop-session-key"
        assert context.hermes_session_id == "session-alice"
        assert context.raw_channel_key == "session-alice"

        mock_create.assert_called_once()
        assert mock_create.call_args.kwargs["session_id"] == "session-alice"
        assert (
            mock_create.call_args.kwargs["gateway_session_key"]
            == "desktop-session-key"
        )
        mock_agent.run_conversation.assert_called_once()
        assert mock_agent.run_conversation.call_args.kwargs["task_id"] == "session-alice"

        assert captured_env == {
            "HERMES_SESSION_KEY": "desktop-session-key",
            "HERMES_COMPANY_ID": "company_1",
            "HERMES_COMPANY_USER_ID": "cu_alice",
            "HERMES_CHANNEL_IDENTITY_ID": "ci_alice",
            "HERMES_COMPANY_ROLE": "ADMIN",
            "HERMES_DEPARTMENT_ID": "dept_ops",
        }
        assert bind_calls == [
            {
                "session_id": "session-alice",
                "session_key": "desktop-session-key",
                "company_id": "company_1",
                "company_user_id": "cu_alice",
                "channel_identity_id": "ci_alice",
                "company_role": "ADMIN",
                "department_id": "dept_ops",
                "platform": "api_server",
                "chat_id": "session-alice",
                "binding_source": "api_server",
            }
        ]

    @pytest.mark.asyncio
    async def test_start_company_run_rejects_session_bound_to_other_user(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with (
                patch(
                    "gateway.company_identity.is_enterprise_identity_enabled",
                    return_value=True,
                ),
                patch(
                    "gateway.company_identity.get_session_identity",
                    return_value={
                        "company_id": "company_1",
                        "company_user_id": "cu_alice",
                    },
                ),
                patch.object(adapter, "_get_runtime_history_writer", return_value=None),
                patch.object(adapter, "_create_agent") as mock_create,
            ):
                resp = await cli.post(
                    "/v1/runs",
                    json={
                        "input": "hello",
                        "session_id": "shared-session",
                        "company_id": "company_1",
                        "company_user_id": "cu_bob",
                        "channel_identity_id": "ci_bob",
                    },
                )
                data = await resp.json()

        assert resp.status == 404
        assert data["error"]["code"] == "session_not_found"
        mock_create.assert_not_called()

    @pytest.mark.asyncio
    async def test_start_with_previous_response_id_reuses_session_and_history(self, adapter):
        app = _create_runs_app(adapter)
        adapter._response_store.put(
            "resp_prev",
            {
                "conversation_history": [
                    {"role": "user", "content": "before"},
                    {"role": "assistant", "content": "after"},
                ],
                "instructions": "carry me",
                "session_id": "persisted-session",
            },
        )

        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent = MagicMock()
                mock_agent.run_conversation.return_value = {"final_response": "done"}
                mock_agent.session_prompt_tokens = 0
                mock_agent.session_completion_tokens = 0
                mock_agent.session_total_tokens = 0
                mock_create.return_value = mock_agent

                resp = await cli.post(
                    "/v1/runs",
                    json={"input": "hello", "previous_response_id": "resp_prev"},
                )
                assert resp.status == 202
                data = await resp.json()
                run_id = data["run_id"]

                for _ in range(20):
                    status_resp = await cli.get(f"/v1/runs/{run_id}")
                    status = await status_resp.json()
                    if status["status"] == "completed":
                        break
                    await asyncio.sleep(0.05)

                mock_create.assert_called_once()
                assert mock_create.call_args.kwargs["ephemeral_system_prompt"] == "carry me"
                assert mock_create.call_args.kwargs["session_id"] == "persisted-session"
                mock_agent.run_conversation.assert_called_once()
                assert mock_agent.run_conversation.call_args.kwargs["conversation_history"] == [
                    {"role": "user", "content": "before"},
                    {"role": "assistant", "content": "after"},
                ]
                assert mock_agent.run_conversation.call_args.kwargs["task_id"] == "persisted-session"


# ---------------------------------------------------------------------------
# GET /v1/runs/{run_id} — poll run status
# ---------------------------------------------------------------------------


class TestRunStatus:
    @pytest.mark.asyncio
    async def test_status_completed_run_includes_output_and_usage(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent = MagicMock()
                mock_agent.run_conversation.return_value = {"final_response": "done"}
                mock_agent.session_prompt_tokens = 4
                mock_agent.session_completion_tokens = 2
                mock_agent.session_total_tokens = 6
                mock_create.return_value = mock_agent

                resp = await cli.post("/v1/runs", json={"input": "hello"})
                data = await resp.json()
                run_id = data["run_id"]

                for _ in range(20):
                    status_resp = await cli.get(f"/v1/runs/{run_id}")
                    assert status_resp.status == 200
                    status = await status_resp.json()
                    if status["status"] == "completed":
                        break
                    await asyncio.sleep(0.05)

                assert status["status"] == "completed"
                assert status["output"] == "done"
                assert status["usage"]["total_tokens"] == 6
                assert status["last_event"] == "run.completed"

    @pytest.mark.asyncio
    async def test_status_reflects_explicit_session_id(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent = MagicMock()
                mock_agent.run_conversation.return_value = {"final_response": "done"}
                mock_agent.session_prompt_tokens = 0
                mock_agent.session_completion_tokens = 0
                mock_agent.session_total_tokens = 0
                mock_create.return_value = mock_agent

                resp = await cli.post(
                    "/v1/runs",
                    json={"input": "hello", "session_id": "space-session"},
                )
                data = await resp.json()
                run_id = data["run_id"]

                for _ in range(20):
                    status_resp = await cli.get(f"/v1/runs/{run_id}")
                    status = await status_resp.json()
                    if status["status"] == "completed":
                        break
                    await asyncio.sleep(0.05)

                mock_agent.run_conversation.assert_called_once()
                assert mock_agent.run_conversation.call_args.kwargs["task_id"] == "space-session"
                assert status["session_id"] == "space-session"

    @pytest.mark.asyncio
    async def test_status_not_found_returns_404(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/v1/runs/run_nonexistent")
        assert resp.status == 404

    @pytest.mark.asyncio
    async def test_status_requires_auth(self, auth_adapter):
        app = _create_runs_app(auth_adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/v1/runs/run_any")
        assert resp.status == 401


# ---------------------------------------------------------------------------
# GET /v1/runs/{run_id}/events — SSE event stream
# ---------------------------------------------------------------------------


class TestRunEvents:
    @pytest.mark.asyncio
    async def test_events_stream_returns_completed(self, adapter):
        """Events stream should receive run.completed when agent finishes."""
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent = MagicMock()
                mock_agent.run_conversation.return_value = {"final_response": "Hello!"}
                mock_agent.session_prompt_tokens = 10
                mock_agent.session_completion_tokens = 5
                mock_agent.session_total_tokens = 15
                mock_create.return_value = mock_agent

                # Start run
                resp = await cli.post("/v1/runs", json={"input": "hello"})
                assert resp.status == 202
                data = await resp.json()
                run_id = data["run_id"]

                # Subscribe to events
                events_resp = await cli.get(f"/v1/runs/{run_id}/events")
                assert events_resp.status == 200
                body = await events_resp.text()

                # Should contain run.completed
                assert "run.completed" in body
                assert "Hello!" in body

    @pytest.mark.asyncio
    async def test_events_stream_replays_buffered_events_and_supports_last_event_id(self, adapter):
        run_id = "run_replay"
        _seed_run_events(
            adapter,
            run_id,
            [
                {"event": "message.delta", "run_id": run_id, "timestamp": 1.0, "delta": "hello"},
                {
                    "event": "run.completed",
                    "run_id": run_id,
                    "timestamp": 2.0,
                    "output": "done",
                    "usage": {"total_tokens": 1},
                },
            ],
        )
        app = _create_runs_app(adapter)

        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get(f"/v1/runs/{run_id}/events")
            assert resp.status == 200
            body = await resp.text()
            assert "id: 1" in body
            assert "id: 2" in body
            assert "run.completed" in body
            assert "stream closed" in body

            resume_resp = await cli.get(
                f"/v1/runs/{run_id}/events",
                headers={"Last-Event-ID": "1"},
            )
            assert resume_resp.status == 200
            resume_body = await resume_resp.text()
            assert "id: 1" not in resume_body
            assert "id: 2" in resume_body
            assert resume_body.count("run.completed") == 1

    @pytest.mark.asyncio
    async def test_events_stream_rejects_invalid_cursor(self, adapter):
        run_id = "run_bad_cursor"
        _seed_run_events(
            adapter,
            run_id,
            [
                {
                    "event": "run.completed",
                    "run_id": run_id,
                    "timestamp": 1.0,
                    "output": "done",
                }
            ],
        )
        app = _create_runs_app(adapter)

        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get(
                f"/v1/runs/{run_id}/events",
                headers={"Last-Event-ID": "not-an-int"},
            )
            assert resp.status == 400
            data = await resp.json()
            assert data["error"]["code"] == "invalid_event_cursor"



    @pytest.mark.asyncio
    async def test_approval_response_without_pending_returns_409(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent = MagicMock()
                mock_agent.run_conversation.return_value = {"final_response": "done"}
                mock_agent.session_prompt_tokens = 0
                mock_agent.session_completion_tokens = 0
                mock_agent.session_total_tokens = 0
                mock_create.return_value = mock_agent

                resp = await cli.post("/v1/runs", json={"input": "hello"})
                data = await resp.json()
                run_id = data["run_id"]

                approval_resp = await cli.post(
                    f"/v1/runs/{run_id}/approval",
                    json={"choice": "once"},
                )
                assert approval_resp.status == 409
                approval_data = await approval_resp.json()
                assert approval_data["error"]["code"] in {
                    "approval_not_active",
                    "approval_not_pending",
                }

    @pytest.mark.asyncio
    async def test_approval_string_false_does_not_resolve_all(self, adapter):
        """Quoted false must not fan out approval resolution across the queue."""
        app = _create_runs_app(adapter)
        run_id = "run_bool_parse"
        adapter._run_statuses[run_id] = {"run_id": run_id, "status": "running"}
        adapter._run_approval_sessions[run_id] = "session-123"

        async with TestClient(TestServer(app)) as cli:
            with patch("tools.approval.resolve_gateway_approval", return_value=1) as mock_resolve:
                approval_resp = await cli.post(
                    f"/v1/runs/{run_id}/approval",
                    json={"choice": "once", "all": "false"},
                )

        assert approval_resp.status == 200
        mock_resolve.assert_called_once_with(
            "session-123",
            "once",
            resolve_all=False,
        )

    @pytest.mark.asyncio
    async def test_approval_response_records_replayable_event(self, adapter):
        app = _create_runs_app(adapter)
        run_id = "run_approval_ok"
        adapter._run_streams[run_id] = True
        adapter._run_streams_created[run_id] = time.time()
        adapter._run_statuses[run_id] = {
            "object": "hermes.run",
            "run_id": run_id,
            "status": "waiting_for_approval",
            "updated_at": time.time(),
        }
        adapter._run_approval_sessions[run_id] = "session-123"
        adapter._run_event_normalizers[run_id] = RuntimeEventNormalizer(
            run_id=run_id,
            identity=RuntimeIdentityContext(company_id="company_1"),
        )
        adapter._run_event_locks[run_id] = threading.Lock()

        async with TestClient(TestServer(app)) as cli:
            with patch("tools.approval.resolve_gateway_approval", return_value=1):
                approval_resp = await cli.post(
                    f"/v1/runs/{run_id}/approval",
                    json={"choice": "approve"},
                )

                assert approval_resp.status == 200
                approval_data = await approval_resp.json()
                assert approval_data["choice"] == "once"
                assert approval_data["resolved"] == 1

                adapter._run_statuses[run_id]["status"] = "completed"
                adapter._run_statuses[run_id]["updated_at"] = time.time()

                events_resp = await cli.get(f"/v1/runs/{run_id}/events")
                assert events_resp.status == 200
                body = await events_resp.text()
                assert "approval.responded" in body
                assert '"choice": "once"' in body

    @pytest.mark.asyncio
    async def test_events_not_found_returns_404(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/v1/runs/run_nonexistent/events")
        assert resp.status == 404

    @pytest.mark.asyncio
    async def test_events_requires_auth(self, auth_adapter):
        app = _create_runs_app(auth_adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/v1/runs/run_any/events")
        assert resp.status == 401


# ---------------------------------------------------------------------------
# POST /v1/runs/{run_id}/stop — interrupt a running agent
# ---------------------------------------------------------------------------


class TestStopRun:
    @pytest.mark.asyncio
    async def test_stop_running_agent(self, adapter):
        """Stop should interrupt the agent and cancel the task."""
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent, agent_ready, _ = _make_slow_agent()
                mock_create.return_value = mock_agent

                # Start run
                resp = await cli.post("/v1/runs", json={"input": "hello"})
                assert resp.status == 202
                data = await resp.json()
                run_id = data["run_id"]

                # Wait for agent to start running in the thread
                agent_ready.wait(timeout=3.0)
                await asyncio.sleep(0.1)

                # Verify agent ref is stored
                assert run_id in adapter._active_run_agents

                # Stop the run
                stop_resp = await cli.post(f"/v1/runs/{run_id}/stop")
                assert stop_resp.status == 200
                stop_data = await stop_resp.json()
                assert stop_data["run_id"] == run_id
                assert stop_data["status"] == "stopping"

                # Agent interrupt should have been called
                mock_agent.interrupt.assert_called_once_with("Stop requested via API")

                status_resp = await cli.get(f"/v1/runs/{run_id}")
                assert status_resp.status == 200
                status_data = await status_resp.json()
                assert status_data["status"] in {"stopping", "cancelled"}

                # Refs should be cleaned up
                await asyncio.sleep(0.5)
                assert run_id not in adapter._active_run_agents
                assert run_id not in adapter._active_run_tasks

    @pytest.mark.asyncio
    async def test_stop_nonexistent_run_returns_404(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post("/v1/runs/run_nonexistent/stop")
        assert resp.status == 404

    @pytest.mark.asyncio
    async def test_stop_requires_auth(self, auth_adapter):
        app = _create_runs_app(auth_adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post("/v1/runs/run_any/stop")
        assert resp.status == 401

    @pytest.mark.asyncio
    async def test_stop_already_completed_run_returns_404(self, adapter):
        """Stopping a run that already finished should return 404 (refs cleaned up)."""
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent = MagicMock()
                mock_agent.run_conversation.return_value = {"final_response": "done"}
                mock_agent.session_prompt_tokens = 0
                mock_agent.session_completion_tokens = 0
                mock_agent.session_total_tokens = 0
                mock_create.return_value = mock_agent

                # Start and wait for completion
                resp = await cli.post("/v1/runs", json={"input": "hello"})
                assert resp.status == 202
                data = await resp.json()
                run_id = data["run_id"]

                await asyncio.sleep(0.3)

                # Run should be done, refs cleaned up
                assert run_id not in adapter._active_run_agents

                # Stop should return 404
                stop_resp = await cli.post(f"/v1/runs/{run_id}/stop")
                assert stop_resp.status == 404

    @pytest.mark.asyncio
    async def test_stop_interrupt_exception_does_not_crash(self, adapter):
        """If agent.interrupt() raises, stop should still succeed."""
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent, agent_ready, interrupted = _make_slow_agent()

                # Override the interrupt side_effect to raise. Still trip
                # ``interrupted`` so the slow_run thread unblocks at teardown
                # — without this the agent thread blocks the full 10s
                # timeout and the test teardown waits the same amount.
                def _raising_interrupt(message=None):
                    interrupted.set()
                    raise RuntimeError("interrupt failed")

                mock_agent.interrupt = MagicMock(side_effect=_raising_interrupt)
                mock_create.return_value = mock_agent

                resp = await cli.post("/v1/runs", json={"input": "hello"})
                assert resp.status == 202
                data = await resp.json()
                run_id = data["run_id"]

                agent_ready.wait(timeout=3.0)
                await asyncio.sleep(0.1)

                stop_resp = await cli.post(f"/v1/runs/{run_id}/stop")
                assert stop_resp.status == 200
                stop_data = await stop_resp.json()
                assert stop_data["status"] == "stopping"

    @pytest.mark.asyncio
    async def test_stop_sends_sentinel_to_events_stream(self, adapter):
        """After stop, the events stream should close."""
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent, agent_ready, _ = _make_slow_agent()
                mock_create.return_value = mock_agent

                # Start run
                resp = await cli.post("/v1/runs", json={"input": "hello"})
                assert resp.status == 202
                data = await resp.json()
                run_id = data["run_id"]

                agent_ready.wait(timeout=3.0)
                await asyncio.sleep(0.1)

                # Subscribe to events in background
                events_task = asyncio.ensure_future(
                    cli.get(f"/v1/runs/{run_id}/events")
                )

                await asyncio.sleep(0.1)

                # Stop the run
                stop_resp = await cli.post(f"/v1/runs/{run_id}/stop")
                assert stop_resp.status == 200

                # Events stream should close
                events_resp = await asyncio.wait_for(events_task, timeout=5.0)
                assert events_resp.status == 200
                body = await events_resp.text()
                # Stream should have received run.failed and closed
                assert "run.failed" in body or "stream closed" in body

    @pytest.mark.asyncio
    async def test_stop_replays_cancelled_event_after_run_finishes(self, adapter):
        app = _create_runs_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            with patch.object(adapter, "_create_agent") as mock_create:
                mock_agent, agent_ready, _ = _make_slow_agent()
                mock_create.return_value = mock_agent

                resp = await cli.post("/v1/runs", json={"input": "hello"})
                assert resp.status == 202
                data = await resp.json()
                run_id = data["run_id"]

                agent_ready.wait(timeout=3.0)
                await asyncio.sleep(0.1)

                stop_resp = await cli.post(f"/v1/runs/{run_id}/stop")
                assert stop_resp.status == 200

                for _ in range(30):
                    status_resp = await cli.get(f"/v1/runs/{run_id}")
                    status_data = await status_resp.json()
                    if status_data["status"] == "cancelled":
                        break
                    await asyncio.sleep(0.05)

                events_resp = await cli.get(f"/v1/runs/{run_id}/events")
                assert events_resp.status == 200
                body = await events_resp.text()
                assert "run.cancelled" in body
                assert "stream closed" in body
