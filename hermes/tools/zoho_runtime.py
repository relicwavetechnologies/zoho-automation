"""Resolve per-company Zoho clients from the enterprise credential vault.

In enterprise mode the Zoho tools no longer read a single set of env
credentials — they build a :class:`~tools.zoho_client.ZohoClient` for the
``company_id`` carried on the tool call, using credentials decrypted from the
runtime's Postgres (``ZohoConnectionProfile``). All execution, refresh,
pagination, and org-id resolution reuse the existing client machinery; only the
credential *source* changes.

Read-only: the in-memory token provider refreshes access tokens as they near
expiry but never writes them back to Postgres (this phase). Per-company clients
are cached so the refreshed access token is reused across tool calls rather than
re-fetched every time (mirrors Divo's ``zoho-token.service.ts`` caching).
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from tools.zoho_auth import (
    CachedZohoAccessToken,
    ZohoCredentials,
    ZohoTokenProvider,
)
from tools.zoho_client import ZohoClient

logger = logging.getLogger(__name__)

# Cached psycopg connection + repository + per-company clients (process-local).
_connection: Any = None
_repository: Any = None
_company_clients: dict[str, ZohoClient] = {}


def enterprise_enabled() -> bool:
    """True when the runtime's enterprise Postgres boundary is configured."""
    try:
        from enterprise.config import EnterprisePostgresConfig

        return EnterprisePostgresConfig.from_env().enabled
    except Exception:  # noqa: BLE001 — never let config probing break dispatch
        return False


def _get_repository():
    global _connection, _repository
    if _repository is not None:
        return _repository
    try:
        from enterprise.config import EnterprisePostgresConfig
        from enterprise.connector_repository import ConnectorCredentialRepository
    except Exception:  # noqa: BLE001
        return None

    cfg = EnterprisePostgresConfig.from_env()
    if not cfg.enabled or not cfg.database_url:
        return None
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ModuleNotFoundError:
        logger.warning("Enterprise Zoho credentials require psycopg (install hermes-agent[enterprise])")
        return None

    _connection = psycopg.connect(cfg.database_url, autocommit=True, row_factory=dict_row)
    _repository = ConnectorCredentialRepository(_connection)
    return _repository


def _seed_access_token(provider: ZohoTokenProvider, creds: Any) -> None:
    """Pre-populate the provider's cache with the stored access token.

    Avoids an unnecessary refresh on the first call when the DB already holds a
    still-valid access token (Divo reuses the stored token until expiry).
    """
    if not creds.access_token or creds.access_token_expires_at is None:
        return
    try:
        expires_at = creds.access_token_expires_at.timestamp()
    except Exception:  # noqa: BLE001 — non-datetime / naive value ⇒ skip seeding
        return
    provider._cached_token = CachedZohoAccessToken(
        access_token=creds.access_token,
        expires_at=expires_at,
        api_domain=creds.api_domain,
    )


def resolve_zoho_client(
    company_id: Optional[str], **client_kwargs: Any
) -> Optional[ZohoClient]:
    """Build (or reuse) a ZohoClient for *company_id* from the vault.

    Returns ``None`` when enterprise mode is off or no ``company_id`` is present
    — the caller then falls back to env credentials (single-user/dev). Raises
    nothing; an active-but-unconnected company simply yields ``None`` so the
    caller can surface a precise "not connected" error.
    """
    company_id = str(company_id or "").strip()
    if not company_id or not enterprise_enabled():
        return None

    cached = _company_clients.get(company_id)
    if cached is not None:
        return cached

    repo = _get_repository()
    if repo is None:
        return None
    creds = repo.get_zoho_credentials(company_id)
    if creds is None:
        return None

    credentials = ZohoCredentials(
        client_id=creds.client_id,
        client_secret=creds.client_secret,
        refresh_token=creds.refresh_token,
        organization_id=None,  # resolved at runtime from /organizations
        accounts_base_url=creds.accounts_base_url or ZohoCredentials.accounts_base_url,
        api_base_url=creds.api_base_url or ZohoCredentials.api_base_url,
        scopes=(" ".join(creds.scopes) or None),
    )
    provider = ZohoTokenProvider(credentials)
    _seed_access_token(provider, creds)
    client = ZohoClient(
        provider,
        api_base_url=credentials.api_base_url,
        organization_id=None,
        **client_kwargs,
    )
    _company_clients[company_id] = client
    return client


def resolve_tool_client(kwargs: dict) -> ZohoClient:
    """Resolve the ZohoClient a tool handler should use.

    Precedence: explicit ``client`` kwarg (tests) → per-company vault client
    (enterprise mode) → env credentials (single-user/dev). When enterprise mode
    is on and a ``company_id`` is present but has no active connection, raise a
    precise error instead of silently falling back to env credentials.
    """
    explicit = kwargs.get("client")
    if explicit is not None:
        return explicit

    company_id = kwargs.get("company_id")
    client = resolve_zoho_client(company_id)
    if client is not None:
        return client

    if enterprise_enabled() and str(company_id or "").strip():
        from tools.zoho_client import ZohoClientError

        raise ZohoClientError(
            f"No active Zoho connection for company {company_id}. "
            "Connect Zoho for this company before using Zoho tools."
        )

    return ZohoClient.from_env()


def reset_cache() -> None:
    """Drop cached clients/connection (tests, credential rotation)."""
    global _connection, _repository
    _company_clients.clear()
    if _connection is not None:
        try:
            _connection.close()
        except Exception:  # noqa: BLE001
            pass
    _connection = None
    _repository = None
