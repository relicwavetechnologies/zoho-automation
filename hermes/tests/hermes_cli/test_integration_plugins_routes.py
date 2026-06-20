"""Route coverage for enterprise integration plugin APIs."""

from __future__ import annotations

import json
import urllib.parse

import pytest


def _policy_client():
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    prev_required = getattr(app.state, "auth_required", None)
    app.state.auth_required = False
    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return app, client, prev_required


class _FakeConnectorRepository:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.saved: list[dict] = []
        self.lark_user_links: list[dict] = []

    def list_connector_credentials(self, *, company_id):
        return self.rows

    def put_connector_credential(self, **kwargs):
        self.saved.append(kwargs)
        return f"cc_{kwargs.get('provider')}_test"

    def upsert_lark_user_auth_link(self, **kwargs):
        self.lark_user_links.append(kwargs)
        return kwargs.get("user_id") or "user_resolved"


def _google_credential_row(*, company_user_id: str, google_email: str) -> dict:
    return {
        "id": f"cc_google_{company_user_id}",
        "provider": "google",
        "scope": "user",
        "company_user_id": company_user_id,
        "status": "active",
        "revoked_at": None,
        "created_at": "2026-06-17T10:00:00Z",
        "updated_at": "2026-06-17T10:00:00Z",
        "metadata": {
            "google_email": google_email,
            "oauth_scope": "https://www.googleapis.com/auth/gmail.readonly",
        },
    }


def test_integration_plugins_list_returns_google_workspace(_isolate_hermes_home, monkeypatch):
    repo = _FakeConnectorRepository()
    monkeypatch.setattr(
        "hermes_cli.web_server._get_company_connector_repository",
        lambda: repo,
    )

    app, client, prev_required = _policy_client()
    try:
        response = client.get("/api/company/integration-plugins")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    body = response.json()
    assert body["company_id"]
    assert body["plugins"]
    assert body["plugins"][0]["id"] == "google-workspace"
    assert body["plugins"][0]["manifest"]["name"] == "Google Workspace"
    assert any(plugin["id"] == "lark" for plugin in body["plugins"])
    assert "google_configured" in body["oauth"]
    assert "lark_configured" in body["oauth"]


def test_integration_plugins_per_user_isolation(_isolate_hermes_home, monkeypatch):
    repo = _FakeConnectorRepository(
        rows=[
            _google_credential_row(company_user_id="user_alice", google_email="alice@example.com"),
            _google_credential_row(company_user_id="user_bob", google_email="bob@example.com"),
        ]
    )
    monkeypatch.setattr(
        "hermes_cli.web_server._get_company_connector_repository",
        lambda: repo,
    )

    def actor_for_request(request, store):
        company_id = store.ensure_default_company()
        actor_id = request.headers.get("X-Test-Actor-Id", "user_alice")
        return company_id, {
            "id": actor_id,
            "company_id": company_id,
            "role": "MEMBER",
            "department_id": "",
            "status": "active",
            "email": f"{actor_id}@example.com",
            "display_name": actor_id,
        }

    monkeypatch.setattr(
        "hermes_cli.web_server._policy_actor_for_request",
        actor_for_request,
    )

    app, client, prev_required = _policy_client()
    try:
        alice = client.get("/api/company/integration-plugins", headers={"X-Test-Actor-Id": "user_alice"})
        bob = client.get("/api/company/integration-plugins", headers={"X-Test-Actor-Id": "user_bob"})
    finally:
        app.state.auth_required = prev_required

    assert alice.status_code == 200
    assert bob.status_code == 200

    alice_plugin = alice.json()["plugins"][0]
    bob_plugin = bob.json()["plugins"][0]

    assert alice_plugin["connection"]["status"] == "connected"
    assert alice_plugin["connection"]["account_email"] == "alice@example.com"
    assert alice_plugin.get("admin_stats") is None

    assert bob_plugin["connection"]["status"] == "connected"
    assert bob_plugin["connection"]["account_email"] == "bob@example.com"
    assert bob_plugin.get("admin_stats") is None


