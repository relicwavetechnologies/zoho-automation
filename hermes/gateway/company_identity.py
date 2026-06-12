"""Gateway adapter for Hermes company identity binding."""

from __future__ import annotations

import logging
from typing import Optional

from company_identity import CompanyIdentity, CompanyIdentityDB
from enterprise.config import EnterprisePostgresConfig
from enterprise.identity_repository import EnterpriseIdentityRepository

logger = logging.getLogger(__name__)


_identity_db: Optional[CompanyIdentityDB] = None
_enterprise_identity_store: Optional[EnterpriseIdentityRepository] = None


def is_enterprise_identity_enabled() -> bool:
    return EnterprisePostgresConfig.from_env().enabled


def get_company_identity_db() -> CompanyIdentityDB:
    global _identity_db
    if _identity_db is None:
        _identity_db = CompanyIdentityDB()
    return _identity_db


def get_enterprise_identity_store() -> EnterpriseIdentityRepository:
    global _enterprise_identity_store
    if _enterprise_identity_store is not None:
        return _enterprise_identity_store

    config = EnterprisePostgresConfig.from_env()
    if not config.enabled:
        raise RuntimeError("Enterprise Postgres identity is disabled")
    if not config.database_url:
        raise RuntimeError("Enterprise Postgres identity is enabled but no database URL is configured")

    try:
        import psycopg
        from psycopg.rows import dict_row
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Enterprise Postgres identity requires installing hermes-agent[enterprise]"
        ) from exc

    connection = psycopg.connect(
        config.database_url,
        autocommit=True,
        row_factory=dict_row,
    )
    _enterprise_identity_store = EnterpriseIdentityRepository(connection)
    return _enterprise_identity_store


def get_identity_store():
    if is_enterprise_identity_enabled():
        return get_enterprise_identity_store()
    return get_company_identity_db()


def resolve_identity_for_source(source, db=None) -> CompanyIdentity:
    """Resolve a gateway SessionSource into a stable company identity."""
    db = db or get_identity_store()
    platform = source.platform.value if getattr(source.platform, "value", None) else str(source.platform)
    workspace_id = getattr(source, "guild_id", None) or getattr(source, "parent_chat_id", None)
    return db.resolve_channel_identity(
        platform=platform,
        chat_id=str(getattr(source, "chat_id", "") or ""),
        user_id=getattr(source, "user_id", None),
        user_name=getattr(source, "user_name", None),
        user_id_alt=getattr(source, "user_id_alt", None),
        thread_id=getattr(source, "thread_id", None),
        platform_workspace_id=workspace_id,
        raw=getattr(source, "to_dict", lambda: {})(),
    )


def bind_session_identity(session_entry, source, db=None) -> CompanyIdentity:
    """Resolve identity and bind it to the current Hermes session."""
    db = db or get_identity_store()
    identity = resolve_identity_for_source(source, db=db)
    platform = source.platform.value if getattr(source.platform, "value", None) else str(source.platform)
    db.bind_session_identity(
        session_id=session_entry.session_id,
        session_key=session_entry.session_key,
        identity=identity,
        platform=platform,
        chat_id=str(getattr(source, "chat_id", "") or ""),
        thread_id=str(getattr(source, "thread_id", "") or "") or None,
    )
    session_entry.company_id = identity.company_id
    session_entry.company_user_id = identity.company_user_id
    session_entry.channel_identity_id = identity.channel_identity_id
    session_entry.company_role = getattr(identity, "company_role", "") or session_entry.company_role
    session_entry.department_id = getattr(identity, "department_id", "") or session_entry.department_id
    return identity


def upsert_dashboard_member(
    *,
    provider: str,
    provider_user_id: str,
    display_name: str | None = None,
    email: str | None = None,
    company_id: str | None = None,
    role: str | None = None,
    department_id: str | None = None,
    status: str = "active",
    db=None,
):
    db = db or get_identity_store()
    resolved_company_id = company_id or db.ensure_default_company()
    return db.upsert_dashboard_member(
        provider=provider,
        provider_user_id=provider_user_id,
        display_name=display_name,
        email=email,
        company_id=resolved_company_id,
        role=role,
        department_id=department_id,
        status=status,
    )


def list_company_users(*, company_id: str | None = None, db=None):
    db = db or get_identity_store()
    resolved_company_id = company_id or db.ensure_default_company()
    return db.list_company_users(company_id=resolved_company_id)
