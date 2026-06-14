"""Lark OAuth flow coverage for the Hermes dashboard auth gate."""

from __future__ import annotations

import json
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from unittest.mock import MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from company_identity import CompanyIdentityDB
from hermes_cli import web_server
from hermes_cli.dashboard_auth import clear_providers, register_provider
from gateway import company_identity as gateway_company_identity
from plugins.dashboard_auth.lark import LarkDashboardAuthProvider

pytestmark = pytest.mark.xdist_group("dashboard_auth_app_state")


def _mock_response(status_code: int, body):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.text = json.dumps(body)
    resp.json.return_value = body
    resp.headers = {"content-type": "application/json"}
    return resp


def _path_and_query(url: str) -> str:
    parsed = urlparse(url)
    return parsed.path + (f"?{parsed.query}" if parsed.query else "")


def _complete_lark_login(client: TestClient):
    start = client.get("/auth/login?provider=lark", follow_redirects=False)
    assert start.status_code == 302
    state = start.headers["location"].split("state=")[1].split("&", 1)[0]

    token_body = {
        "code": 0,
        "access_token": "u_access_test",
        "expires_in": 7200,
        "refresh_token": "u_refresh_test",
        "refresh_token_expires_in": 604800,
    }
    user_body = {
        "code": 0,
        "data": {
            "open_id": "ou_alice",
            "name": "Alice Example",
            "email": "alice@example.com",
            "tenant_key": "tenant_1",
        },
    }

    with patch(
        "plugins.dashboard_auth.lark.httpx.post",
        return_value=_mock_response(200, token_body),
    ):
        with patch(
            "plugins.dashboard_auth.lark.httpx.get",
            return_value=_mock_response(200, user_body),
        ):
            callback = client.get(
                f"/auth/callback?code=oauth_code&state={state}",
                follow_redirects=False,
            )

    assert callback.status_code == 302
    assert callback.headers["location"] == "/"
    return callback


class _FakeConnectorRepository:
    def __init__(self):
        self.upserts = []
        self.revocations = []
        self.rows = []

    def put_connector_credential(self, **kwargs):
        self.upserts.append(kwargs)
        credential_id = f"cc_{len(self.upserts)}"
        self.rows = [
            row
            for row in self.rows
            if not (
                row["provider"] == kwargs["provider"]
                and row.get("company_user_id") == (kwargs.get("company_user_id") or "")
                and row["scope"] == kwargs["scope"]
            )
        ]
        self.rows.append({
            "id": credential_id,
            "company_id": kwargs["company_id"],
            "company_user_id": kwargs.get("company_user_id") or "",
            "provider": kwargs["provider"],
            "scope": kwargs["scope"],
            "metadata": kwargs.get("metadata") or {},
            "status": "active",
            "created_at": "created",
            "updated_at": "updated",
            "revoked_at": None,
        })
        return credential_id

    def list_connector_credentials(self, *, company_id):
        return [row for row in self.rows if row["company_id"] == company_id]

    def revoke_connector_credentials(self, **kwargs):
        self.revocations.append(kwargs)
        count = 0
        for row in self.rows:
            if row["company_id"] != kwargs["company_id"]:
                continue
            if row["provider"] != kwargs["provider"]:
                continue
            if kwargs.get("company_user_id") and row.get("company_user_id") != kwargs["company_user_id"]:
                continue
            if kwargs.get("scope") and row.get("scope") != kwargs["scope"]:
                continue
            if row.get("revoked_at"):
                continue
            row["status"] = "revoked"
            row["revoked_at"] = "revoked"
            count += 1
        return count


@pytest.fixture
def gated_lark_client(tmp_path, monkeypatch):
    clear_providers()
    register_provider(
        LarkDashboardAuthProvider(
            app_id="cli_lark_app",
            app_secret="lark_secret",
        )
    )
    monkeypatch.setenv("HERMES_COMPANY_ID", "company_hermes")
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

    web_server.app.state.bound_host = "hermes.example.com"
    web_server.app.state.bound_port = 443
    web_server.app.state.auth_required = True

    client = TestClient(web_server.app, base_url="https://hermes.example.com")
    yield client, identity_db

    clear_providers()
    identity_db.close()
    gateway_company_identity._identity_db = prev_db
    gateway_company_identity._enterprise_identity_store = prev_enterprise
    web_server.app.state.bound_host = prev_host
    web_server.app.state.bound_port = prev_port
    web_server.app.state.auth_required = prev_required


