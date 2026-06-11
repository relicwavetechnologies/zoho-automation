"""Resolve per-company Google clients from the enterprise credential vault.

Mirrors ``tools/zoho_runtime.py``. The Google tools build a
:class:`~enterprise.google_token.GoogleClient` for the ``company_id`` (and, when
mapped, the company user) carried on the tool call, using credentials decrypted
from Postgres. Read-only: tokens refresh in-memory, never written back.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from enterprise.google_token import GoogleClient, GoogleTokenProvider

logger = logging.getLogger(__name__)

_connection: Any = None
_repository: Any = None
_clients: dict[str, GoogleClient] = {}


def enterprise_enabled() -> bool:
    try:
        from enterprise.config import EnterprisePostgresConfig

        return EnterprisePostgresConfig.from_env().enabled
    except Exception:  # noqa: BLE001
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
        logger.warning("Enterprise Google credentials require psycopg (install hermes-agent[enterprise])")
        return None
    _connection = psycopg.connect(cfg.database_url, autocommit=True, row_factory=dict_row)
    _repository = ConnectorCredentialRepository(_connection)
    return _repository


def resolve_google_client(
    company_id: Optional[str], user_id: Optional[str] = None
) -> Optional[GoogleClient]:
    """Build (or reuse) a GoogleClient for the company (preferring the user link).

    Returns ``None`` when enterprise mode is off, no ``company_id`` is present,
    or the company has no Google connection.
    """
    company_id = str(company_id or "").strip()
    if not company_id or not enterprise_enabled():
        return None

    cache_key = f"{company_id}:{user_id or ''}"
    cached = _clients.get(cache_key)
    if cached is not None:
        return cached

    repo = _get_repository()
    if repo is None:
        return None
    creds = repo.get_google_credentials(company_id, user_id)
    if creds is None:
        return None

    seed_exp = None
    if creds.access_token_expires_at is not None:
        try:
            seed_exp = creds.access_token_expires_at.timestamp()
        except Exception:  # noqa: BLE001
            seed_exp = None

    provider = GoogleTokenProvider(
        creds.refresh_token,
        seed_access_token=creds.access_token,
        seed_expires_at=seed_exp,
    )
    client = GoogleClient(provider)
    _clients[cache_key] = client
    return client


def resolve_tool_client(kwargs: dict) -> GoogleClient:
    """Resolve the GoogleClient a tool handler should use, or raise clearly."""
    explicit = kwargs.get("client")
    if explicit is not None:
        return explicit
    company_id = kwargs.get("company_id")
    client = resolve_google_client(company_id, kwargs.get("company_user_id"))
    if client is not None:
        return client
    if enterprise_enabled() and str(company_id or "").strip():
        from enterprise.google_token import GoogleAuthError

        raise GoogleAuthError(
            f"No active Google connection for company {company_id}. "
            "Connect Google for this company before using Google tools."
        )
    from enterprise.google_token import GoogleAuthError

    raise GoogleAuthError("Google is not connected (enterprise mode required).")


def reset_cache() -> None:
    global _connection, _repository
    _clients.clear()
    if _connection is not None:
        try:
            _connection.close()
        except Exception:  # noqa: BLE001
            pass
    _connection = None
    _repository = None
