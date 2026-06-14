from __future__ import annotations

import time
from types import SimpleNamespace

from enterprise.connector_repository import ZohoConnectionCredentials
from tools.zoho_auth import ZohoCredentials, ZohoTokenProvider
from tools import zoho_runtime
from tools.zoho_runtime import _seed_access_token


def test_seed_access_token_accepts_iso_expiry_from_connector_store():
    provider = ZohoTokenProvider(
        ZohoCredentials(
            client_id="client",
            client_secret="secret",
            refresh_token="refresh",
        )
    )

    _seed_access_token(
        provider,
        SimpleNamespace(
            access_token="stored-access",
            access_token_expires_at="2099-01-01T00:00:00+00:00",
            api_domain="https://www.zohoapis.com",
        ),
    )

    assert provider._cached_token is not None
    assert provider._cached_token.access_token == "stored-access"
    assert provider._cached_token.expires_at > time.time()
    assert provider._cached_token.api_domain == "https://www.zohoapis.com"


def test_resolve_zoho_client_uses_connector_store_organization_id(monkeypatch):
    class Repo:
        def get_zoho_credentials(self, company_id: str):
            assert company_id == "comp_1"
            return ZohoConnectionCredentials(
                company_id=company_id,
                client_id="client",
                client_secret="secret",
                refresh_token="refresh",
                organization_id="org-123",
                accounts_base_url="https://accounts.zoho.com",
                api_base_url="https://www.zohoapis.com",
            )

    zoho_runtime.reset_cache()
    monkeypatch.setattr(zoho_runtime, "enterprise_enabled", lambda: True)
    monkeypatch.setattr(zoho_runtime, "_get_repository", lambda: Repo())

    client = zoho_runtime.resolve_tool_client({"company_id": "comp_1"})

    assert client.organization_id == "org-123"
    assert client.token_provider.credentials.organization_id == "org-123"