def test_lark_login_sets_cookie_upserts_member_and_mints_ws_ticket(gated_lark_client):
    client, identity_db = gated_lark_client
    identity_db.upsert_dashboard_member(
        provider="lark",
        provider_user_id="ou_other",
        display_name="Other Tenant",
        email="other@example.com",
        company_id="company_other",
    )

    status = client.get("/api/status")
    assert status.status_code == 200
    assert status.json()["auth_required"] is True
    assert status.json()["auth_providers"] == ["lark"]

    login_page = client.get("/login")
    assert login_page.status_code == 200
    assert "Continue with Lark" in login_page.text
    assert "Lark workspace" in login_page.text

    start = client.get("/auth/login?provider=lark", follow_redirects=False)
    assert start.status_code == 302
    assert "accounts.larksuite.com" in start.headers["location"]
    callback = _complete_lark_login(client)
    set_cookies = callback.headers.get_list("set-cookie")
    assert any("hermes_session_at" in cookie for cookie in set_cookies)
    assert any("hermes_session_rt" in cookie for cookie in set_cookies)

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user_id"] == "ou_alice"
    assert me.json()["email"] == "alice@example.com"
    assert me.json()["display_name"] == "Alice Example"
    assert me.json()["provider"] == "lark"

    ticket = client.post("/api/auth/ws-ticket")
    assert ticket.status_code == 200
    assert ticket.json()["ticket"]

    company_me = client.get("/api/company/me")
    assert company_me.status_code == 200
    me_body = company_me.json()
    assert me_body["lark_open_id"] == "ou_alice"
    assert me_body["email"] == "alice@example.com"
    assert me_body["provider"] == "lark"
    assert me_body["company_name"]

    directory = client.get("/api/company/team-members")
    assert directory.status_code == 200
    body = directory.json()
    assert body["company_id"] == "company_hermes"
    assert [member["email"] for member in body["members"]] == ["alice@example.com"]
    assert body["members"][0]["lark_open_id"] == "ou_alice"
    assert body["members"][0]["provider"] == "lark"
    assert identity_db.list_company_users(company_id="company_other")[0]["email"] == "other@example.com"


def test_company_team_member_admin_actions_and_disabled_gate(gated_lark_client):
    client, identity_db = gated_lark_client
    _complete_lark_login(client)

    alice = identity_db.find_dashboard_company_user(
        provider="lark",
        provider_user_id="ou_alice",
        company_id="company_hermes",
    )
    assert alice is not None

    promote = client.patch(
        f"/api/company/team-members/{alice['id']}",
        json={"role": "COMPANY_ADMIN"},
    )
    assert promote.status_code == 200
    assert promote.json()["role"] == "COMPANY_ADMIN"

    bob = identity_db.upsert_dashboard_member(
        provider="lark",
        provider_user_id="ou_bob",
        display_name="Bob Example",
        email="bob@example.com",
        company_id="company_hermes",
    )
    disable = client.patch(
        f"/api/company/team-members/{bob['id']}",
        json={"status": "disabled"},
    )
    assert disable.status_code == 200
    assert disable.json()["status"] == "disabled"

    self_disable = client.patch(
        f"/api/company/team-members/{alice['id']}",
        json={"status": "disabled"},
    )
    assert self_disable.status_code == 400

    bob_browser = TestClient(web_server.app, base_url="https://hermes.example.com")
    start = bob_browser.get("/auth/login?provider=lark", follow_redirects=False)
    assert start.status_code == 302
    state = start.headers["location"].split("state=")[1].split("&", 1)[0]
    token_body = {
        "code": 0,
        "access_token": "u_access_bob",
        "expires_in": 7200,
        "refresh_token": "u_refresh_bob",
        "refresh_token_expires_in": 604800,
    }
    user_body = {
        "code": 0,
        "data": {
            "open_id": "ou_bob",
            "name": "Bob Example",
            "email": "bob@example.com",
            "tenant_key": "tenant_1",
        },
    }
    with patch("plugins.dashboard_auth.lark.httpx.post", return_value=_mock_response(200, token_body)):
        with patch("plugins.dashboard_auth.lark.httpx.get", return_value=_mock_response(200, user_body)):
            callback = bob_browser.get(
                f"/auth/callback?code=oauth_code&state={state}",
                follow_redirects=False,
            )
    assert callback.status_code == 403