def test_integration_plugins_oauth_start_returns_authorize_url(_isolate_hermes_home, monkeypatch):
    repo = _FakeConnectorRepository()
    monkeypatch.setattr(
        "hermes_cli.web_server._get_company_connector_repository",
        lambda: repo,
    )
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client-id")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv(
        "GOOGLE_OAUTH_REDIRECT_URI",
        "http://127.0.0.1:9119/api/company/integration-plugins/google-workspace/oauth/callback",
    )

    app, client, prev_required = _policy_client()
    try:
        response = client.get("/api/company/integration-plugins/google-workspace/oauth/start")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    body = response.json()
    assert body["authorize_url"].startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "client_id=client-id" in body["authorize_url"]
    assert "code_challenge=" in body["authorize_url"]
    parsed = urllib.parse.urlparse(body["authorize_url"])
    params = urllib.parse.parse_qs(parsed.query)
    scopes = set(params["scope"][0].split())
    assert "https://www.googleapis.com/auth/documents" in scopes
    assert "https://www.googleapis.com/auth/spreadsheets" in scopes
    assert "https://www.googleapis.com/auth/presentations" in scopes


def test_integration_plugins_oauth_start_stub_redirect_missing(_isolate_hermes_home, monkeypatch):
    repo = _FakeConnectorRepository()
    monkeypatch.setattr(
        "hermes_cli.web_server._get_company_connector_repository",
        lambda: repo,
    )
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client-id")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret")
    monkeypatch.delenv("GOOGLE_OAUTH_REDIRECT_URI", raising=False)

    app, client, prev_required = _policy_client()
    try:
        response = client.get("/api/company/integration-plugins/google-workspace/oauth/start")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 501
    detail = response.json()["detail"]
    if isinstance(detail, str):
        detail = json.loads(detail) if detail.startswith("{") else {"error": detail}
    assert detail["error"] == "redirect_uri_not_configured"
    assert detail["phase"] == 2


def test_integration_plugins_oauth_start_not_configured(_isolate_hermes_home, monkeypatch):
    repo = _FakeConnectorRepository()
    monkeypatch.setattr(
        "hermes_cli.web_server._get_company_connector_repository",
        lambda: repo,
    )
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_SECRET", raising=False)

    app, client, prev_required = _policy_client()
    try:
        response = client.get("/api/company/integration-plugins/google-workspace/oauth/start")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 503
    detail = response.json()["detail"]
    if isinstance(detail, dict):
        assert detail["error"] == "oauth_not_configured"


def test_integration_plugins_oauth_callback_persists_user_credential(_isolate_hermes_home, monkeypatch):
    from enterprise.integration_plugins.google_oauth import build_google_authorize_url

    repo = _FakeConnectorRepository()
    monkeypatch.setattr(
        "hermes_cli.web_server._get_company_connector_repository",
        lambda: repo,
    )
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client-id")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv(
        "GOOGLE_OAUTH_REDIRECT_URI",
        "http://127.0.0.1:9119/api/company/integration-plugins/google-workspace/oauth/callback",
    )

    authorize_url = build_google_authorize_url(
        company_id="company_test",
        company_user_id="user_alice",
    )
    state = authorize_url.split("state=")[1].split("&", 1)[0]

    async def _fake_exchange(**kwargs):
        return {
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "expires_in": 3600,
            "scope": "https://www.googleapis.com/auth/gmail.readonly",
            "token_type": "Bearer",
        }

    async def _fake_profile(*args, **kwargs):
        return {"email": "alice@example.com"}

    monkeypatch.setattr(
        "enterprise.integration_plugins.google_oauth._exchange_authorization_code",
        _fake_exchange,
    )
    monkeypatch.setattr(
        "enterprise.integration_plugins.google_oauth._fetch_google_profile",
        _fake_profile,
    )

    app, client, prev_required = _policy_client()
    app.state.auth_required = True
    try:
        response = client.get(
            "/api/company/integration-plugins/google-workspace/oauth/callback",
            params={"code": "auth-code", "state": state},
        )
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    assert "Google connected" in response.text
    assert len(repo.saved) == 1
    saved = repo.saved[0]
    assert saved["company_id"] == "company_test"
    assert saved["company_user_id"] == "user_alice"
    assert saved["scope"] == "user"
    assert saved["payload"]["refresh_token"] == "refresh-token"


