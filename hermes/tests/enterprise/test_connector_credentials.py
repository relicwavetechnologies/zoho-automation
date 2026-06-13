"""Tests for Hermes-owned connector credential storage and lookup."""

from __future__ import annotations

import base64
import json
from typing import Any

from enterprise.connector_repository import ConnectorCredentialRepository
from enterprise.token_crypto import decrypt_token, encrypt_token

KEY = b"0" * 32
RAW_KEY = "base64:" + base64.b64encode(KEY).decode()


class _Cursor:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row

    def close(self):
        pass


class _NativeConn:
    def __init__(self, rows: dict[tuple[str, str, str | None], dict[str, Any]] | None = None):
        self.rows = rows or {}
        self.executed: list[tuple[str, tuple[Any, ...]]] = []

    def execute(self, sql, args):
        self.executed.append((sql, args))
        if 'INSERT INTO "HermesConnectorCredential"' in sql:
            return _Cursor(None)
        if 'FROM "HermesConnectorCredential"' in sql:
            if '"companyUserId" = %s' in sql:
                key = (args[2], args[0], args[1])
            else:
                key = (args[1], args[0], None)
            return _Cursor(self.rows.get(key))
        return _Cursor(None)


def _native_row(payload: dict[str, Any], *, scope: str = "company", company_user_id: str | None = None):
    return {
        "payloadEncrypted": encrypt_token(json.dumps(payload), RAW_KEY),
        "metadata": {},
        "scope": scope,
        "companyUserId": company_user_id,
    }


def test_put_connector_credential_encrypts_native_payload():
    conn = _NativeConn()
    repo = ConnectorCredentialRepository(conn, encryption_key=RAW_KEY)

    credential_id = repo.put_connector_credential(
        provider="google",
        company_id="comp_1",
        company_user_id="user_1",
        payload={"refresh_token": "1//refresh-user"},
    )

    assert credential_id.startswith("cc_")
    _, args = conn.executed[-1]
    assert args[1] == "comp_1"
    assert args[2] == "user_1"
    assert args[3] == "google"
    assert args[4] == "user"
    assert "1//refresh-user" not in args[5]
    assert json.loads(decrypt_token(args[5], RAW_KEY)) == {"refresh_token": "1//refresh-user"}


def test_native_zoho_credentials_are_preferred_over_legacy_tables():
    conn = _NativeConn({
        ("zoho", "comp_1", None): _native_row({
            "client_id": "zoho-client",
            "client_secret": "zoho-secret",
            "refresh_token": "zoho-refresh",
            "accounts_base_url": "https://accounts.zoho.eu/",
            "api_base_url": "https://www.zohoapis.eu/",
            "scopes": "ZohoBooks.fullaccess.all",
        })
    })
    repo = ConnectorCredentialRepository(conn, encryption_key=RAW_KEY)

    creds = repo.get_zoho_credentials("comp_1")

    assert creds is not None
    assert creds.client_id == "zoho-client"
    assert creds.client_secret == "zoho-secret"
    assert creds.refresh_token == "zoho-refresh"
    assert creds.accounts_base_url == "https://accounts.zoho.eu"
    assert creds.api_base_url == "https://www.zohoapis.eu"
    assert creds.scopes == ["ZohoBooks.fullaccess.all"]


def test_native_google_user_credentials_do_not_bleed_between_users():
    conn = _NativeConn({
        ("google", "comp_1", "alice"): _native_row(
            {
                "access_token": "ya29.alice",
                "refresh_token": "1//alice",
                "google_email": "alice@example.com",
            },
            scope="user",
            company_user_id="alice",
        )
    })
    repo = ConnectorCredentialRepository(conn, encryption_key=RAW_KEY)

    alice = repo.get_google_credentials("comp_1", "alice")
    bob = repo.get_google_credentials("comp_1", "bob")

    assert alice is not None
    assert alice.source == "user"
    assert alice.user_id == "alice"
    assert alice.access_token == "ya29.alice"
    assert alice.google_email == "alice@example.com"
    assert bob is None


def test_native_google_company_fallback_is_labeled_company_scope():
    conn = _NativeConn({
        ("google", "comp_1", None): _native_row({
            "access_token": "ya29.company",
            "refresh_token": "1//company",
        })
    })
    repo = ConnectorCredentialRepository(conn, encryption_key=RAW_KEY)

    creds = repo.get_google_credentials("comp_1", "alice")

    assert creds is not None
    assert creds.source == "company"
    assert creds.user_id is None
    assert creds.access_token == "ya29.company"


def test_lark_env_fallback_can_be_disabled_for_enterprise_runtime():
    repo = ConnectorCredentialRepository(_NativeConn(), encryption_key=RAW_KEY)

    creds = repo.get_lark_credentials(
        "comp_1",
        env={"LARK_APP_ID": "env_app", "LARK_APP_SECRET": "env_secret"},
        allow_env_fallback=False,
    )

    assert creds is None
