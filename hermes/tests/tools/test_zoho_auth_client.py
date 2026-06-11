import asyncio

import httpx

from tools.zoho_auth import ZohoCredentials, ZohoTokenProvider, check_zoho_requirements
from tools.zoho_client import ZohoClient, normalize_crm_module, parse_date_filter


def test_zoho_credentials_from_env_and_check(monkeypatch):
    monkeypatch.delenv("ZOHO_CLIENT_ID", raising=False)
    monkeypatch.delenv("ZOHO_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("ZOHO_REFRESH_TOKEN", raising=False)
    assert ZohoCredentials.from_env(required=False) is None
    assert check_zoho_requirements() is False

    monkeypatch.setenv("ZOHO_CLIENT_ID", "client")
    monkeypatch.setenv("ZOHO_CLIENT_SECRET", "secret")
    monkeypatch.setenv("ZOHO_REFRESH_TOKEN", "refresh")
    monkeypatch.setenv("ZOHO_ORGANIZATION_ID", "org-1")

    creds = ZohoCredentials.from_env()
    assert creds.client_id == "client"
    assert creds.client_secret == "secret"
    assert creds.refresh_token == "refresh"
    assert creds.organization_id == "org-1"
    assert check_zoho_requirements() is True


def test_zoho_token_provider_refreshes_and_caches():
    calls = {"token": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/oauth/v2/token"
        calls["token"] += 1
        return httpx.Response(
            200,
            json={
                "access_token": f"token-{calls['token']}",
                "expires_in": 3600,
                "token_type": "Bearer",
            },
        )

    transport = httpx.MockTransport(handler)
    creds = ZohoCredentials(
        client_id="client",
        client_secret="secret",
        refresh_token="refresh",
    )
    provider = ZohoTokenProvider(creds, transport=transport)

    async def run():
        first = await provider.get_access_token()
        second = await provider.get_access_token()
        forced = await provider.get_access_token(force_refresh=True)
        return first, second, forced

    assert asyncio.run(run()) == ("token-1", "token-1", "token-2")
    assert calls["token"] == 2


def test_zoho_books_pagination_dedupes_and_resolves_org():
    seen_paths = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path == "/oauth/v2/token":
            return httpx.Response(200, json={"access_token": "token", "expires_in": 3600})
        if request.url.path == "/books/v3/organizations":
            return httpx.Response(
                200,
                json={"organizations": [{"organization_id": "org-1", "is_default_org": True}]},
            )
        if request.url.path == "/books/v3/invoices":
            page = request.url.params.get("page")
            if page == "1":
                return httpx.Response(
                    200,
                    json={
                        "invoices": [{"invoice_id": "inv-1"}, {"invoice_id": "inv-2"}],
                        "page_context": {"has_more_page": True},
                    },
                )
            return httpx.Response(
                200,
                json={
                    "invoices": [{"invoice_id": "inv-2"}, {"invoice_id": "inv-3"}],
                    "page_context": {"has_more_page": False},
                },
            )
        raise AssertionError(f"unexpected path {request.url}")

    transport = httpx.MockTransport(handler)
    creds = ZohoCredentials(
        client_id="client",
        client_secret="secret",
        refresh_token="refresh",
    )
    provider = ZohoTokenProvider(creds, transport=transport)
    client = ZohoClient(provider, transport=transport)

    async def run():
        return await client.books_list_all_records("invoices")

    result = asyncio.run(run())
    assert [item["invoice_id"] for item in result["items"]] == ["inv-1", "inv-2", "inv-3"]
    assert result["organizationId"] == "org-1"
    assert result["truncated"] is False
    assert "/books/v3/organizations" in seen_paths


def test_date_filter_and_crm_module_helpers():
    assert parse_date_filter("Q1 2026") == {"from": "2026-01-01", "to": "2026-03-31"}
    assert parse_date_filter("2026") == {"from": "2026-01-01", "to": "2026-12-31"}
    assert normalize_crm_module("deal") == "Deals"
    assert normalize_crm_module("company") == "Accounts"
