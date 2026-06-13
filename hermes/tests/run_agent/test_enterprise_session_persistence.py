from unittest.mock import MagicMock

import pytest

from enterprise.session_repository import CompanySessionScope


class _FakeAgent:
    def __init__(self):
        self.session_id = "session-enterprise"
        self.platform = "tui"
        self._session_db = MagicMock()
        self._session_db_created = False
        self._last_flushed_db_idx = 0

    def _apply_persist_user_message_override(self, messages):
        return None


def test_flush_messages_to_enterprise_store_skips_sqlite(monkeypatch):
    from run_agent import AIAgent

    agent = _FakeAgent()
    append_calls = []

    scope = CompanySessionScope(
        company_id="company_1",
        company_user_id="cu_alice",
        channel_identity_id="ci_alice",
    )

    agent._use_enterprise_session_store = lambda: True
    agent._enterprise_session_scope = lambda: scope
    agent._ensure_enterprise_session_metadata = lambda: setattr(agent, "_session_db_created", True)

    class _Repo:
        def append_session_messages(self, received_scope, session_id, messages, start_idx=0, platform="tui"):
            append_calls.append((received_scope, session_id, messages, start_idx, platform))

    monkeypatch.setattr(
        "enterprise.session_store.get_enterprise_session_repository",
        lambda: _Repo(),
    )

    messages = [{"role": "user", "content": "hello"}]
    AIAgent._flush_messages_to_enterprise_store(agent, messages)

    assert append_calls
    assert append_calls[0][1] == "session-enterprise"
    agent._session_db.append_message.assert_not_called()


def test_flush_messages_to_session_store_uses_sqlite_in_local_mode(monkeypatch):
    from run_agent import AIAgent

    agent = _FakeAgent()
    called = {"sqlite": False}

    agent._use_enterprise_session_store = lambda: False
    agent._flush_messages_to_session_db = (
        lambda messages, conversation_history=None: called.__setitem__("sqlite", True)
    )

    AIAgent._flush_messages_to_session_store(agent, [{"role": "user", "content": "hello"}])

    assert called["sqlite"] is True
