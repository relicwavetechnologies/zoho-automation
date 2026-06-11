"""Resolve per-company Lark clients from the enterprise credential vault.

Mirrors ``tools/zoho_runtime.py`` / ``tools/google_runtime.py``. Prefers a
per-company ``LarkWorkspaceConfig``; falls back to shared ``LARK_APP_*`` env
credentials (what Divo uses today).
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from enterprise.lark_token import LarkClient, LarkTokenProvider

logger = logging.getLogger(__name__)

_connection: Any = None
_repository: Any = None
_clients: dict[str, LarkClient] = {}


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
    # Lark has an env fallback, so we still build a repository even though the
    # DB may have no per-company row — get_lark_credentials handles the fallback.
    if not cfg.enabled or not cfg.database_url:
        return None
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ModuleNotFoundError:
        return None
    _connection = psycopg.connect(cfg.database_url, autocommit=True, row_factory=dict_row)
    _repository = ConnectorCredentialRepository(_connection)
    return _repository


def resolve_lark_client(company_id: Optional[str]) -> Optional[LarkClient]:
    """Build (or reuse) a LarkClient for the company, or ``None`` if no creds."""
    company_id = str(company_id or "").strip()
    if not company_id or not enterprise_enabled():
        return None

    cached = _clients.get(company_id)
    if cached is not None:
        return cached

    repo = _get_repository()
    if repo is None:
        return None
    creds = repo.get_lark_credentials(company_id)
    if creds is None:
        return None

    provider = LarkTokenProvider(
        creds.app_id,
        creds.app_secret,
        api_base_url=creds.api_base_url,
        static_token=creds.static_tenant_access_token,
    )
    client = LarkClient(provider, api_base_url=creds.api_base_url)
    _clients[company_id] = client
    return client


def resolve_tool_client(kwargs: dict) -> LarkClient:
    explicit = kwargs.get("client")
    if explicit is not None:
        return explicit
    company_id = kwargs.get("company_id")
    client = resolve_lark_client(company_id)
    if client is not None:
        return client
    from enterprise.lark_token import LarkAuthError

    raise LarkAuthError(
        f"No Lark credentials for company {company_id} (no LarkWorkspaceConfig and no LARK_APP_* env)."
    )


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
