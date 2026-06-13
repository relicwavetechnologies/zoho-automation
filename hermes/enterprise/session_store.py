"""Session store routing between local SQLite and enterprise Postgres."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import HTTPException, Request

from .config import EnterprisePostgresConfig
from .db import enterprise_postgres_enabled, get_enterprise_connection
from .session_repository import CompanySessionScope, EnterpriseSessionRepository


@dataclass(frozen=True)
class DashboardCompanyIdentity:
    company_id: str
    company_user_id: str
    channel_identity_id: str = ""
    company_role: str = ""
    department_id: str = ""


class SessionBackend(Protocol):
    def list_sessions(
        self,
        *,
        limit: int,
        offset: int,
        min_message_count: int,
        include_archived: bool,
        archived_only: bool,
        order_by_last_active: bool,
    ) -> tuple[list[dict[str, Any]], int]: ...

    def resolve_session_id(self, session_id: str) -> str | None: ...

    def get_session(self, session_id: str) -> dict[str, Any] | None: ...

    def get_messages(self, session_id: str) -> list[dict[str, Any]]: ...

    def delete_session(self, session_id: str) -> bool: ...

    def delete_sessions(self, session_ids: list[str]) -> int: ...

    def update_session(
        self,
        session_id: str,
        *,
        title: str | None = None,
        archived: bool | None = None,
    ) -> dict[str, Any]: ...

    def export_session(self, session_id: str) -> dict[str, Any] | None: ...

    def close(self) -> None: ...


def resolve_dashboard_company_identity(request: Request) -> DashboardCompanyIdentity:
    from gateway.company_identity import (
        list_session_identities_for_company_user,
        resolve_dashboard_session_identity,
    )

    sess = getattr(request.state, "session", None)
    if sess is None:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        identity = resolve_dashboard_session_identity(
            provider=getattr(sess, "provider", "") or "",
            provider_user_id=getattr(sess, "user_id", "") or "",
            display_name=getattr(sess, "display_name", "") or None,
            email=getattr(sess, "email", "") or None,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Company identity unavailable: {exc}",
        ) from exc
    if not identity.company_id or not identity.company_user_id:
        raise HTTPException(status_code=503, detail="Company identity incomplete")
    # Touch lister so identity store failures surface consistently.
    list_session_identities_for_company_user(str(identity.company_user_id))
    return DashboardCompanyIdentity(
        company_id=str(identity.company_id),
        company_user_id=str(identity.company_user_id),
        channel_identity_id=str(identity.channel_identity_id or ""),
        company_role=str(identity.company_role or ""),
        department_id=str(identity.department_id or ""),
    )


def company_enterprise_session_mode(request: Request) -> DashboardCompanyIdentity | None:
    if not getattr(request.app.state, "auth_required", False):
        return None
    if not enterprise_postgres_enabled():
        return None
    return resolve_dashboard_company_identity(request)


def get_session_backend(request: Request) -> SessionBackend:
    identity = company_enterprise_session_mode(request)
    if identity is None:
        from hermes_state import SessionDB

        return LocalSessionBackend(SessionDB())
    return EnterpriseSessionBackend(
        identity,
        EnterpriseSessionRepository(get_enterprise_connection()),
    )


class LocalSessionBackend:
    def __init__(self, db: Any):
        self._db = db

    def list_sessions(
        self,
        *,
        limit: int,
        offset: int,
        min_message_count: int,
        include_archived: bool,
        archived_only: bool,
        order_by_last_active: bool,
    ) -> tuple[list[dict[str, Any]], int]:
        sessions = self._db.list_sessions_rich(
            limit=limit,
            offset=offset,
            min_message_count=min_message_count,
            include_archived=include_archived,
            archived_only=archived_only,
            order_by_last_active=order_by_last_active,
        )
        total = self._db.session_count(
            min_message_count=min_message_count,
            include_archived=include_archived,
            archived_only=archived_only,
        )
        return sessions, total

    def resolve_session_id(self, session_id: str) -> str | None:
        return self._db.resolve_session_id(session_id)

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        sid = self.resolve_session_id(session_id)
        return self._db.get_session(sid) if sid else None

    def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        sid = self.resolve_session_id(session_id)
        if not sid:
            return []
        return self._db.get_messages(sid)

    def delete_session(self, session_id: str) -> bool:
        sid = self.resolve_session_id(session_id)
        if not sid:
            return False
        return bool(self._db.delete_session(sid))

    def delete_sessions(self, session_ids: list[str]) -> int:
        resolved = []
        for session_id in session_ids:
            sid = self.resolve_session_id(session_id)
            if sid:
                resolved.append(sid)
        return int(self._db.delete_sessions(resolved) or 0)

    def update_session(
        self,
        session_id: str,
        *,
        title: str | None = None,
        archived: bool | None = None,
    ) -> dict[str, Any]:
        sid = self.resolve_session_id(session_id)
        if not sid:
            raise KeyError(session_id)
        if title is not None:
            self._db.set_session_title(sid, title or "")
        if archived is not None:
            self._db.set_session_archived(sid, archived)
        result = {"ok": True, "title": self._db.get_session_title(sid) or ""}
        if archived is not None:
            result["archived"] = bool(archived)
        return result

    def export_session(self, session_id: str) -> dict[str, Any] | None:
        sid = self.resolve_session_id(session_id)
        if not sid:
            return None
        return self._db.export_session(sid)

    def close(self) -> None:
        self._db.close()


class EnterpriseSessionBackend:
    def __init__(self, identity: DashboardCompanyIdentity, repo: EnterpriseSessionRepository):
        self._identity = identity
        self._repo = repo

    @property
    def scope(self) -> CompanySessionScope:
        return CompanySessionScope(
            company_id=self._identity.company_id,
            company_user_id=self._identity.company_user_id,
            channel_identity_id=self._identity.channel_identity_id,
            company_role=self._identity.company_role,
            department_id=self._identity.department_id,
        )

    def list_sessions(
        self,
        *,
        limit: int,
        offset: int,
        min_message_count: int,
        include_archived: bool,
        archived_only: bool,
        order_by_last_active: bool,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._repo.list_sessions_for_user(
            self.scope,
            limit=limit,
            offset=offset,
            min_message_count=min_message_count,
            include_archived=include_archived,
            archived_only=archived_only,
            order_by_last_active=order_by_last_active,
        )

    def resolve_session_id(self, session_id: str) -> str | None:
        return self._repo.resolve_session_id(self.scope, session_id)

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        sid = self.resolve_session_id(session_id)
        if not sid:
            return None
        return self._repo.get_session_for_user(self.scope, sid)

    def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        sid = self.resolve_session_id(session_id)
        if not sid:
            return []
        return self._repo.list_messages_for_session(self.scope, sid)

    def delete_session(self, session_id: str) -> bool:
        sid = self.resolve_session_id(session_id)
        if not sid:
            return False
        return self._repo.delete_session(self.scope, sid)

    def delete_sessions(self, session_ids: list[str]) -> int:
        resolved = []
        for session_id in session_ids:
            sid = self.resolve_session_id(session_id)
            if sid:
                resolved.append(sid)
        return self._repo.delete_sessions(self.scope, resolved)

    def update_session(
        self,
        session_id: str,
        *,
        title: str | None = None,
        archived: bool | None = None,
    ) -> dict[str, Any]:
        sid = self.resolve_session_id(session_id)
        if not sid:
            raise KeyError(session_id)
        if title is not None:
            self._repo.update_session_title(self.scope, sid, title or None)
        if archived is not None:
            self._repo.set_session_archived(self.scope, sid, archived)
        session = self._repo.get_session_for_user(self.scope, sid) or {}
        result = {"ok": True, "title": session.get("title") or ""}
        if archived is not None:
            result["archived"] = bool(archived)
        return result

    def export_session(self, session_id: str) -> dict[str, Any] | None:
        sid = self.resolve_session_id(session_id)
        if not sid:
            return None
        return self._repo.export_session(self.scope, sid)

    def close(self) -> None:
        return None


def use_enterprise_session_store_from_env() -> bool:
    """True when the current process should persist chat to Postgres only."""
    if not enterprise_postgres_enabled():
        return False
    try:
        from gateway.session_context import get_session_env
    except Exception:
        return False
    company_id = str(get_session_env("HERMES_COMPANY_ID") or "").strip()
    company_user_id = str(get_session_env("HERMES_COMPANY_USER_ID") or "").strip()
    return bool(company_id and company_user_id)


def current_company_session_scope() -> CompanySessionScope | None:
    if not use_enterprise_session_store_from_env():
        return None
    from gateway.session_context import get_session_env

    return CompanySessionScope(
        company_id=str(get_session_env("HERMES_COMPANY_ID") or "").strip(),
        company_user_id=str(get_session_env("HERMES_COMPANY_USER_ID") or "").strip(),
        channel_identity_id=str(get_session_env("HERMES_CHANNEL_IDENTITY_ID") or "").strip(),
        company_role=str(get_session_env("HERMES_COMPANY_ROLE") or "").strip(),
        department_id=str(get_session_env("HERMES_DEPARTMENT_ID") or "").strip(),
    )


def get_enterprise_session_repository() -> EnterpriseSessionRepository:
    return EnterpriseSessionRepository(get_enterprise_connection())
