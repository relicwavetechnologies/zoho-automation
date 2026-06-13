import pytest

from enterprise.session_repository import CompanySessionScope, EnterpriseSessionRepository
from tests.enterprise.memory_pg import MemoryEnterpriseConnection, seed_company_session


@pytest.fixture
def memory_conn():
    return MemoryEnterpriseConnection()


@pytest.fixture
def repo(memory_conn):
    return EnterpriseSessionRepository(memory_conn)


def test_list_and_messages_are_scoped_per_company_user(repo, memory_conn):
    seed_company_session(
        memory_conn,
        company_id="company_1",
        company_user_id="cu_alice",
        channel_identity_id="ci_alice",
        session_id="alice-session",
        messages=[("user", "alice history")],
    )
    seed_company_session(
        memory_conn,
        company_id="company_1",
        company_user_id="cu_bob",
        channel_identity_id="ci_bob",
        session_id="bob-session",
        messages=[("user", "bob history")],
    )

    alice_scope = CompanySessionScope(
        company_id="company_1",
        company_user_id="cu_alice",
        channel_identity_id="ci_alice",
    )
    bob_scope = CompanySessionScope(
        company_id="company_1",
        company_user_id="cu_bob",
        channel_identity_id="ci_bob",
    )

    alice_rows, alice_total = repo.list_sessions_for_user(alice_scope)
    bob_rows, bob_total = repo.list_sessions_for_user(bob_scope)

    assert alice_total == 1
    assert [row["id"] for row in alice_rows] == ["alice-session"]
    assert bob_total == 1
    assert [row["id"] for row in bob_rows] == ["bob-session"]

    assert repo.get_session_for_user(bob_scope, "alice-session") is None
    assert repo.list_messages_for_session(bob_scope, "alice-session") == []

    alice_messages = repo.list_messages_for_session(alice_scope, "alice-session")
    assert len(alice_messages) == 1
    assert alice_messages[0]["role"] == "user"
    assert alice_messages[0]["content"] == "alice history"


def test_append_messages_only_writes_new_rows(repo, memory_conn):
    scope = CompanySessionScope(
        company_id="company_1",
        company_user_id="cu_alice",
        channel_identity_id="ci_alice",
    )
    seed_company_session(
        memory_conn,
        company_id="company_1",
        company_user_id="cu_alice",
        channel_identity_id="ci_alice",
        session_id="alice-session",
        messages=[("user", "first")],
    )

    repo.append_session_messages(
        scope,
        "alice-session",
        [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "second"},
        ],
        start_idx=1,
        platform="tui",
    )

    messages = repo.list_messages_for_session(scope, "alice-session")
    assert [message["content"] for message in messages] == ["first", "second"]


def test_missing_company_identity_raises(repo):
    with pytest.raises(ValueError, match="company_id"):
        repo.list_sessions_for_user(
            CompanySessionScope(company_id="", company_user_id="cu_alice")
        )
