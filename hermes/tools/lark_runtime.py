"""Resolve per-company Lark clients from the enterprise credential vault.

Mirrors ``tools/zoho_runtime.py`` / ``tools/google_runtime.py``. Enterprise
tools must fail closed when a company has not connected Lark; they must not
silently fall back to shared process env credentials.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Mapping, Optional

from enterprise.lark_token import LarkClient, LarkTokenProvider
from tools.connector_policy import connector_identity_from_kwargs, require_connector_access

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


def resolve_lark_client(
    company_id: Optional[str],
    *,
    policy_identity: Mapping[str, Any] | None = None,
) -> Optional[LarkClient]:
    """Build (or reuse) a LarkClient for the company, or ``None`` if no creds."""
    company_id = str(company_id or "").strip()
    if not company_id or not enterprise_enabled():
        return None
    require_connector_access(
        provider="lark",
        company_id=company_id,
        identity=policy_identity,
    )

    cached = _clients.get(company_id)
    if cached is not None:
        return cached

    repo = _get_repository()
    if repo is None:
        return None
    creds = repo.get_lark_credentials(company_id, allow_env_fallback=False)
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


def lark_tools_available() -> bool:
    """Whether Lark tool schemas should be exposed to an agent session.

    ``check_fn`` is called without tool-call kwargs, so it cannot validate the
    exact company/user. It should only answer "is there a configured Lark
    runtime surface for this process?". The handler still performs the
    company-scoped credential lookup before any API call.
    """
    if not enterprise_enabled():
        return False

    company_id = (
        os.getenv("HERMES_COMPANY_ID")
        or os.getenv("COMPANY_ID")
        or os.getenv("HERMES_DEFAULT_COMPANY_ID")
        or ""
    ).strip()
    repo = _get_repository()
    if company_id and repo is not None:
        try:
            if repo.get_lark_credentials(company_id, allow_env_fallback=False) is not None:
                return True
        except Exception as exc:  # noqa: BLE001
            logger.debug("Lark credential availability probe failed: %s", exc)

    return bool(
        (os.getenv("LARK_APP_ID") or "").strip()
        and (os.getenv("LARK_APP_SECRET") or "").strip()
    )


def resolve_tool_client(kwargs: dict) -> LarkClient:
    explicit = kwargs.get("client")
    if explicit is not None:
        return explicit
    company_id = kwargs.get("company_id")
    client = resolve_lark_client(
        company_id,
        policy_identity=connector_identity_from_kwargs(kwargs),
    )
    if client is not None:
        return client
    from enterprise.lark_token import LarkAuthError

    raise LarkAuthError(
        f"No Lark credentials for company {company_id}. Connect Lark for this company before using Lark tools."
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
