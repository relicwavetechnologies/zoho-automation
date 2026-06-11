"""Postgres-backed company/channel identity resolution for Hermes."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional


DEFAULT_COMPANY_SLUG = "default"
DEFAULT_COMPANY_NAME = "Default Company"


def _clean_slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", (value or "").strip().lower())
    cleaned = cleaned.strip("-_")
    return cleaned or DEFAULT_COMPANY_SLUG


def _stable_id(prefix: str, *parts: object) -> str:
    seed = "\x1f".join(str(part or "") for part in parts)
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


def _json_dumps(value: Mapping[str, Any]) -> str:
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"))


@dataclass(frozen=True)
class ResolvedCompanyIdentity:
    company_id: str
    company_user_id: Optional[str]
    channel_identity_id: str
    identity_key: str
    company_role: str = "MEMBER"
    department_id: str = ""


class EnterpriseIdentityRepository:
    """Resolve channel identities against the transformed runtime Postgres DB.

    The connection is injected so tests can use a fake connection and production
    can use a psycopg connection owned by the gateway adapter.
    """

    def __init__(self, connection: Any):
        self._connection = connection

    def ensure_default_company(self) -> str:
        company_id = os.getenv("HERMES_COMPANY_ID", "").strip()
        slug = _clean_slug(os.getenv("HERMES_COMPANY_SLUG", "") or DEFAULT_COMPANY_SLUG)
        display_name = (
            os.getenv("HERMES_COMPANY_NAME", "").strip()
            or os.getenv("HERMES_COMPANY_DISPLAY_NAME", "").strip()
            or DEFAULT_COMPANY_NAME
        )
        if not company_id:
            company_id = f"company_{slug}"

        self._execute(
            """
            INSERT INTO "Company" ("id", "slug", "name")
            VALUES (%s, %s, %s)
            ON CONFLICT ("id") DO UPDATE SET
                "slug" = excluded."slug",
                "name" = excluded."name",
                "updatedAt" = now()
            """,
            (company_id, slug, display_name),
        )
        return company_id

    def resolve_channel_identity(
        self,
        *,
        platform: str,
        chat_id: str,
        user_id: str | None = None,
        user_name: str | None = None,
        user_id_alt: str | None = None,
        thread_id: str | None = None,
        platform_workspace_id: str | None = None,
        company_id: str | None = None,
        raw: Mapping[str, Any] | None = None,
    ) -> ResolvedCompanyIdentity:
        company_id = company_id or self.ensure_default_company()
        platform = str(platform or "unknown")
        chat_id = str(chat_id or "")
        user_id = str(user_id).strip() if user_id else None
        user_id_alt = str(user_id_alt).strip() if user_id_alt else None
        user_name = str(user_name).strip() if user_name else None
        thread_id = str(thread_id).strip() if thread_id else None
        platform_workspace_id = (
            str(platform_workspace_id).strip() if platform_workspace_id else None
        )

        platform_user_id = user_id or user_id_alt
        if platform_user_id:
            identity_key = f"user:{platform_user_id}"
            identity_kind = "user"
            external_user_id = platform_user_id
        else:
            chat_key = chat_id or "unknown"
            if thread_id:
                chat_key = f"{chat_key}:{thread_id}"
            identity_key = f"chat:{chat_key}"
            identity_kind = "channel"
            external_user_id = identity_key

        company_user_id = None
        if platform_user_id:
            company_user_id = _stable_id("cu", company_id, platform, platform_user_id)
            self._upsert_company_user(
                company_user_id=company_user_id,
                company_id=company_id,
                display_name=user_name,
            )

        channel_identity_id = _stable_id("ci", company_id, platform, identity_key)
        raw_payload = {
            "platform": platform,
            "chat_id": chat_id,
            "user_id": user_id,
            "user_id_alt": user_id_alt,
            "user_name": user_name,
            "thread_id": thread_id,
            "platform_workspace_id": platform_workspace_id,
        }
        if raw:
            raw_payload.update(raw)

        row = self._fetchone(
            """
            INSERT INTO "ChannelIdentity" (
                "id",
                "companyId",
                "companyUserId",
                "channel",
                "externalUserId",
                "externalTenantId",
                "displayName",
                "identityKind",
                "identityKey",
                "platformUserIdAlt",
                "platformChatId",
                "platformWorkspaceId",
                "approvedSource",
                "rawJson",
                "firstSeenAt",
                "lastSeenAt",
                "updatedAt"
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, now(), now(), now())
            ON CONFLICT ("channel", "externalUserId", "companyId") DO UPDATE SET
                "companyUserId" = excluded."companyUserId",
                "displayName" = excluded."displayName",
                "identityKind" = excluded."identityKind",
                "identityKey" = excluded."identityKey",
                "platformUserIdAlt" = excluded."platformUserIdAlt",
                "platformChatId" = excluded."platformChatId",
                "platformWorkspaceId" = excluded."platformWorkspaceId",
                "approvedSource" = excluded."approvedSource",
                "rawJson" = excluded."rawJson",
                "lastSeenAt" = now(),
                "updatedAt" = now()
            RETURNING "id", "companyUserId", "identityKey", "aiRole"
            """,
            (
                channel_identity_id,
                company_id,
                company_user_id,
                platform,
                external_user_id,
                platform_workspace_id or chat_id or company_id,
                user_name,
                identity_kind,
                identity_key,
                user_id_alt,
                chat_id,
                platform_workspace_id,
                "gateway",
                _json_dumps(raw_payload),
            ),
        )

        return ResolvedCompanyIdentity(
            company_id=company_id,
            company_user_id=self._row_get(row, "companyUserId") or company_user_id,
            channel_identity_id=self._row_get(row, "id") or channel_identity_id,
            identity_key=self._row_get(row, "identityKey") or identity_key,
            company_role=self._row_get(row, "aiRole") or "MEMBER",
        )

    def bind_session_identity(
        self,
        *,
        session_id: str,
        session_key: str,
        identity: ResolvedCompanyIdentity,
        platform: str | None = None,
        chat_id: str | None = None,
        thread_id: str | None = None,
        binding_source: str = "gateway",
    ) -> None:
        # Canonical run/session persistence belongs to the runtime history
        # writer. Wave 1 only resolves and persists channel identity rows.
        return None

    def _upsert_company_user(
        self,
        *,
        company_user_id: str,
        company_id: str,
        display_name: str | None = None,
        email: str | None = None,
    ) -> None:
        self._execute(
            """
            INSERT INTO "CompanyUser" (
                "id", "companyId", "email", "displayName", "role", "status", "updatedAt"
            )
            VALUES (%s, %s, %s, %s, 'MEMBER', 'active', now())
            ON CONFLICT ("id") DO UPDATE SET
                "email" = COALESCE(excluded."email", "CompanyUser"."email"),
                "displayName" = COALESCE(excluded."displayName", "CompanyUser"."displayName"),
                "updatedAt" = now()
            """,
            (company_user_id, company_id, email, display_name),
        )

    def _execute(self, sql: str, args: tuple[Any, ...]) -> None:
        result = self._connection.execute(sql, args)
        close = getattr(result, "close", None)
        if close is not None:
            close()

    def _fetchone(self, sql: str, args: tuple[Any, ...]) -> Any:
        result = self._connection.execute(sql, args)
        fetchone = getattr(result, "fetchone", None)
        if fetchone is None:
            return None
        try:
            return fetchone()
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()

    @staticmethod
    def _row_get(row: Any, key: str) -> Any:
        if row is None:
            return None
        if isinstance(row, Mapping):
            return row.get(key)
        try:
            return row[key]
        except (KeyError, TypeError, IndexError):
            return None
