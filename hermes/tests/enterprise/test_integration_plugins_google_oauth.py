"""Unit tests for Google integration plugin OAuth helpers."""

from __future__ import annotations

import pytest

from enterprise.integration_plugins.google_oauth import (
    GoogleIntegrationOAuthError,
    build_google_authorize_url,
    complete_google_oauth_callback,
)


class _FakeRepo:
    def __init__(self):
        self.saved = None

    def put_connector_credential(self, **kwargs):
        self.saved = kwargs
        return "cc_google_alice"


@pytest.mark.asyncio
async def test_build_google_authorize_url_contains_pkce(monkeypatch):
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client-id")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv(
        "GOOGLE_OAUTH_REDIRECT_URI",
        "http://127.0.0.1:9119/api/company/integration-plugins/google-workspace/oauth/callback",
    )

    url = build_google_authorize_url(company_id="company_1", company_user_id="user_alice")
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "client_id=client-id" in url
    assert "code_challenge=" in url
    assert "prompt=consent" in url


@pytest.mark.asyncio
async def test_complete_google_oauth_callback_persists_user_scoped_credential(monkeypatch):
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client-id")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv(
        "GOOGLE_OAUTH_REDIRECT_URI",
        "http://127.0.0.1:9119/api/company/integration-plugins/google-workspace/oauth/callback",
    )

    authorize_url = build_google_authorize_url(company_id="company_1", company_user_id="user_alice")
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

    repo = _FakeRepo()
    result = await complete_google_oauth_callback(code="auth-code", state=state, repo=repo)

    assert result["ok"] is True
    assert result["google_email"] == "alice@example.com"
    assert repo.saved is not None
    assert repo.saved["company_user_id"] == "user_alice"
    assert repo.saved["scope"] == "user"
    assert repo.saved["payload"]["refresh_token"] == "refresh-token"


@pytest.mark.asyncio
async def test_complete_google_oauth_callback_rejects_bad_state(monkeypatch):
    repo = _FakeRepo()
    with pytest.raises(GoogleIntegrationOAuthError, match="Invalid or expired"):
        await complete_google_oauth_callback(code="auth-code", state="bad-state", repo=repo)
