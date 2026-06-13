"""Gateway adapter for Hermes company identity binding."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any, Mapping, Optional

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


def get_company_user(
    company_user_id: str,
    *,
    company_id: str | None = None,
    db=None,
):
    db = db or get_identity_store()
    getter = getattr(db, "get_company_user", None)
    if getter is None:
        return None
    try:
        return getter(company_user_id, company_id=company_id)
    except TypeError:
        row = getter(company_user_id)
        if company_id and str((row or {}).get("company_id") or (row or {}).get("companyId") or "") != str(company_id):
            return None
        return row


def update_company_user(
    *,
    company_user_id: str,
    company_id: str | None = None,
    role: str | None = None,
    status: str | None = None,
    db=None,
):
    db = db or get_identity_store()
    updater = getattr(db, "update_company_user", None)
    if updater is None:
        raise RuntimeError("identity store does not support company user updates")
    resolved_company_id = company_id or db.ensure_default_company()
    return updater(
        company_user_id=company_user_id,
        company_id=resolved_company_id,
        role=role,
        status=status,
    )


def get_company(company_id: str, db=None):
    db = db or get_identity_store()
    return db.get_company(company_id)


def find_dashboard_company_user(
    *,
    provider: str,
    provider_user_id: str,
    company_id: str | None = None,
    db=None,
):
    db = db or get_identity_store()
    resolved_company_id = company_id or db.ensure_default_company()
    return db.find_dashboard_company_user(
        provider=provider,
        provider_user_id=provider_user_id,
        company_id=resolved_company_id,
    )


def list_channel_identities_for_company_user(company_user_id: str, db=None):
    db = db or get_identity_store()
    return db.list_channel_identities_for_company_user(company_user_id)


def get_session_identity(session_id: str, db=None):
    db = db or get_identity_store()
    getter = getattr(db, "get_session_identity", None)
    if getter is None:
        return None
    return getter(session_id)


def list_session_identities_for_company_user(company_user_id: str, db=None):
    db = db or get_identity_store()
    lister = getattr(db, "list_session_identities_for_company_user", None)
    if lister is None:
        return []
    return lister(company_user_id)


def resolve_dashboard_session_identity(
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
    provider = str(provider or "").strip()
    provider_user_id = str(provider_user_id or "").strip()
    if not provider or not provider_user_id:
        raise ValueError("provider and provider_user_id are required")

    resolved_company_id = company_id or db.ensure_default_company()
    row = upsert_dashboard_member(
        provider=provider,
        provider_user_id=provider_user_id,
        display_name=display_name,
        email=email,
        company_id=resolved_company_id,
        role=role,
        department_id=department_id,
        status=status,
        db=db,
    )
    company_user_id = str((row or {}).get("id") or "")
    if not company_user_id:
        raise RuntimeError("dashboard member upsert did not return a company user id")

    channels = list_channel_identities_for_company_user(company_user_id, db=db)
    channel = None
    for candidate in channels:
        if str(candidate.get("approved_source") or "") == "dashboard_auth":
            channel = candidate
            break
    if channel is None:
        channel = channels[0] if channels else None
    if channel is None:
        raise RuntimeError("dashboard member has no channel identity")

    resolved_role = str((row or {}).get("role") or role or "MEMBER")
    resolved_department_id = str(
        (row or {}).get("department_id")
        or (row or {}).get("departmentId")
        or department_id
        or ""
    )
    return SimpleNamespace(
        company_id=resolved_company_id,
        company_user_id=company_user_id,
        channel_identity_id=str(channel.get("id") or ""),
        company_role=resolved_role,
        department_id=resolved_department_id,
        session_provider=provider,
        session_user_id=provider_user_id,
        display_name=display_name or str((row or {}).get("display_name") or (row or {}).get("displayName") or ""),
        email=email or str((row or {}).get("email") or ""),
    )


def bind_explicit_session_identity(
    *,
    session_id: str,
    session_key: str,
    company_id: str,
    company_user_id: str,
    channel_identity_id: str,
    company_role: str = "",
    department_id: str = "",
    platform: str | None = None,
    chat_id: str | None = None,
    thread_id: str | None = None,
    binding_source: str = "gateway",
    db=None,
) -> None:
    db = db or get_identity_store()
    if not session_id or not session_key:
        raise ValueError("session_id and session_key are required")
    if not company_id or not company_user_id or not channel_identity_id:
        raise ValueError(
            "company_id, company_user_id, and channel_identity_id are required"
        )
    identity = SimpleNamespace(
        company_id=company_id,
        company_user_id=company_user_id,
        channel_identity_id=channel_identity_id,
        company_role=company_role,
        department_id=department_id,
    )
    db.bind_session_identity(
        session_id=session_id,
        session_key=session_key,
        identity=identity,
        platform=platform,
        chat_id=chat_id,
        thread_id=thread_id,
        binding_source=binding_source,
    )
