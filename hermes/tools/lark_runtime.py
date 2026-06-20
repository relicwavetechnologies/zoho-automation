"""Resolve per-company Lark clients from the enterprise credential vault.

Mirrors ``tools/zoho_runtime.py`` / ``tools/google_runtime.py``. Enterprise
tools must fail closed when a company has not connected Lark; they must not
silently fall back to shared process env credentials.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from enterprise.lark_token import LarkClient, LarkTokenProvider
from tools.connector_policy import connector_identity_from_kwargs, require_connector_access

logger = logging.getLogger(__name__)

_connection: Any = None
_repository: Any = None
_clients: dict[str, LarkClient] = {}
_user_clients: dict[str, LarkClient] = {}


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


def _timestamp(value: Any) -> float | None:
    if value is None:
        return None
    if hasattr(value, "timestamp"):
        try:
            return float(value.timestamp())
        except Exception:  # noqa: BLE001
            return None
    text = str(value or "").strip()
    if not text:
        return None
    try:
        from datetime import datetime

        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text).timestamp()
    except Exception:  # noqa: BLE001
        return None


def _refresh_lark_user_token(repo: Any, app_creds: Any, user_creds: Any) -> str | None:
    refresh = str(getattr(user_creds, "refresh_token", "") or "").strip()
    if not refresh:
        return None
    try:
        import httpx
    except ModuleNotFoundError:
        return None
    url = f"{str(app_creds.api_base_url).rstrip('/')}/open-apis/authen/v2/oauth/token"
    try:
        resp = httpx.post(
            url,
            json={
                "grant_type": "refresh_token",
                "client_id": app_creds.app_id,
                "client_secret": app_creds.app_secret,
                "refresh_token": refresh,
            },
            timeout=20.0,
        )
        payload = resp.json() if resp.content else {}
    except Exception as exc:  # noqa: BLE001
        logger.debug("Lark user token refresh request failed: %s", exc)
        return None
    code = payload.get("code")
    if resp.status_code >= 400 or code not in (0, None):
        logger.debug("Lark user token refresh failed: http=%s code=%s msg=%s", resp.status_code, code, payload.get("msg"))
        return None
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    access_token = str(data.get("access_token") or "").strip()
    if not access_token:
        return None
    expires_in = int(data.get("expires_in") or data.get("expire") or 7200)
    refresh_expires_in = data.get("refresh_token_expires_in")
    repo.update_lark_user_tokens(
        company_id=user_creds.company_id,
        user_id=user_creds.user_id,
        access_token=access_token,
        refresh_token=str(data.get("refresh_token") or refresh),
        token_type=str(data.get("token_type") or user_creds.token_type or "Bearer"),
        access_token_expires_at=datetime.fromtimestamp(time.time() + expires_in, tz=timezone.utc),
        refresh_token_expires_at=(
            datetime.fromtimestamp(time.time() + int(refresh_expires_in), tz=timezone.utc)
            if refresh_expires_in
            else None
        ),
    )
    return access_token


def resolve_lark_user_client(
    company_id: Optional[str],
    *,
    company_user_id: str | None = None,
    lark_open_id: str | None = None,
    email: str | None = None,
    policy_identity: Mapping[str, Any] | None = None,
) -> Optional[LarkClient]:
    """Build a Lark client backed by the current user's OAuth token."""
    company_id = str(company_id or "").strip()
    if not company_id or not enterprise_enabled():
        return None
    require_connector_access(
        provider="lark",
        company_id=company_id,
        identity=policy_identity,
    )
    cache_key = f"{company_id}:{company_user_id or ''}:{lark_open_id or ''}:{email or ''}"
    cached = _user_clients.get(cache_key)
    if cached is not None:
        return cached
    repo = _get_repository()
    if repo is None:
        return None
    app_creds = repo.get_lark_credentials(company_id, allow_env_fallback=False)
    user_creds = repo.get_lark_user_credentials(
        company_id,
        company_user_id=company_user_id,
        lark_open_id=lark_open_id,
        email=email,
    )
    if user_creds is None:
        return None
    access_token = user_creds.access_token
    exp = _timestamp(user_creds.access_token_expires_at)
    if exp is not None and exp < time.time() + 60 and app_creds is not None:
        refreshed = _refresh_lark_user_token(repo, app_creds, user_creds)
        if refreshed:
            access_token = refreshed
        else:
            from enterprise.lark_token import LarkAuthError

            raise LarkAuthError(
                "Lark user OAuth token is expired and could not be refreshed. "
                "Reconnect Lark for this Hermes app before using user-scoped Lark tools."
            )
    from enterprise.lark_token import LarkStaticTokenProvider

    api_base_url = getattr(app_creds, "api_base_url", "https://open.larksuite.com") if app_creds is not None else "https://open.larksuite.com"
    client = LarkClient(LarkStaticTokenProvider(access_token), api_base_url=api_base_url)
    _user_clients[cache_key] = client
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

    session_company_id = ""
    try:
        from gateway.session_context import get_session_env

        session_company_id = get_session_env("HERMES_COMPANY_ID", "")
    except Exception:  # noqa: BLE001
        session_company_id = ""

    company_id = (
        session_company_id
        or os.getenv("HERMES_COMPANY_ID")
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

    return False


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


def resolve_tool_user_client(kwargs: dict) -> Optional[LarkClient]:
    explicit = kwargs.get("user_client")
    if explicit is not None:
        return explicit
    return resolve_lark_user_client(
        kwargs.get("company_id"),
        company_user_id=kwargs.get("company_user_id"),
        lark_open_id=kwargs.get("lark_open_id") or kwargs.get("lark_user_id"),
        email=kwargs.get("email"),
        policy_identity=connector_identity_from_kwargs(kwargs),
    )


def reset_cache() -> None:
    global _connection, _repository
    _clients.clear()
    _user_clients.clear()
    try:
        from tools.lark_tools import reset_primary_calendar_cache

        reset_primary_calendar_cache()
    except Exception:  # noqa: BLE001
        pass
    if _connection is not None:
        try:
            _connection.close()
        except Exception:  # noqa: BLE001
            pass
    _connection = None
    _repository = None
