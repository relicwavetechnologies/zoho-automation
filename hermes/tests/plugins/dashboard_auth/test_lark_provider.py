"""Tests for the bundled Lark dashboard-auth plugin."""

from __future__ import annotations

import json
import time
import urllib.parse
from unittest.mock import MagicMock, patch

import httpx
import pytest

import plugins.dashboard_auth.lark as lark_plugin
from hermes_cli.dashboard_auth import (
    InvalidCodeError,
    ProviderError,
    RefreshExpiredError,
    assert_protocol_compliance,
)


def _mock_response(status_code: int, body, *, ctype: str = "application/json"):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    if isinstance(body, dict):
        resp.text = json.dumps(body)
        resp.json = MagicMock(return_value=body)
    else:
        resp.text = body
        resp.json = MagicMock(side_effect=ValueError("not json"))
    resp.headers = {"content-type": ctype}
    return resp


class TestConstruction:
    def test_protocol_compliance(self):
        assert_protocol_compliance(lark_plugin.LarkDashboardAuthProvider)

    def test_name_and_display(self):
        provider = lark_plugin.LarkDashboardAuthProvider(
            app_id="cli_app_1",
            app_secret="secret_1",
        )
        assert provider.name == "lark"
        assert provider.display_name == "Lark"


class TestRegister:
    def test_skips_when_credentials_missing(self, monkeypatch):
        monkeypatch.delenv("HERMES_DASHBOARD_LARK_APP_ID", raising=False)
        monkeypatch.delenv("HERMES_DASHBOARD_LARK_APP_SECRET", raising=False)
        monkeypatch.delenv("LARK_APP_ID", raising=False)
        monkeypatch.delenv("LARK_APP_SECRET", raising=False)
        ctx = MagicMock()

        lark_plugin.register(ctx)

        ctx.register_dashboard_auth_provider.assert_not_called()
        assert "LARK_APP_ID" in lark_plugin.LAST_SKIP_REASON

    def test_registers_from_shared_lark_env(self, monkeypatch):
        monkeypatch.setenv("LARK_APP_ID", "cli_shared")
        monkeypatch.setenv("LARK_APP_SECRET", "shared_secret")
        ctx = MagicMock()

        lark_plugin.register(ctx)

        ctx.register_dashboard_auth_provider.assert_called_once()
        provider = ctx.register_dashboard_auth_provider.call_args.args[0]
        assert isinstance(provider, lark_plugin.LarkDashboardAuthProvider)
        assert provider._app_id == "cli_shared"

    def test_register_expands_dashboard_env_references(self, monkeypatch):
        monkeypatch.setenv("LARK_APP_ID", "cli_resolved")
        monkeypatch.setenv("LARK_APP_SECRET", "resolved_secret")
        monkeypatch.setenv("HERMES_DASHBOARD_LARK_APP_ID", "$LARK_APP_ID")
        monkeypatch.setenv("HERMES_DASHBOARD_LARK_APP_SECRET", "${LARK_APP_SECRET}")
        ctx = MagicMock()

        lark_plugin.register(ctx)

        ctx.register_dashboard_auth_provider.assert_called_once()
        provider = ctx.register_dashboard_auth_provider.call_args.args[0]
        assert provider._app_id == "cli_resolved"


