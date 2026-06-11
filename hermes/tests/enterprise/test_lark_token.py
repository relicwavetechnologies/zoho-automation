"""Tests for Lark credential resolution + tenant-token provider."""

import base64

import httpx
import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from enterprise.connector_repository import ConnectorCredentialRepository
from enterprise.lark_token import LarkAuthError, LarkTokenProvider

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
    def __init__(self, config_row=None):
        self.config_row = config_row

    def execute(self, sql, args):
        if "LarkWorkspaceConfig" in sql:
            return _Cursor(self.config_row)
        return _Cursor(None)


def test_prefers_per_company_config():
    row = {
        "appId": "cli_app",
        "appSecretEncrypted": _enc("super-secret"),
        "apiBaseUrl": "https://open.feishu.cn",
        "staticTenantAccessTokenEncrypted": None,
    }
    repo = ConnectorCredentialRepository(_Conn(row), encryption_key=RAW_KEY)
    creds = repo.get_lark_credentials("comp_1", env={})
    assert creds is not None
    assert creds.source == "config"
    assert creds.app_id == "cli_app"
    assert creds.app_secret == "super-secret"
    assert creds.api_base_url == "https://open.feishu.cn"


def test_falls_back_to_env():
    repo = ConnectorCredentialRepository(_Conn(None), encryption_key=RAW_KEY)
    creds = repo.get_lark_credentials(
        "comp_1", env={"LARK_APP_ID": "env_app", "LARK_APP_SECRET": "env_secret"}
    )
    assert creds is not None
    assert creds.source == "env"
    assert creds.app_id == "env_app"


def test_none_when_no_config_and_no_env():
    repo = ConnectorCredentialRepository(_Conn(None), encryption_key=RAW_KEY)
    assert repo.get_lark_credentials("comp_1", env={}) is None


@pytest.mark.asyncio
async def test_tenant_token_minted_and_cached():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"code": 0, "msg": "ok", "tenant_access_token": "t-abc", "expire": 7200})

    provider = LarkTokenProvider("cli", "secret", transport=httpx.MockTransport(handler))
    assert await provider.get_token() == "t-abc"
    assert await provider.get_token() == "t-abc"  # cached
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_static_token_used_directly():
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("should not mint when a static token is provided")

    provider = LarkTokenProvider("cli", "secret", static_token="static-xyz", transport=httpx.MockTransport(handler))
    assert await provider.get_token() == "static-xyz"


@pytest.mark.asyncio
async def test_token_error_surfaces():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": 10003, "msg": "bad app secret"})

    provider = LarkTokenProvider("cli", "secret", transport=httpx.MockTransport(handler))
    with pytest.raises(LarkAuthError):
        await provider.get_token()
