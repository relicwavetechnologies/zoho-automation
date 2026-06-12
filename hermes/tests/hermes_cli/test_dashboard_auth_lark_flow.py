"""Lark OAuth flow coverage for the Hermes dashboard auth gate."""

from __future__ import annotations

import json
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
    state = start.headers["location"].split("state=")[1].split("&", 1)[0]

    token_body = {
        "code": 0,
        "access_token": "u_access_1",
        "expires_in": 7200,
        "refresh_token": "u_refresh_1",
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

    with patch("plugins.dashboard_auth.lark.httpx.post", return_value=_mock_response(200, token_body)):
        with patch("plugins.dashboard_auth.lark.httpx.get", return_value=_mock_response(200, user_body)):
            callback = client.get(
                f"/auth/callback?code=oauth_code&state={state}",
                follow_redirects=False,
            )

    assert callback.status_code == 302
    assert callback.headers["location"] == "/"
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

    directory = client.get("/api/company/team-members")
    assert directory.status_code == 200
    body = directory.json()
    assert body["company_id"] == "company_hermes"
    assert [member["email"] for member in body["members"]] == ["alice@example.com"]
    assert identity_db.list_company_users(company_id="company_other")[0]["email"] == "other@example.com"