def test_lark_integration_plugin_oauth_start_returns_authorize_url(_isolate_hermes_home, monkeypatch):
    repo = _FakeConnectorRepository()
    monkeypatch.setattr(
        "hermes_cli.web_server._get_company_connector_repository",
        lambda: repo,
    )
    monkeypatch.setenv("LARK_APP_ID", "cli_lark_app")
    monkeypatch.setenv("LARK_APP_SECRET", "lark-secret")
    monkeypatch.setenv("HERMES_DASHBOARD_PUBLIC_URL", "http://127.0.0.1:9119")

    app, client, prev_required = _policy_client()
    try:
        response = client.get("/api/company/integration-plugins/lark/oauth/start")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    body = response.json()
    assert body["authorize_url"].startswith("https://accounts.larksuite.com/open-apis/authen/v1/authorize?")
    assert "client_id=cli_lark_app" in body["authorize_url"]
    assert body["redirect_uri"] == "http://127.0.0.1:9119/api/company/integration-plugins/lark/oauth/callback"


def test_lark_integration_plugin_oauth_callback_persists_lark_user_link(_isolate_hermes_home, monkeypatch):
    from enterprise.integration_plugins.lark_oauth import build_lark_authorize_url

    repo = _FakeConnectorRepository()
    monkeypatch.setattr(
        "hermes_cli.web_server._get_company_connector_repository",
        lambda: repo,
    )
    monkeypatch.setenv("LARK_APP_ID", "cli_lark_app")
    monkeypatch.setenv("LARK_APP_SECRET", "lark-secret")
    monkeypatch.setenv("HERMES_DASHBOARD_PUBLIC_URL", "http://127.0.0.1:9119")

    authorize_url = build_lark_authorize_url(
        company_id="company_test",
        company_user_id="user_alice",
        user_id="hermes_user_alice",
        user_email="alice@example.com",
    )
    state = authorize_url.split("state=")[1].split("&", 1)[0]

    async def _fake_exchange(**kwargs):
        return {
            "access_token": "lark-access-token",
            "refresh_token": "lark-refresh-token",
            "expires_in": 7200,
            "refresh_token_expires_in": 2592000,
            "scope": "offline_access contact:user:search contact:user.email:readonly task:task:read task:task:write",
            "token_type": "Bearer",
        }

    async def _fake_profile(*args, **kwargs):
        return {
            "open_id": "ou_alice",
            "user_id": "u_alice",
            "enterprise_email": "alice@example.com",
            "name": "Alice Example",
            "tenant_key": "tenant_1",
        }

    monkeypatch.setattr(
        "enterprise.integration_plugins.lark_oauth._exchange_lark_authorization_code",
        _fake_exchange,
    )
    monkeypatch.setattr(
        "enterprise.integration_plugins.lark_oauth._fetch_lark_user_info",
        _fake_profile,
    )

    app, client, prev_required = _policy_client()
    app.state.auth_required = True
    try:
        response = client.get(
            "/api/company/integration-plugins/lark/oauth/callback",
            params={"code": "auth-code", "state": state},
        )
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    assert "Lark connected" in response.text
    assert len(repo.lark_user_links) == 1
    link = repo.lark_user_links[0]
    assert link["company_id"] == "company_test"
    assert link["company_user_id"] == "user_alice"
    assert link["user_id"] == "hermes_user_alice"
    assert link["lark_open_id"] == "ou_alice"
    assert link["refresh_token"] == "lark-refresh-token"
    assert len(repo.saved) == 1
    saved = repo.saved[0]
    assert saved["provider"] == "lark"
    assert saved["scope"] == "user"
    assert saved["metadata"]["lark_email"] == "alice@example.com"


def test_policy_nav_excludes_web_integrations_page(_isolate_hermes_home):
    app, client, prev_required = _policy_client()
    try:
        response = client.get("/api/policy/me")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    nav = response.json()["nav"]
    assert "/integrations" not in nav