class TestLoginFlow:
    def test_default_scopes_include_calendar_for_today_panel(self):
        provider = lark_plugin.LarkDashboardAuthProvider(
            app_id="cli_app_1",
            app_secret="secret_1",
        )
        login = provider.start_login(
            redirect_uri="https://hermes.example.com/auth/callback"
        )
        parsed = urllib.parse.urlparse(login.redirect_url)
        scope = urllib.parse.parse_qs(parsed.query)["scope"][0]
        assert "calendar:calendar:read" in scope
        assert "calendar:calendar.event:read" in scope
        assert "calendar:calendar.event:create" in scope
        assert "calendar:calendar.event:update" in scope
        assert "calendar:calendar.event:delete" in scope
        assert "calendar:calendar.free_busy:read" in scope
        assert "docs:permission.setting:write_only" in scope

    def test_start_login_builds_lark_authorize_url(self):
        provider = lark_plugin.LarkDashboardAuthProvider(
            app_id="cli_app_1",
            app_secret="secret_1",
            scopes="offline_access contact:user.email:readonly",
        )

        login = provider.start_login(
            redirect_uri="https://hermes.example.com/auth/callback"
        )

        assert "accounts.larksuite.com/open-apis/authen/v1/authorize" in login.redirect_url
        parsed = urllib.parse.urlparse(login.redirect_url)
        qs = urllib.parse.parse_qs(parsed.query)
        assert qs["client_id"] == ["cli_app_1"]
        assert qs["redirect_uri"] == ["https://hermes.example.com/auth/callback"]
        assert qs["scope"] == ["offline_access contact:user.email:readonly"]
        assert qs["code_challenge_method"] == ["S256"]
        assert "state=" in login.cookie_payload["hermes_session_pkce"]

    def test_complete_login_exchanges_code_and_maps_user(self):
        provider = lark_plugin.LarkDashboardAuthProvider(
            app_id="cli_app_1",
            app_secret="secret_1",
        )
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
                "open_id": "ou_123",
                "name": "Alice Example",
                "email": "alice@example.com",
                "tenant_key": "tenant_1",
            },
        }

        with patch.object(lark_plugin.httpx, "post", return_value=_mock_response(200, token_body)) as post:
            with patch.object(lark_plugin.httpx, "get", return_value=_mock_response(200, user_body)) as get:
                session = provider.complete_login(
                    code="oauth_code",
                    state="state",
                    code_verifier="verifier",
                    redirect_uri="https://hermes.example.com/auth/callback",
                )

        assert post.called
        assert get.called
        assert session.user_id == "ou_123"
        assert session.email == "alice@example.com"
        assert session.display_name == "Alice Example"
        assert session.org_id == "tenant_1"
        verified = provider.verify_session(access_token=session.access_token)
        assert verified is not None
        assert verified.user_id == "ou_123"

    def test_complete_login_maps_bad_code_to_invalid_code(self):
        provider = lark_plugin.LarkDashboardAuthProvider(
            app_id="cli_app_1",
            app_secret="secret_1",
        )
        with patch.object(
            lark_plugin.httpx,
            "post",
            return_value=_mock_response(200, {"code": 20001, "msg": "bad code"}),
        ):
            with pytest.raises(InvalidCodeError, match="bad code"):
                provider.complete_login(
                    code="bad",
                    state="state",
                    code_verifier="verifier",
                    redirect_uri="https://hermes.example.com/auth/callback",
                )

    def test_verify_session_returns_none_for_tampered_or_expired_cookie(self):
        provider = lark_plugin.LarkDashboardAuthProvider(
            app_id="cli_app_1",
            app_secret="secret_1",
        )
        assert provider.verify_session(access_token="garbage") is None

        token = lark_plugin._sign(
            {
                "provider": "lark",
                "sub": "ou_123",
                "email": "alice@example.com",
                "name": "Alice",
                "org_id": "tenant_1",
                "exp": int(time.time()) - 1,
            },
            provider._session_secret,
        )
        assert provider.verify_session(access_token=token) is None

    def test_refresh_session_rotates_tokens_and_falls_back_to_cached_identity(self):
        provider = lark_plugin.LarkDashboardAuthProvider(
            app_id="cli_app_1",
            app_secret="secret_1",
        )
        refresh_cookie = lark_plugin._sign(
            {
                "provider": "lark",
                "sub": "ou_123",
                "email": "alice@example.com",
                "name": "Alice Example",
                "org_id": "tenant_1",
                "exp": int(time.time()) + 3600,
                "rt": "raw_refresh_1",
            },
            provider._session_secret,
        )
        token_body = {
            "code": 0,
            "access_token": "u_access_2",
            "expires_in": 7200,
            "refresh_token": "u_refresh_2",
            "refresh_token_expires_in": 604800,
        }

        with patch.object(lark_plugin.httpx, "post", return_value=_mock_response(200, token_body)):
            with patch.object(lark_plugin.httpx, "get", side_effect=ProviderError("userinfo unavailable")):
                session = provider.refresh_session(refresh_token=refresh_cookie)

        assert session.user_id == "ou_123"
        assert session.email == "alice@example.com"
        assert session.display_name == "Alice Example"
        assert provider.verify_session(access_token=session.access_token) is not None

    def test_refresh_session_recovers_when_tools_rotated_lark_refresh_token(self):
        provider = lark_plugin.LarkDashboardAuthProvider(
            app_id="cli_app_1",
            app_secret="secret_1",
        )
        refresh_cookie = lark_plugin._sign(
            {
                "provider": "lark",
                "sub": "ou_123",
                "email": "alice@example.com",
                "name": "Alice Example",
                "org_id": "tenant_1",
                "exp": int(time.time()) + 3600,
                "rt": "raw_refresh_stale",
            },
            provider._session_secret,
        )
        stale_response = _mock_response(
            200,
            {"code": 99991663, "msg": "refresh token expired"},
        )
        rotated_response = _mock_response(
            200,
            {
                "code": 0,
                "access_token": "u_access_2",
                "expires_in": 7200,
                "refresh_token": "u_refresh_2",
                "refresh_token_expires_in": 604800,
            },
        )

        with patch.object(
            lark_plugin.httpx,
            "post",
            side_effect=[stale_response, rotated_response],
        ) as post:
            with patch.object(
                lark_plugin,
                "_find_synced_refresh_token",
                return_value="raw_refresh_current_from_tools",
            ):
                with patch.object(
                    lark_plugin.httpx,
                    "get",
                    side_effect=ProviderError("userinfo unavailable"),
                ):
                    session = provider.refresh_session(refresh_token=refresh_cookie)

        sent_refresh_tokens = [
            call.kwargs["json"]["refresh_token"]
            for call in post.call_args_list
        ]
        assert sent_refresh_tokens == [
            "raw_refresh_stale",
            "raw_refresh_current_from_tools",
        ]
        assert session.user_id == "ou_123"
        assert provider.verify_session(access_token=session.access_token) is not None

    def test_refresh_session_rejects_invalid_cookie(self):
        provider = lark_plugin.LarkDashboardAuthProvider(
            app_id="cli_app_1",
            app_secret="secret_1",
        )
        with pytest.raises(RefreshExpiredError):
            provider.refresh_session(refresh_token="garbage")

    def test_login_fails_when_user_info_missing_tenant(self):
        provider = lark_plugin.LarkDashboardAuthProvider(
            app_id="cli_app_1",
            app_secret="secret_1",
        )
        token_body = {
            "code": 0,
            "access_token": "u_access_1",
            "expires_in": 7200,
            "refresh_token": "u_refresh_1",
            "refresh_token_expires_in": 604800,
        }
        user_body = {
            "code": 0,
            "data": {"open_id": "ou_123", "name": "Alice Example"},
        }

        with patch.object(lark_plugin.httpx, "post", return_value=_mock_response(200, token_body)):
            with patch.object(lark_plugin.httpx, "get", return_value=_mock_response(200, user_body)):
                with pytest.raises(ProviderError, match="tenant_key"):
                    provider.complete_login(
                        code="oauth_code",
                        state="state",
                        code_verifier="verifier",
                        redirect_uri="https://hermes.example.com/auth/callback",
                    )
