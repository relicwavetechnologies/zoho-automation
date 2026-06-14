from __future__ import annotations

import time
from types import SimpleNamespace

from tools.zoho_auth import ZohoCredentials, ZohoTokenProvider
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