def test_company_connector_admin_write_path_redacts_secrets(gated_lark_client, monkeypatch):
    client, identity_db = gated_lark_client
    _complete_lark_login(client)
    alice = identity_db.find_dashboard_company_user(
        provider="lark",
        provider_user_id="ou_alice",
        company_id="company_hermes",
    )
    identity_db.update_company_user(
        company_user_id=alice["id"],
        company_id="company_hermes",
        role="COMPANY_ADMIN",
    )
    repo = _FakeConnectorRepository()
    monkeypatch.setattr(web_server, "_get_company_connector_repository", lambda: repo)

    response = client.put(
        "/api/company/connectors/lark",
        json={
            "app_id": "cli_lark_runtime",
            "app_secret": "runtime-secret",
            "api_base_url": "https://open.larksuite.com",
            "metadata": {"label": "production", "token_hint": "should-hide"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["credential_id"] == "cc_1"
    assert "runtime-secret" not in json.dumps(body)
    assert "should-hide" not in json.dumps(body)
    assert repo.upserts[0]["company_id"] == "company_hermes"
    assert repo.upserts[0]["scope"] == "company"
    assert repo.upserts[0]["payload"]["app_secret"] == "runtime-secret"
    assert body["connectors"][1]["provider"] == "lark"
    assert body["connectors"][1]["connected"] is True
    assert body["connectors"][1]["credentials"][0]["metadata"] == {
        "api_base_url": "https://open.larksuite.com",
        "configured_by_company_user_id": alice["id"],
        "label": "production",
        "provider": "lark",
    }

    listed = client.get("/api/company/connectors")
    assert listed.status_code == 200
    assert "runtime-secret" not in json.dumps(listed.json())

    revoke = client.delete("/api/company/connectors/lark?scope=company")
    assert revoke.status_code == 200
    assert revoke.json()["revoked"] == 1
    assert repo.revocations[0]["company_id"] == "company_hermes"


def test_company_connector_zoho_self_client_validates_and_stores_refresh_token(
    gated_lark_client,
    monkeypatch,
):
    client, identity_db = gated_lark_client
    _complete_lark_login(client)
    alice = identity_db.find_dashboard_company_user(
        provider="lark",
        provider_user_id="ou_alice",
        company_id="company_hermes",
    )
    identity_db.update_company_user(
        company_user_id=alice["id"],
        company_id="company_hermes",
        role="COMPANY_ADMIN",
    )
    repo = _FakeConnectorRepository()
    monkeypatch.setattr(web_server, "_get_company_connector_repository", lambda: repo)

    async def fake_refresh(credentials):
        assert credentials.client_id == "zoho-client"
        assert credentials.client_secret == "zoho-secret"
        assert credentials.refresh_token == "zoho-refresh"
        assert credentials.accounts_base_url == "https://accounts.zoho.com"
        return SimpleNamespace(
            access_token="zoho-access",
            expires_at=time.time() + 3600,
            api_domain="https://www.zohoapis.com",
            scope="ZohoBooks.fullaccess.all",
        )

    monkeypatch.setattr(web_server, "_refresh_zoho_connector_token", fake_refresh)

    response = client.put(
        "/api/company/connectors/zoho",
        json={
            "client_id": "zoho-client",
            "client_secret": "zoho-secret",
            "refresh_token": "zoho-refresh",
            "oauth_scopes": "ZohoBooks.fullaccess.all",
            "metadata": {"label": "finance"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert "zoho-secret" not in json.dumps(body)
    assert "zoho-refresh" not in json.dumps(body)
    assert "zoho-access" not in json.dumps(body)
    upsert = repo.upserts[0]
    assert upsert["provider"] == "zoho"
    assert upsert["scope"] == "company"
    assert upsert["payload"]["client_secret"] == "zoho-secret"
    assert upsert["payload"]["refresh_token"] == "zoho-refresh"
    assert upsert["payload"]["access_token"] == "zoho-access"
    assert upsert["payload"]["access_token_expires_at"]
    assert upsert["payload"]["scopes"] == ["ZohoBooks.fullaccess.all"]
    assert body["connectors"][2]["provider"] == "zoho"
    assert body["connectors"][2]["connected"] is True


def test_company_connector_zoho_invalid_refresh_token_does_not_store(
    gated_lark_client,
    monkeypatch,
):
    from tools.zoho_auth import ZohoTokenError

    client, identity_db = gated_lark_client
    _complete_lark_login(client)
    alice = identity_db.find_dashboard_company_user(
        provider="lark",
        provider_user_id="ou_alice",
        company_id="company_hermes",
    )
    identity_db.update_company_user(
        company_user_id=alice["id"],
        company_id="company_hermes",
        role="COMPANY_ADMIN",
    )
    repo = _FakeConnectorRepository()
    monkeypatch.setattr(web_server, "_get_company_connector_repository", lambda: repo)

    async def fake_refresh(_credentials):
        raise ZohoTokenError("invalid_code")

    monkeypatch.setattr(web_server, "_refresh_zoho_connector_token", fake_refresh)

    response = client.put(
        "/api/company/connectors/zoho",
        json={
            "client_id": "zoho-client",
            "client_secret": "zoho-secret",
            "refresh_token": "bad-refresh",
        },
    )

    assert response.status_code == 400
    assert "Zoho refresh token validation failed" in response.text
    assert repo.upserts == []


def test_company_connector_write_requires_admin(gated_lark_client, monkeypatch):
    client, _identity_db = gated_lark_client
    _complete_lark_login(client)
    repo = _FakeConnectorRepository()
    monkeypatch.setattr(web_server, "_get_company_connector_repository", lambda: repo)

    response = client.put(
        "/api/company/connectors/lark",
        json={"app_id": "cli_lark_runtime", "app_secret": "runtime-secret"},
    )

    assert response.status_code == 403
    assert repo.upserts == []


def test_company_connector_google_user_scope_defaults_to_actor(gated_lark_client, monkeypatch):
    client, identity_db = gated_lark_client
    _complete_lark_login(client)
    alice = identity_db.find_dashboard_company_user(
        provider="lark",
        provider_user_id="ou_alice",
        company_id="company_hermes",
    )
    identity_db.update_company_user(
        company_user_id=alice["id"],
        company_id="company_hermes",
        role="COMPANY_ADMIN",
    )
    repo = _FakeConnectorRepository()
    monkeypatch.setattr(web_server, "_get_company_connector_repository", lambda: repo)

    response = client.put(
        "/api/company/connectors/google",
        json={
            "scope": "user",
            "refresh_token": "1//refresh",
            "google_email": "alice@example.com",
            "oauth_scope": "https://www.googleapis.com/auth/gmail.readonly",
        },
    )

    assert response.status_code == 200
    upsert = repo.upserts[0]
    assert upsert["provider"] == "google"
    assert upsert["scope"] == "user"
    assert upsert["company_user_id"] == alice["id"]
    assert upsert["payload"]["refresh_token"] == "1//refresh"
    assert "1//refresh" not in json.dumps(response.json())


def test_disabled_lark_member_existing_cookie_is_rejected(gated_lark_client):
    client, identity_db = gated_lark_client
    _complete_lark_login(client)

    alice = identity_db.find_dashboard_company_user(
        provider="lark",
        provider_user_id="ou_alice",
        company_id="company_hermes",
    )
    assert alice is not None
    identity_db.update_company_user(
        company_user_id=alice["id"],
        company_id="company_hermes",
        status="disabled",
    )

    blocked = client.get("/api/company/me")
    assert blocked.status_code == 403
    assert blocked.json()["error"] == "user_disabled"


def test_lark_system_browser_desktop_handoff_sets_desktop_cookies(gated_lark_client):
    _client, identity_db = gated_lark_client
    desktop = TestClient(web_server.app, base_url="https://hermes.example.com")
    browser = TestClient(web_server.app, base_url="https://hermes.example.com")

    start = desktop.post("/api/auth/desktop-login/start", json={})
    assert start.status_code == 200
    start_body = start.json()
    assert "/auth/login?provider=lark" in start_body["login_url"]

    pending = desktop.post(
        "/api/auth/desktop-login/exchange",
        json={
            "request_id": start_body["request_id"],
            "poll_secret": start_body["poll_secret"],
        },
    )
    assert pending.status_code == 202
    assert pending.json()["status"] == "pending"

    oauth_start = browser.get(
        _path_and_query(start_body["login_url"]),
        follow_redirects=False,
    )
    assert oauth_start.status_code == 302
    redirect = oauth_start.headers["location"]
    assert "accounts.larksuite.com" in redirect
    state = parse_qs(urlparse(redirect).query)["state"][0]

    token_body = {
        "code": 0,
        "access_token": "u_access_2",
        "expires_in": 7200,
        "refresh_token": "u_refresh_2",
        "refresh_token_expires_in": 604800,
    }
    user_body = {
        "code": 0,
        "data": {
            "open_id": "ou_browser",
            "name": "Browser Login",
            "email": "browser@example.com",
            "tenant_key": "tenant_1",
        },
    }

    with patch("plugins.dashboard_auth.lark.httpx.post", return_value=_mock_response(200, token_body)):
        with patch("plugins.dashboard_auth.lark.httpx.get", return_value=_mock_response(200, user_body)):
            callback = browser.get(
                f"/auth/callback?code=oauth_code&state={state}",
                follow_redirects=False,
            )

    assert callback.status_code == 302
    assert callback.headers["location"].startswith("/desktop-auth/complete")

    complete = browser.get(callback.headers["location"], follow_redirects=False)
    assert complete.status_code == 200
    assert "Sign-in complete" in complete.text

    exchange = desktop.post(
        "/api/auth/desktop-login/exchange",
        json={
            "request_id": start_body["request_id"],
            "poll_secret": start_body["poll_secret"],
        },
    )
    assert exchange.status_code == 200
    assert exchange.json()["status"] == "complete"
    assert any(
        "hermes_session_at" in cookie
        for cookie in exchange.headers.get_list("set-cookie")
    )

    me = desktop.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user_id"] == "ou_browser"
    assert me.json()["email"] == "browser@example.com"

    members = identity_db.list_company_users(company_id="company_hermes")
    assert [member["email"] for member in members] == ["browser@example.com"]


def test_company_session_endpoints_are_scoped_to_authenticated_member(gated_lark_client):
    client, identity_db = gated_lark_client
    _complete_lark_login(client)

    from hermes_state import SessionDB

    alice_identity = gateway_company_identity.resolve_dashboard_session_identity(
        provider="lark",
        provider_user_id="ou_alice",
        display_name="Alice Example",
        email="alice@example.com",
        company_id="company_hermes",
        db=identity_db,
    )
    bob_identity = gateway_company_identity.resolve_dashboard_session_identity(
        provider="lark",
        provider_user_id="ou_bob",
        display_name="Bob Example",
        email="bob@example.com",
        company_id="company_hermes",
        db=identity_db,
    )

    db = SessionDB()
    try:
        db.create_session(session_id="alice-session", source="tui")
        db.append_message(
            session_id="alice-session", role="user", content="alice history"
        )
        db.create_session(session_id="bob-session", source="tui")
        db.append_message(session_id="bob-session", role="user", content="bob history")
    finally:
        db.close()

    gateway_company_identity.bind_explicit_session_identity(
        session_id="alice-session",
        session_key="alice-session",
        company_id=alice_identity.company_id,
        company_user_id=alice_identity.company_user_id,
        channel_identity_id=alice_identity.channel_identity_id,
        company_role=alice_identity.company_role,
        department_id=alice_identity.department_id,
        platform="tui",
        chat_id="alice-session",
        db=identity_db,
    )
    gateway_company_identity.bind_explicit_session_identity(
        session_id="bob-session",
        session_key="bob-session",
        company_id=bob_identity.company_id,
        company_user_id=bob_identity.company_user_id,
        channel_identity_id=bob_identity.channel_identity_id,
        company_role=bob_identity.company_role,
        department_id=bob_identity.department_id,
        platform="tui",
        chat_id="bob-session",
        db=identity_db,
    )

    listing = client.get("/api/sessions?limit=20&offset=0")
    assert listing.status_code == 200
    assert [row["id"] for row in listing.json()["sessions"]] == ["alice-session"]

    detail = client.get("/api/sessions/alice-session")
    assert detail.status_code == 200
    assert detail.json()["id"] == "alice-session"

    forbidden_detail = client.get("/api/sessions/bob-session")
    assert forbidden_detail.status_code == 404

    forbidden_messages = client.get("/api/sessions/bob-session/messages")
    assert forbidden_messages.status_code == 404

    forbidden_export = client.get("/api/sessions/bob-session/export")
    assert forbidden_export.status_code == 404


def test_company_session_prune_only_removes_authenticated_members_sessions(gated_lark_client):
    client, identity_db = gated_lark_client
    _complete_lark_login(client)

    from hermes_state import SessionDB

    alice_identity = gateway_company_identity.resolve_dashboard_session_identity(
        provider="lark",
        provider_user_id="ou_alice",
        display_name="Alice Example",
        email="alice@example.com",
        company_id="company_hermes",
        db=identity_db,
    )
    bob_identity = gateway_company_identity.resolve_dashboard_session_identity(
        provider="lark",
        provider_user_id="ou_bob",
        display_name="Bob Example",
        email="bob@example.com",
        company_id="company_hermes",
        db=identity_db,
    )

    db = SessionDB()
    try:
        db.create_session(session_id="alice-old", source="tui")
        db.create_session(session_id="bob-old", source="tui")
        db.end_session("alice-old", "done")
        db.end_session("bob-old", "done")
        stale_started_at = 1.0
        with db._lock:
            db._conn.execute(
                "UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?",
                (stale_started_at, stale_started_at + 10.0, "alice-old"),
            )
            db._conn.execute(
                "UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?",
                (stale_started_at, stale_started_at + 10.0, "bob-old"),
            )
            db._conn.commit()
    finally:
        db.close()

    gateway_company_identity.bind_explicit_session_identity(
        session_id="alice-old",
        session_key="alice-old",
        company_id=alice_identity.company_id,
        company_user_id=alice_identity.company_user_id,
        channel_identity_id=alice_identity.channel_identity_id,
        company_role=alice_identity.company_role,
        department_id=alice_identity.department_id,
        platform="tui",
        chat_id="alice-old",
        db=identity_db,
    )
    gateway_company_identity.bind_explicit_session_identity(
        session_id="bob-old",
        session_key="bob-old",
        company_id=bob_identity.company_id,
        company_user_id=bob_identity.company_user_id,
        channel_identity_id=bob_identity.channel_identity_id,
        company_role=bob_identity.company_role,
        department_id=bob_identity.department_id,
        platform="tui",
        chat_id="bob-old",
        db=identity_db,
    )

    prune = client.post("/api/sessions/prune", json={"older_than_days": 1})
    assert prune.status_code == 200
    assert prune.json() == {"ok": True, "removed": 1}

    db = SessionDB()
    try:
        assert db.get_session("alice-old") is None
        assert db.get_session("bob-old") is not None
    finally:
        db.close()


def test_company_sessions_read_from_enterprise_db_with_empty_state_db(
    gated_lark_client, monkeypatch
):
    client, identity_db = gated_lark_client
    _complete_lark_login(client)

    from enterprise.session_store import DashboardCompanyIdentity, EnterpriseSessionBackend
    from enterprise.session_repository import EnterpriseSessionRepository
    from tests.enterprise.memory_pg import MemoryEnterpriseConnection, seed_company_session

    memory = MemoryEnterpriseConnection()
    alice_identity = gateway_company_identity.resolve_dashboard_session_identity(
        provider="lark",
        provider_user_id="ou_alice",
        display_name="Alice Example",
        email="alice@example.com",
        company_id="company_hermes",
        db=identity_db,
    )
    seed_company_session(
        memory,
        company_id=alice_identity.company_id,
        company_user_id=alice_identity.company_user_id,
        channel_identity_id=alice_identity.channel_identity_id,
        session_id="enterprise-alice-session",
        messages=[("user", "alice history")],
    )
    seed_company_session(
        memory,
        company_id=alice_identity.company_id,
        company_user_id="cu_bob",
        channel_identity_id="ci_bob",
        session_id="enterprise-bob-session",
        messages=[("user", "bob history")],
    )

    dashboard_identity = DashboardCompanyIdentity(
        company_id=alice_identity.company_id,
        company_user_id=alice_identity.company_user_id,
        channel_identity_id=alice_identity.channel_identity_id,
        company_role=alice_identity.company_role,
        department_id=alice_identity.department_id,
    )
    backend = EnterpriseSessionBackend(
        dashboard_identity,
        EnterpriseSessionRepository(memory),
    )

    monkeypatch.setattr(
        "enterprise.session_store.company_enterprise_session_mode",
        lambda request: dashboard_identity,
    )
    monkeypatch.setattr(
        "enterprise.session_store.get_session_backend",
        lambda request: backend,
    )

    listing = client.get("/api/sessions?limit=20&offset=0")
    assert listing.status_code == 200
    assert [row["id"] for row in listing.json()["sessions"]] == ["enterprise-alice-session"]

    detail = client.get("/api/sessions/enterprise-alice-session/messages")
    assert detail.status_code == 200
    assert detail.json()["messages"][0]["content"] == "alice history"

    forbidden = client.get("/api/sessions/enterprise-bob-session")
    assert forbidden.status_code == 404

    from hermes_state import SessionDB

    sqlite = SessionDB()
    try:
        assert sqlite.get_session("enterprise-alice-session") is None
    finally:
        sqlite.close()
