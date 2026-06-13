"""Hermetic two-user company isolation smoke.

This intentionally does not use production users, cookies, or tokens. It
simulates Abhishek Verma and Anish Suman as separate Lark-authenticated
employees and calls the same dashboard `/api/sessions*` routes the web/desktop
clients use.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from company_identity import CompanyIdentityDB
from gateway import company_identity as gateway_company_identity
from hermes_cli import web_server
from hermes_cli.dashboard_auth import clear_providers, register_provider
from hermes_cli.dashboard_auth.base import (
    DashboardAuthProvider,
    InvalidCredentialsError,
    LoginStart,
    Session,
)

pytestmark = pytest.mark.xdist_group("dashboard_auth_app_state")

COMPANY_ID = "company_hermes"
PASSWORD = "smoke-password"


@dataclass(frozen=True)
class SmokeUser:
    username: str
    user_id: str
    email: str
    display_name: str
    session_id: str
    message: str


ABHISHEK = SmokeUser(
    username="abhishek",
    user_id="ou_smoke_abhishek",
    email="abhishek.smoke@example.test",
    display_name="Abhishek Verma",
    session_id="smoke-abhishek-session",
    message="abhishek private history",
)
ANISH = SmokeUser(
    username="anish",
    user_id="ou_smoke_anish",
    email="anish.suman.smoke@example.test",
    display_name="Anish Suman",
    session_id="smoke-anish-session",
    message="anish private history",
)


class SmokeLarkPasswordProvider(DashboardAuthProvider):
    name = "lark"
    display_name = "Lark Smoke"
    supports_password = True

    def __init__(self, users: tuple[SmokeUser, ...]):
        self._users = {user.username: user for user in users}
        self._access_sessions: dict[str, Session] = {}
        self._refresh_sessions: dict[str, Session] = {}

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        raise NotImplementedError("smoke provider uses password login only")

    def complete_login(
        self,
        *,
        code: str,
        state: str,
        code_verifier: str,
        redirect_uri: str,
    ) -> Session:
        raise NotImplementedError("smoke provider uses password login only")

    def complete_password_login(self, *, username: str, password: str) -> Session:
        user = self._users.get(username)
        if user is None or password != PASSWORD:
            raise InvalidCredentialsError()
        expires_at = int(time.time()) + 3600
        session = Session(
            user_id=user.user_id,
            email=user.email,
            display_name=user.display_name,
            org_id="tenant_smoke",
            provider=self.name,
            expires_at=expires_at,
            access_token=f"smoke-access-{user.user_id}",
            refresh_token=f"smoke-refresh-{user.user_id}",
        )
        self._access_sessions[session.access_token] = session
        self._refresh_sessions[session.refresh_token] = session
        return session

    def verify_session(self, *, access_token: str) -> Session | None:
        return self._access_sessions.get(access_token)

    def refresh_session(self, *, refresh_token: str) -> Session:
        session = self._refresh_sessions.get(refresh_token)
        if session is None:
            raise InvalidCredentialsError()
        return session

    def revoke_session(self, *, refresh_token: str) -> None:
        session = self._refresh_sessions.pop(refresh_token, None)
        if session is not None:
            self._access_sessions.pop(session.access_token, None)


@pytest.fixture
def smoke_company_auth(tmp_path, monkeypatch):
    clear_providers()
    register_provider(SmokeLarkPasswordProvider((ABHISHEK, ANISH)))
    monkeypatch.setenv("HERMES_COMPANY_ID", COMPANY_ID)
    monkeypatch.delenv("HERMES_ENTERPRISE_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("HERMES_ENTERPRISE_POSTGRES", raising=False)

    prev_host = getattr(web_server.app.state, "bound_host", None)
    prev_port = getattr(web_server.app.state, "bound_port", None)
    prev_required = getattr(web_server.app.state, "auth_required", None)
    prev_db = gateway_company_identity._identity_db
    prev_enterprise = gateway_company_identity._enterprise_identity_store

    identity_db = CompanyIdentityDB(tmp_path / "company.db")
    gateway_company_identity._identity_db = identity_db
    gateway_company_identity._enterprise_identity_store = None
    import hermes_state
    from hermes_constants import get_hermes_home

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")
    web_server.app.state.bound_host = "hermes.example.com"
    web_server.app.state.bound_port = 443
    web_server.app.state.auth_required = True

    identities = {}
    for user in (ABHISHEK, ANISH):
        identities[user.username] = gateway_company_identity.resolve_dashboard_session_identity(
            provider="lark",
            provider_user_id=user.user_id,
            display_name=user.display_name,
            email=user.email,
            company_id=COMPANY_ID,
            db=identity_db,
        )

    try:
        yield identity_db, identities
    finally:
        clear_providers()
        identity_db.close()
        gateway_company_identity._identity_db = prev_db
        gateway_company_identity._enterprise_identity_store = prev_enterprise
        web_server.app.state.bound_host = prev_host
        web_server.app.state.bound_port = prev_port
        web_server.app.state.auth_required = prev_required


def _login(user: SmokeUser) -> TestClient:
    client = TestClient(web_server.app, base_url="https://hermes.example.com")
    response = client.post(
        "/auth/password-login",
        json={
            "provider": "lark",
            "username": user.username,
            "password": PASSWORD,
        },
    )
    assert response.status_code == 200, response.text
    return client


def _bind_sqlite_session(identity_db: CompanyIdentityDB, identities, user: SmokeUser) -> None:
    from hermes_state import SessionDB

    db = SessionDB()
    try:
        db.create_session(session_id=user.session_id, source="desktop")
        db.append_message(session_id=user.session_id, role="user", content=user.message)
    finally:
        db.close()

    identity = identities[user.username]
    gateway_company_identity.bind_explicit_session_identity(
        session_id=user.session_id,
        session_key=user.session_id,
        company_id=identity.company_id,
        company_user_id=identity.company_user_id,
        channel_identity_id=identity.channel_identity_id,
        company_role=identity.company_role,
        department_id=identity.department_id,
        platform="desktop",
        chat_id=user.session_id,
        db=identity_db,
    )


def _assert_only_session(client: TestClient, expected_id: str) -> None:
    listing = client.get("/api/sessions?limit=20&offset=0")
    assert listing.status_code == 200, listing.text
    assert [row["id"] for row in listing.json()["sessions"]] == [expected_id]


def _assert_cannot_read(client: TestClient, forbidden_id: str) -> None:
    for path in (
        f"/api/sessions/{forbidden_id}",
        f"/api/sessions/{forbidden_id}/messages",
        f"/api/sessions/{forbidden_id}/export",
        f"/api/sessions/{forbidden_id}/latest-descendant",
    ):
        response = client.get(path)
        assert response.status_code == 404, f"{path} leaked: {response.text}"


def test_sqlite_company_sessions_are_isolated_between_abhishek_and_anish(smoke_company_auth):
    identity_db, identities = smoke_company_auth
    for user in (ABHISHEK, ANISH):
        _bind_sqlite_session(identity_db, identities, user)

    abhishek_client = _login(ABHISHEK)
    anish_client = _login(ANISH)

    _assert_only_session(abhishek_client, ABHISHEK.session_id)
    _assert_only_session(anish_client, ANISH.session_id)

    own_messages = abhishek_client.get(f"/api/sessions/{ABHISHEK.session_id}/messages")
    assert own_messages.status_code == 200
    assert own_messages.json()["messages"][0]["content"] == ABHISHEK.message

    _assert_cannot_read(abhishek_client, ANISH.session_id)
    _assert_cannot_read(anish_client, ABHISHEK.session_id)

    rename = abhishek_client.patch(
        f"/api/sessions/{ANISH.session_id}",
        json={"title": "should not rename"},
    )
    assert rename.status_code == 404

    delete = abhishek_client.delete(f"/api/sessions/{ANISH.session_id}")
    assert delete.status_code == 404

    bulk = abhishek_client.post(
        "/api/sessions/bulk-delete",
        json={"ids": [ABHISHEK.session_id, ANISH.session_id]},
    )
    assert bulk.status_code == 404
    _assert_only_session(abhishek_client, ABHISHEK.session_id)
    _assert_only_session(anish_client, ANISH.session_id)


def test_enterprise_company_sessions_are_isolated_between_abhishek_and_anish(
    smoke_company_auth,
    monkeypatch,
):
    identity_db, identities = smoke_company_auth

    from enterprise.session_repository import EnterpriseSessionRepository
    from enterprise.session_store import DashboardCompanyIdentity, EnterpriseSessionBackend
    from tests.enterprise.memory_pg import MemoryEnterpriseConnection, seed_company_session

    memory = MemoryEnterpriseConnection()
    for user in (ABHISHEK, ANISH):
        identity = identities[user.username]
        seed_company_session(
            memory,
            company_id=identity.company_id,
            company_user_id=identity.company_user_id,
            channel_identity_id=identity.channel_identity_id,
            session_id=user.session_id,
            messages=[("user", user.message)],
        )

    def _dashboard_identity(request):
        sess = getattr(request.state, "session", None)
        if sess is None:
            return None
        row = gateway_company_identity.find_dashboard_company_user(
            provider=getattr(sess, "provider", "") or "",
            provider_user_id=getattr(sess, "user_id", "") or "",
            company_id=COMPANY_ID,
            db=identity_db,
        )
        if not row:
            return None
        return DashboardCompanyIdentity(
            company_id=COMPANY_ID,
            company_user_id=str(row["id"]),
            channel_identity_id=str(row.get("channel_identity_id") or ""),
            company_role=str(row.get("role") or "MEMBER"),
            department_id=str(row.get("department_id") or ""),
        )

    def _session_backend(request):
        identity = _dashboard_identity(request)
        assert identity is not None
        return EnterpriseSessionBackend(identity, EnterpriseSessionRepository(memory))

    monkeypatch.setattr(
        "enterprise.session_store.company_enterprise_session_mode",
        _dashboard_identity,
    )
    monkeypatch.setattr("enterprise.session_store.get_session_backend", _session_backend)

    abhishek_client = _login(ABHISHEK)
    anish_client = _login(ANISH)

    _assert_only_session(abhishek_client, ABHISHEK.session_id)
    _assert_only_session(anish_client, ANISH.session_id)

    own_messages = anish_client.get(f"/api/sessions/{ANISH.session_id}/messages")
    assert own_messages.status_code == 200
    assert own_messages.json()["messages"][0]["content"] == ANISH.message

    cross_detail = abhishek_client.get(f"/api/sessions/{ANISH.session_id}")
    assert cross_detail.status_code == 404
    cross_messages = anish_client.get(f"/api/sessions/{ABHISHEK.session_id}/messages")
    assert cross_messages.status_code == 404

    from hermes_state import SessionDB

    sqlite = SessionDB()
    try:
        assert sqlite.get_session(ABHISHEK.session_id) is None
        assert sqlite.get_session(ANISH.session_id) is None
    finally:
        sqlite.close()
