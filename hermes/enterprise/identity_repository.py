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
DISABLED_COMPANY_USER_STATUSES = {"disabled", "inactive", "suspended"}


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


def _normalize_text(value: str | None, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _is_disabled_status(value: Any) -> bool:
    return str(value or "").strip().lower() in DISABLED_COMPANY_USER_STATUSES


def _canonical_channel(value: str | None) -> str:
    channel = str(value or "unknown").strip().lower() or "unknown"
    if channel == "feishu":
        return "lark"
    return channel


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
        self._ensure_company(company_id, slug=slug, display_name=display_name)
        return company_id

    def _ensure_company(
        self,
        company_id: str,
        *,
        slug: str | None = None,
        display_name: str | None = None,
    ) -> None:
        effective_slug = slug or _clean_slug(company_id.removeprefix("company_"))
        effective_name = display_name or company_id.replace("_", " ").strip() or DEFAULT_COMPANY_NAME
        self._execute(
            """
            INSERT INTO "Company" ("id", "slug", "name", "updatedAt")
            VALUES (%s, %s, %s, now())
            ON CONFLICT ("id") DO UPDATE SET
                "slug" = excluded."slug",
                "name" = excluded."name",
                "updatedAt" = now()
            """,
            (company_id, effective_slug, effective_name),
        )

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
        platform = _canonical_channel(platform)
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

        existing_identity = self._find_existing_channel_identity(
            company_id=company_id,
            platform=platform,
            identity_key=identity_key,
            platform_user_id=platform_user_id,
            user_id_alt=user_id_alt,
        )

        company_user_id = self._row_get(existing_identity, "companyUserId")
        if platform_user_id:
            company_user_id = company_user_id or _stable_id(
                "cu", company_id, platform, platform_user_id
            )
            self._upsert_company_user(
                company_user_id=company_user_id,
                company_id=company_id,
                display_name=user_name or self._row_get(existing_identity, "displayName"),
                email=self._row_get(existing_identity, "email"),
            )

        channel_identity_id = self._row_get(existing_identity, "id") or _stable_id(
            "ci", company_id, platform, identity_key
        )
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
                "displayName" = COALESCE(excluded."displayName", "ChannelIdentity"."displayName"),
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

    def _find_existing_channel_identity(
        self,
        *,
        company_id: str,
        platform: str,
        identity_key: str,
        platform_user_id: str | None,
        user_id_alt: str | None,
    ) -> Any:
        if not platform_user_id and not user_id_alt:
            return None
        return self._fetchone(
            """
            SELECT ci."id",
                   ci."companyUserId",
                   ci."displayName",
                   COALESCE(cu."email", ci."email") AS "email",
                   COALESCE(cu."role", ci."aiRole") AS "aiRole"
            FROM "ChannelIdentity" ci
            LEFT JOIN "CompanyUser" cu
              ON cu."id" = ci."companyUserId" AND cu."companyId" = ci."companyId"
            WHERE ci."companyId" = %s
              AND (
                (ci."channel" = %s AND (ci."identityKey" = %s OR ci."externalUserId" = %s))
                OR ci."larkOpenId" = %s
                OR ci."platformUserIdAlt" = %s
              )
            ORDER BY
              CASE WHEN COALESCE(cu."email", ci."email", '') <> '' THEN 0 ELSE 1 END,
              CASE WHEN ci."approvedSource" = 'dashboard_auth' THEN 0 ELSE 1 END,
              CASE WHEN COALESCE(cu."role", '') IN ('SUPER_ADMIN', 'OWNER', 'COMPANY_ADMIN', 'ADMIN') THEN 0 ELSE 1 END,
              CASE WHEN ci."identityKey" = %s OR ci."externalUserId" = %s OR ci."larkOpenId" = %s THEN 0 ELSE 1 END,
              ci."lastSeenAt" DESC NULLS LAST,
              ci."updatedAt" DESC NULLS LAST
            LIMIT 1
            """,
            (
                company_id,
                platform,
                identity_key,
                platform_user_id,
                platform_user_id,
                user_id_alt,
                identity_key,
                platform_user_id,
                platform_user_id,
            ),
        )

    def _find_company_user_id_by_channel_alt(
        self,
        *,
        company_id: str,
        provider: str,
        provider_user_id_alt: str | None,
    ) -> str | None:
        provider_user_id_alt = str(provider_user_id_alt or "").strip()
        if not provider_user_id_alt:
            return None
        row = self._fetchone(
            """
            SELECT ci."companyUserId"
            FROM "ChannelIdentity" ci
            LEFT JOIN "CompanyUser" cu
              ON cu."id" = ci."companyUserId" AND cu."companyId" = ci."companyId"
            WHERE ci."companyId" = %s
              AND ci."channel" = %s
              AND ci."platformUserIdAlt" = %s
              AND NULLIF(ci."companyUserId", '') IS NOT NULL
            ORDER BY
              CASE WHEN COALESCE(cu."email", '') <> '' THEN 0 ELSE 1 END,
              CASE WHEN ci."approvedSource" = 'dashboard_auth' THEN 0 ELSE 1 END,
              CASE WHEN COALESCE(cu."role", '') IN ('SUPER_ADMIN', 'OWNER', 'COMPANY_ADMIN', 'ADMIN') THEN 0 ELSE 1 END,
              ci."lastSeenAt" DESC NULLS LAST,
              ci."updatedAt" DESC NULLS LAST
            LIMIT 1
            """,
            (company_id, provider, provider_user_id_alt),
        )
        value = self._row_get(row, "companyUserId")
        return str(value) if value else None

    def _list_company_user_ids_by_channel_alt(
        self,
        *,
        company_id: str,
        provider: str,
        provider_user_id_alt: str | None,
    ) -> list[str]:
        provider_user_id_alt = str(provider_user_id_alt or "").strip()
        if not provider_user_id_alt:
            return []
        rows = self._fetchall(
            """
            SELECT DISTINCT ci."companyUserId"
            FROM "ChannelIdentity" ci
            WHERE ci."companyId" = %s
              AND ci."channel" = %s
              AND ci."platformUserIdAlt" = %s
              AND NULLIF(ci."companyUserId", '') IS NOT NULL
            """,
            (company_id, provider, provider_user_id_alt),
        )
        result: list[str] = []
        for row in rows:
            value = self._row_get(row, "companyUserId")
            if value:
                result.append(str(value))
        return result

    def _merge_channel_alt_to_company_user(
        self,
        *,
        company_id: str,
        provider: str,
        provider_user_id_alt: str | None,
        target_company_user_id: str,
    ) -> None:
        source_ids = self._list_company_user_ids_by_channel_alt(
            company_id=company_id,
            provider=provider,
            provider_user_id_alt=provider_user_id_alt,
        )
        provider_user_id_alt = str(provider_user_id_alt or "").strip()
        if provider_user_id_alt:
            self._execute(
                """
                UPDATE "ChannelIdentity"
                SET "companyUserId" = %s,
                    "updatedAt" = now()
                WHERE "companyId" = %s
                  AND "channel" = %s
                  AND "platformUserIdAlt" = %s
                  AND COALESCE("companyUserId", '') <> %s
                """,
                (
                    target_company_user_id,
                    company_id,
                    provider,
                    provider_user_id_alt,
                    target_company_user_id,
                ),
            )
        self._merge_company_user_refs(
            company_id=company_id,
            target_company_user_id=target_company_user_id,
            source_company_user_ids=source_ids,
        )

    def _merge_company_user_refs(
        self,
        *,
        company_id: str,
        target_company_user_id: str,
        source_company_user_ids: list[str],
    ) -> None:
        for source_company_user_id in sorted(set(source_company_user_ids)):
            if not source_company_user_id or source_company_user_id == target_company_user_id:
                continue
            self._execute(
                """
                UPDATE "ChannelIdentity"
                SET "companyUserId" = %s,
                    "updatedAt" = now()
                WHERE "companyId" = %s AND "companyUserId" = %s
                """,
                (target_company_user_id, company_id, source_company_user_id),
            )
            self._execute(
                """
                UPDATE "HermesSessionBinding"
                SET "resolvedUserId" = %s,
                    "lastSeenAt" = now()
                WHERE "companyId" = %s AND "resolvedUserId" = %s
                """,
                (target_company_user_id, company_id, source_company_user_id),
            )
            self._execute(
                """
                UPDATE "RuntimeConversation"
                SET "createdByUserId" = %s,
                    "updatedAt" = now()
                WHERE "companyId" = %s AND "createdByUserId" = %s
                """,
                (target_company_user_id, company_id, source_company_user_id),
            )
            self._execute(
                """
                UPDATE "RuntimeConversationMessage" m
                SET "actingCompanyUserId" = %s
                FROM "RuntimeConversation" c
                WHERE m."conversationId" = c."id"
                  AND c."companyId" = %s
                  AND m."actingCompanyUserId" = %s
                """,
                (target_company_user_id, company_id, source_company_user_id),
            )
            self._execute(
                """
                DELETE FROM "CompanyUserHomeChannel" source
                USING "CompanyUserHomeChannel" target
                WHERE source."companyId" = %s
                  AND source."companyUserId" = %s
                  AND target."companyId" = source."companyId"
                  AND target."companyUserId" = %s
                  AND target."platform" = source."platform"
                """,
                (company_id, source_company_user_id, target_company_user_id),
            )
            self._execute(
                """
                UPDATE "CompanyUserHomeChannel"
                SET "companyUserId" = %s,
                    "updatedAt" = now()
                WHERE "companyId" = %s AND "companyUserId" = %s
                """,
                (target_company_user_id, company_id, source_company_user_id),
            )
            self._execute(
                """
                DELETE FROM "CompanyUser"
                WHERE "id" = %s
                  AND "companyId" = %s
                  AND NOT EXISTS (
                    SELECT 1 FROM "ChannelIdentity"
                    WHERE "companyId" = %s AND "companyUserId" = %s
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM "HermesSessionBinding"
                    WHERE "companyId" = %s AND "resolvedUserId" = %s
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM "RuntimeConversation"
                    WHERE "companyId" = %s AND "createdByUserId" = %s
                  )
                """,
                (
                    source_company_user_id,
                    company_id,
                    company_id,
                    source_company_user_id,
                    company_id,
                    source_company_user_id,
                    company_id,
                    source_company_user_id,
                ),
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
        if not session_id or not session_key:
            raise ValueError("session_id and session_key are required")

        company_id = identity.company_id
        if not company_id:
            raise ValueError("identity.company_id is required")

        effective_platform = _canonical_channel(platform or "tui")
        effective_chat_id = str(chat_id or session_id)
        conversation_id = self._ensure_runtime_conversation(
            company_id=company_id,
            company_user_id=identity.company_user_id,
            session_key=session_key,
            platform=effective_platform,
            chat_id=effective_chat_id,
            department_id=identity.department_id,
        )
        self._execute(
            """
            INSERT INTO "HermesSessionBinding" (
                "id",
                "companyId",
                "hermesSessionId",
                "sessionKey",
                "conversationId",
                "runId",
                "channelIdentityId",
                "resolvedUserId",
                "parentHermesSessionId",
                "platform",
                "chatId",
                "threadId",
                "source"
            )
            VALUES (%s, %s, %s, %s, %s, NULL, NULLIF(%s, ''), NULLIF(%s, ''), NULL, %s, NULLIF(%s, ''), NULLIF(%s, ''), %s)
            ON CONFLICT ("companyId", "hermesSessionId") DO UPDATE SET
                "sessionKey" = excluded."sessionKey",
                "conversationId" = excluded."conversationId",
                "channelIdentityId" = excluded."channelIdentityId",
                "resolvedUserId" = excluded."resolvedUserId",
                "platform" = excluded."platform",
                "chatId" = excluded."chatId",
                "threadId" = excluded."threadId",
                "source" = excluded."source",
                "lastSeenAt" = now()
            """,
            (
                _stable_id("hsb", company_id, session_id),
                company_id,
                session_id,
                session_key,
                conversation_id,
                identity.channel_identity_id or "",
                identity.company_user_id or "",
                effective_platform,
                effective_chat_id,
                thread_id or "",
                binding_source,
            ),
        )

    def _ensure_runtime_conversation(
        self,
        *,
        company_id: str,
        company_user_id: str | None,
        session_key: str,
        platform: str,
        chat_id: str,
        department_id: str | None = None,
    ) -> str:
        row = self._fetchone(
            """
            INSERT INTO "RuntimeConversation" (
                "id",
                "companyId",
                "departmentId",
                "channel",
                "channelConversationKey",
                "rawChannelKey",
                "createdByUserId",
                "createdByEmail",
                "refsJson",
                "updatedAt"
            )
            VALUES (%s, %s, NULLIF(%s, ''), %s, %s, %s, NULLIF(%s, ''), NULL, %s::jsonb, now())
            ON CONFLICT ("companyId", "channel", "channelConversationKey") DO UPDATE SET
                "departmentId" = COALESCE(excluded."departmentId", "RuntimeConversation"."departmentId"),
                "rawChannelKey" = excluded."rawChannelKey",
                "createdByUserId" = COALESCE("RuntimeConversation"."createdByUserId", excluded."createdByUserId"),
                "updatedAt" = now()
            RETURNING "id"
            """,
            (
                _stable_id("conv", company_id, platform, session_key),
                company_id,
                department_id or "",
                platform,
                session_key,
                chat_id,
                company_user_id or "",
                _json_dumps({"session_key": session_key}),
            ),
        )
        conversation_id = self._row_get(row, "id")
        if not conversation_id:
            raise RuntimeError("RuntimeConversation upsert did not return an id")
        return str(conversation_id)

    def _upsert_company_user(
        self,
        *,
        company_user_id: str,
        company_id: str,
        display_name: str | None = None,
        email: str | None = None,
        role: str | None = None,
        department_id: str | None = None,
    ) -> None:
        self._execute(
            """
            INSERT INTO "CompanyUser" (
                "id", "companyId", "email", "displayName", "role", "departmentId", "status", "updatedAt"
            )
            VALUES (%s, %s, %s, %s, COALESCE(%s, 'MEMBER'), %s, 'active', now())
            ON CONFLICT ("id") DO UPDATE SET
                "email" = COALESCE(excluded."email", "CompanyUser"."email"),
                "displayName" = COALESCE(excluded."displayName", "CompanyUser"."displayName"),
                "role" = COALESCE(%s, "CompanyUser"."role"),
                "departmentId" = COALESCE(excluded."departmentId", "CompanyUser"."departmentId"),
                "updatedAt" = now()
            """,
            (
                company_user_id,
                company_id,
                email,
                display_name,
                role,
                department_id,
                role,
            ),
        )

    def upsert_dashboard_member(
        self,
        *,
        provider: str,
        provider_user_id: str,
        provider_user_id_alt: str | None = None,
        display_name: str | None = None,
        email: str | None = None,
        company_id: str | None = None,
        role: str | None = None,
        department_id: str | None = None,
        status: str = "active",
    ) -> dict[str, Any]:
        company_id = company_id or self.ensure_default_company()
        self._ensure_company(company_id)
        provider = str(provider or "dashboard").strip() or "dashboard"
        provider_user_id = str(provider_user_id or "").strip()
        provider_user_id_alt = str(provider_user_id_alt or "").strip() or None
        if not provider_user_id:
            raise ValueError("provider_user_id is required")

        existing_id = None
        if email:
            existing = self._fetchone(
                """
                SELECT "id"
                FROM "CompanyUser"
                WHERE "companyId" = %s AND "email" = %s
                LIMIT 1
                """,
                (company_id, email),
            )
            existing_id = self._row_get(existing, "id")

        existing_id = existing_id or self._find_company_user_id_by_channel_alt(
            company_id=company_id,
            provider=provider,
            provider_user_id_alt=provider_user_id_alt,
        )
        company_user_id = existing_id or _stable_id(
            "cu", company_id, provider, provider_user_id
        )
        existing_row = self.get_company_user(
            company_user_id,
            company_id=company_id,
        )
        effective_status = _normalize_text(status, "active")
        if existing_row and _is_disabled_status(existing_row.get("status")) and effective_status == "active":
            # Login upsert must not silently reactivate an employee disabled
            # by an admin action. Reactivation goes through update_company_user.
            effective_status = str(existing_row.get("status") or "disabled")

        self._upsert_company_user(
            company_user_id=company_user_id,
            company_id=company_id,
            display_name=display_name,
            email=email,
            role=role,
            department_id=department_id,
        )
        self._execute(
            """
            UPDATE "CompanyUser"
            SET "status" = %s, "updatedAt" = now()
            WHERE "id" = %s
            """,
            (effective_status, company_user_id),
        )
        self._link_dashboard_channel_identity(
            company_id=company_id,
            company_user_id=company_user_id,
            provider=provider,
            provider_user_id=provider_user_id,
            provider_user_id_alt=provider_user_id_alt,
            display_name=display_name,
        )
        self._merge_channel_alt_to_company_user(
            company_id=company_id,
            provider=provider,
            provider_user_id_alt=provider_user_id_alt,
            target_company_user_id=company_user_id,
        )
        row = self._fetchone(
            """
            SELECT "id", "companyId", "email", "displayName", "role", "departmentId",
                   "status", "createdAt", "updatedAt"
            FROM "CompanyUser"
            WHERE "id" = %s
            """,
            (company_user_id,),
        )
        return dict(row) if isinstance(row, Mapping) else {
            "id": company_user_id,
            "companyId": company_id,
            "email": email,
            "displayName": display_name,
            "role": role or "MEMBER",
            "departmentId": department_id,
            "status": status,
        }

    def _link_dashboard_channel_identity(
        self,
        *,
        company_id: str,
        company_user_id: str,
        provider: str,
        provider_user_id: str,
        provider_user_id_alt: str | None = None,
        display_name: str | None = None,
    ) -> None:
        identity_key = f"user:{provider_user_id}"
        channel_identity_id = _stable_id("ci", company_id, provider, identity_key)
        provider_user_id_alt = str(provider_user_id_alt or "").strip() or None
        raw_payload = {
            "platform": provider,
            "user_id": provider_user_id,
            "user_id_alt": provider_user_id_alt,
            "user_name": display_name,
            "source": "dashboard_auth",
        }
        self._execute(
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
                "displayName" = COALESCE(excluded."displayName", "ChannelIdentity"."displayName"),
                "identityKey" = excluded."identityKey",
                "platformUserIdAlt" = COALESCE(excluded."platformUserIdAlt", "ChannelIdentity"."platformUserIdAlt"),
                "approvedSource" = excluded."approvedSource",
                "rawJson" = excluded."rawJson",
                "lastSeenAt" = now(),
                "updatedAt" = now()
            """,
            (
                channel_identity_id,
                company_id,
                company_user_id,
                provider,
                provider_user_id,
                company_id,
                display_name,
                "user",
                identity_key,
                provider_user_id_alt,
                "",
                company_id,
                "dashboard_auth",
                _json_dumps(raw_payload),
            ),
        )

    def get_company(self, company_id: str) -> Optional[dict[str, Any]]:
        row = self._fetchone(
            """
            SELECT "id", "slug", "name"
            FROM "Company"
            WHERE "id" = %s
            """,
            (company_id,),
        )
        if not isinstance(row, Mapping):
            return None
        return {
            "id": self._row_get(row, "id"),
            "slug": self._row_get(row, "slug"),
            "display_name": self._row_get(row, "name"),
        }

    def find_dashboard_company_user(
        self,
        *,
        provider: str,
        provider_user_id: str,
        company_id: str | None = None,
    ) -> Optional[dict[str, Any]]:
        company_id = company_id or self.ensure_default_company()
        provider = str(provider or "dashboard").strip() or "dashboard"
        provider_user_id = str(provider_user_id or "").strip()
        if not provider_user_id:
            return None
        company_user_id = _stable_id("cu", company_id, provider, provider_user_id)
        row = self._fetchone(
            """
            SELECT "id", "companyId", "email", "displayName", "role", "departmentId",
                   "status", "createdAt", "updatedAt"
            FROM "CompanyUser"
            WHERE "id" = %s
            """,
            (company_user_id,),
        )
        return dict(row) if isinstance(row, Mapping) else None

    def get_company_user(
        self,
        company_user_id: str,
        *,
        company_id: str | None = None,
    ) -> Optional[dict[str, Any]]:
        if company_id:
            row = self._fetchone(
                """
                SELECT "id", "companyId", "email", "displayName", "role", "departmentId",
                       "status", "createdAt", "updatedAt"
                FROM "CompanyUser"
                WHERE "id" = %s AND "companyId" = %s
                """,
                (company_user_id, company_id),
            )
        else:
            row = self._fetchone(
                """
                SELECT "id", "companyId", "email", "displayName", "role", "departmentId",
                       "status", "createdAt", "updatedAt"
                FROM "CompanyUser"
                WHERE "id" = %s
                """,
                (company_user_id,),
            )
        return dict(row) if isinstance(row, Mapping) else None

    def update_company_user(
        self,
        *,
        company_user_id: str,
        company_id: str | None = None,
        role: str | None = None,
        status: str | None = None,
        department_id: str | None = None,
    ) -> Optional[dict[str, Any]]:
        company_id = company_id or self.ensure_default_company()
        updates: list[str] = []
        args: list[Any] = []
        if role is not None:
            updates.append('"role" = %s')
            args.append(_normalize_text(role, "MEMBER"))
        if status is not None:
            updates.append('"status" = %s')
            args.append(_normalize_text(status, "active"))
        if department_id is not None:
            updates.append('"departmentId" = %s')
            args.append(_normalize_text(department_id, "") or None)
        if not updates:
            return self.get_company_user(company_user_id, company_id=company_id)

        updates.append('"updatedAt" = now()')
        args.extend([company_user_id, company_id])
        self._execute(
            f"""
            UPDATE "CompanyUser"
            SET {", ".join(updates)}
            WHERE "id" = %s AND "companyId" = %s
            """,
            tuple(args),
        )
        return self.get_company_user(company_user_id, company_id=company_id)

    def list_channel_identities_for_company_user(
        self,
        company_user_id: str,
    ) -> list[dict[str, Any]]:
        result = self._connection.execute(
            """
            SELECT "id", "companyId", "companyUserId", "channel", "externalUserId",
                   "displayName", "identityKind", "identityKey", "platformUserIdAlt",
                   "approvedSource", "rawJson", "firstSeenAt", "lastSeenAt"
            FROM "ChannelIdentity"
            WHERE "companyUserId" = %s
            ORDER BY "lastSeenAt" DESC
            """,
            (company_user_id,),
        )
        fetchall = getattr(result, "fetchall", None)
        try:
            if fetchall is None:
                return []
            rows = fetchall()
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()
        normalized: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            normalized.append(
                {
                    "id": self._row_get(row, "id"),
                    "company_id": self._row_get(row, "companyId"),
                    "company_user_id": self._row_get(row, "companyUserId"),
                    "platform": self._row_get(row, "channel"),
                    "platform_user_id": self._row_get(row, "externalUserId"),
                    "platform_user_id_alt": self._row_get(row, "platformUserIdAlt"),
                    "display_name": self._row_get(row, "displayName"),
                    "identity_kind": self._row_get(row, "identityKind"),
                    "identity_key": self._row_get(row, "identityKey"),
                    "approved_source": self._row_get(row, "approvedSource"),
                    "raw_json": self._row_get(row, "rawJson"),
                }
            )
        return normalized

    def get_session_identity(self, session_id: str) -> Optional[dict[str, Any]]:
        row = self._fetchone(
            """
            SELECT "hermesSessionId", "sessionKey", "companyId", "resolvedUserId",
                   "channelIdentityId", "platform", "chatId", "threadId",
                   "source", "lastSeenAt"
            FROM "HermesSessionBinding"
            WHERE "hermesSessionId" = %s
            """,
            (session_id,),
        )
        if not isinstance(row, Mapping):
            return None
        return {
            "session_id": self._row_get(row, "hermesSessionId"),
            "session_key": self._row_get(row, "sessionKey"),
            "company_id": self._row_get(row, "companyId"),
            "company_user_id": self._row_get(row, "resolvedUserId"),
            "channel_identity_id": self._row_get(row, "channelIdentityId"),
            "platform": self._row_get(row, "platform"),
            "chat_id": self._row_get(row, "chatId"),
            "thread_id": self._row_get(row, "threadId"),
            "binding_source": self._row_get(row, "source"),
            "last_seen_at": self._row_get(row, "lastSeenAt"),
        }

    def list_session_identities_for_company_user(
        self,
        company_user_id: str,
    ) -> list[dict[str, Any]]:
        result = self._connection.execute(
            """
            SELECT "hermesSessionId", "sessionKey", "companyId", "resolvedUserId",
                   "channelIdentityId", "platform", "chatId", "threadId",
                   "source", "lastSeenAt"
            FROM "HermesSessionBinding"
            WHERE "resolvedUserId" = %s
            ORDER BY "lastSeenAt" DESC
            """,
            (company_user_id,),
        )
        fetchall = getattr(result, "fetchall", None)
        try:
            if fetchall is None:
                return []
            rows = fetchall()
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()
        normalized: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            normalized.append(
                {
                    "session_id": self._row_get(row, "hermesSessionId"),
                    "session_key": self._row_get(row, "sessionKey"),
                    "company_id": self._row_get(row, "companyId"),
                    "company_user_id": self._row_get(row, "resolvedUserId"),
                    "channel_identity_id": self._row_get(row, "channelIdentityId"),
                    "platform": self._row_get(row, "platform"),
                    "chat_id": self._row_get(row, "chatId"),
                    "thread_id": self._row_get(row, "threadId"),
                    "binding_source": self._row_get(row, "source"),
                    "last_seen_at": self._row_get(row, "lastSeenAt"),
                }
            )
        return normalized

    def upsert_company_user_home_channel(
        self,
        *,
        company_id: str,
        company_user_id: str,
        platform: str,
        chat_id: str,
        chat_name: str | None = None,
        thread_id: str | None = None,
        channel_identity_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        company_id = _normalize_text(company_id)
        company_user_id = _normalize_text(company_user_id)
        platform = _canonical_channel(platform)
        chat_id = _normalize_text(chat_id)
        if not company_id or not company_user_id or not platform or not chat_id:
            raise ValueError("company_id, company_user_id, platform, and chat_id are required")

        self._ensure_company(company_id)
        row = self._fetchone(
            """
            INSERT INTO "CompanyUserHomeChannel" (
                "id",
                "companyId",
                "companyUserId",
                "platform",
                "chatId",
                "chatName",
                "threadId",
                "channelIdentityId",
                "metadataJson",
                "updatedAt"
            )
            VALUES (%s, %s, %s, %s, %s, %s, NULLIF(%s, ''), NULLIF(%s, ''), %s::jsonb, now())
            ON CONFLICT ("companyId", "companyUserId", "platform") DO UPDATE SET
                "chatId" = excluded."chatId",
                "chatName" = excluded."chatName",
                "threadId" = excluded."threadId",
                "channelIdentityId" = excluded."channelIdentityId",
                "metadataJson" = excluded."metadataJson",
                "updatedAt" = now()
            RETURNING "id", "companyId", "companyUserId", "platform", "chatId",
                      "chatName", "threadId", "channelIdentityId", "metadataJson",
                      "createdAt", "updatedAt"
            """,
            (
                _stable_id("home", company_id, company_user_id, platform),
                company_id,
                company_user_id,
                platform,
                chat_id,
                chat_name,
                thread_id or "",
                channel_identity_id or "",
                _json_dumps(metadata or {}),
            ),
        )
        if not isinstance(row, Mapping):
            raise RuntimeError("company user home channel did not persist")
        return self._normalize_home_channel_row(row)

    def get_company_user_home_channel(
        self,
        *,
        company_id: str,
        company_user_id: str,
        platform: str,
    ) -> Optional[dict[str, Any]]:
        row = self._fetchone(
            """
            SELECT "id", "companyId", "companyUserId", "platform", "chatId",
                   "chatName", "threadId", "channelIdentityId", "metadataJson",
                   "createdAt", "updatedAt"
            FROM "CompanyUserHomeChannel"
            WHERE "companyId" = %s AND "companyUserId" = %s AND "platform" = %s
            """,
            (company_id, company_user_id, _canonical_channel(platform)),
        )
        if not isinstance(row, Mapping):
            return None
        return self._normalize_home_channel_row(row)

    def list_company_user_home_channels(
        self,
        *,
        company_id: str,
        company_user_id: str,
    ) -> list[dict[str, Any]]:
        result = self._connection.execute(
            """
            SELECT "id", "companyId", "companyUserId", "platform", "chatId",
                   "chatName", "threadId", "channelIdentityId", "metadataJson",
                   "createdAt", "updatedAt"
            FROM "CompanyUserHomeChannel"
            WHERE "companyId" = %s AND "companyUserId" = %s
            ORDER BY "platform"
            """,
            (company_id, company_user_id),
        )
        fetchall = getattr(result, "fetchall", None)
        try:
            if fetchall is None:
                return []
            rows = fetchall()
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()
        return [
            self._normalize_home_channel_row(row)
            for row in rows
            if isinstance(row, Mapping)
        ]

    def list_company_users(self, *, company_id: str | None = None) -> list[dict[str, Any]]:
        company_id = company_id or self.ensure_default_company()
        result = self._connection.execute(
            """
            SELECT "id", "companyId", "email", "displayName", "role", "departmentId",
                   "status", "createdAt", "updatedAt"
            FROM "CompanyUser"
            WHERE "companyId" = %s
            ORDER BY lower(COALESCE("displayName", "email", "id"))
            """,
            (company_id,),
        )
        fetchall = getattr(result, "fetchall", None)
        try:
            if fetchall is None:
                return []
            rows = fetchall()
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()
        return [dict(row) if isinstance(row, Mapping) else row for row in rows]

    def _normalize_home_channel_row(self, row: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "id": self._row_get(row, "id"),
            "company_id": self._row_get(row, "companyId"),
            "company_user_id": self._row_get(row, "companyUserId"),
            "platform": self._row_get(row, "platform"),
            "chat_id": self._row_get(row, "chatId"),
            "chat_name": self._row_get(row, "chatName"),
            "thread_id": self._row_get(row, "threadId"),
            "channel_identity_id": self._row_get(row, "channelIdentityId"),
            "metadata_json": self._row_get(row, "metadataJson"),
            "created_at": self._row_get(row, "createdAt"),
            "updated_at": self._row_get(row, "updatedAt"),
        }

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

    def _fetchall(self, sql: str, args: tuple[Any, ...]) -> list[Any]:
        result = self._connection.execute(sql, args)
        fetchall = getattr(result, "fetchall", None)
        if fetchall is None:
            return []
        try:
            rows = fetchall()
            return list(rows or [])
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
