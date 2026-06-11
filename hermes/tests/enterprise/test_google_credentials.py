"""Tests for Google credential resolution + token provider."""

import base64

import httpx
import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from enterprise.connector_repository import ConnectorCredentialRepository
from enterprise.google_token import GoogleAuthError, GoogleTokenProvider

KEY = b"0" * 32
RAW_KEY = "base64:" + base64.b64encode(KEY).decode()


def _enc(plaintext: str) -> str:
    iv = b"n" * 12
    sealed = AESGCM(KEY).encrypt(iv, plaintext.encode(), None)
    ct, tag = sealed[:-16], sealed[-16:]
    return f"v1:{base64.b64encode(iv).decode()}:{base64.b64encode(tag).decode()}:{base64.b64encode(ct).decode()}"


class _Cursor:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row

    def close(self):
        pass


class _Conn:
    """Returns a user row only for the GoogleUserAuthLink query."""

    def __init__(self, *, user_row=None, company_row=None):
        self.user_row = user_row
        self.company_row = company_row

    def execute(self, sql, args):
        if "GoogleUserAuthLink" in sql:
            return _Cursor(self.user_row)
        if "CompanyGoogleAuthLink" in sql:
            return _Cursor(self.company_row)
        return _Cursor(None)


def test_prefers_user_link_when_present():
    user_row = {
        "googleEmail": "user@x.com",
        "scope": "gmail.readonly",
        "tokenType": "Bearer",
        "accessTokenEncrypted": _enc("ya29.user"),
        "refreshTokenEncrypted": _enc("1//refresh-user"),
        "accessTokenExpiresAt": None,
    }
    repo = ConnectorCredentialRepository(_Conn(user_row=user_row), encryption_key=RAW_KEY)
    creds = repo.get_google_credentials("comp_1", "user_1")
    assert creds is not None
    assert creds.source == "user"
    assert creds.google_email == "user@x.com"
    assert creds.access_token == "ya29.user"
    assert creds.refresh_token == "1//refresh-user"


def test_falls_back_to_company_link():
    company_row = {
        "googleEmail": "company@x.com",
        "scope": None,
        "tokenType": None,
        "accessTokenEncrypted": _enc("ya29.company"),
        "refreshTokenEncrypted": _enc("1//refresh-company"),
        "accessTokenExpiresAt": None,
    }
    # user_id given but no user row → falls back to company row
    repo = ConnectorCredentialRepository(_Conn(company_row=company_row), encryption_key=RAW_KEY)
    creds = repo.get_google_credentials("comp_1", "user_1")
    assert creds is not None
    assert creds.source == "company"
    assert creds.access_token == "ya29.company"
    assert creds.token_type == "Bearer"


def test_returns_none_when_no_link():
    repo = ConnectorCredentialRepository(_Conn(), encryption_key=RAW_KEY)
    assert repo.get_google_credentials("comp_1") is None


@pytest.mark.asyncio
async def test_token_provider_refreshes_and_caches():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"access_token": "ya29.fresh", "expires_in": 3600})

    provider = GoogleTokenProvider(
        "1//refresh",
        client_id="cid",
        client_secret="secret",
        transport=httpx.MockTransport(handler),
    )
    assert await provider.get_access_token() == "ya29.fresh"
    # second call served from cache, no extra refresh
    assert await provider.get_access_token() == "ya29.fresh"
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_token_provider_uses_seed_without_network():
    import time

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("should not refresh when a valid seed token exists")

    provider = GoogleTokenProvider(
        "1//refresh",
        client_id="cid",
        client_secret="secret",
        seed_access_token="ya29.seed",
        seed_expires_at=time.time() + 3600,
        transport=httpx.MockTransport(handler),
    )
    assert await provider.get_access_token() == "ya29.seed"


@pytest.mark.asyncio
async def test_token_provider_without_refresh_raises():
    provider = GoogleTokenProvider("", client_id="cid", client_secret="secret")
    with pytest.raises(GoogleAuthError):
        await provider.get_access_token()
