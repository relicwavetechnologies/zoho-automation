"""Serialize company users into dashboard employee profile payloads."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from company_lark_enrichment import LarkContactProfile


def _read_field(row: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _serialize_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
    if hasattr(value, "isoformat"):
        tzinfo = getattr(value, "tzinfo", None)
        if tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    text = str(value).strip()
    return text or None


def _pick_dashboard_channel_identity(
    channel_identities: list[Mapping[str, Any]] | None,
) -> Mapping[str, Any] | None:
    if not channel_identities:
        return None
    for row in channel_identities:
        if str(row.get("approved_source") or "") == "dashboard_auth":
            return row
    for row in channel_identities:
        platform = str(row.get("platform") or "").strip()
        if platform in {"lark", "feishu"}:
            return row
    return channel_identities[0]


def _lark_ids_from_channel(
    channel: Mapping[str, Any] | None,
) -> tuple[str | None, str | None, str | None, str | None]:
    if channel is None:
        return None, None, None, None
    open_id = _read_field(channel, "platform_user_id") or None
    union_id = _read_field(channel, "platform_user_id_alt") or None
    provider = _read_field(channel, "platform") or None
    raw_json = channel.get("raw_json")
    user_id = None
    if isinstance(raw_json, str) and raw_json.strip():
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, dict):
                user_id = _read_field(parsed, "user_id") or None
        except json.JSONDecodeError:
            pass
    elif isinstance(raw_json, Mapping):
        user_id = _read_field(raw_json, "user_id") or None
    return open_id, union_id, user_id, provider


def serialize_company_user(
    row: Mapping[str, Any],
    *,
    channel_identities: list[Mapping[str, Any]] | None = None,
    session_fallback: Mapping[str, Any] | None = None,
    lark_enrichment: Mapping[str, LarkContactProfile] | None = None,
    company_name: str | None = None,
    include_company_name: bool = False,
) -> dict[str, Any]:
    """Map a company user row into the canonical employee profile JSON shape."""
    company_id = _read_field(row, "company_id", "companyId")
    user_id = _read_field(row, "id")
    display_name = _read_field(row, "display_name", "displayName")
    email = _read_field(row, "email") or None
    role = _read_field(row, "role") or "MEMBER"
    department_id = _read_field(row, "department_id", "departmentId") or None
    status = _read_field(row, "status") or "active"

    channel = _pick_dashboard_channel_identity(channel_identities)
    lark_open_id, lark_union_id, lark_user_id, provider = _lark_ids_from_channel(channel)

    if session_fallback is not None:
        session_provider = _read_field(session_fallback, "provider")
        session_user_id = _read_field(session_fallback, "user_id", "userId")
        if session_provider:
            provider = provider or session_provider
        if session_provider == "lark" and session_user_id:
            lark_open_id = lark_open_id or session_user_id
        if not display_name:
            display_name = _read_field(session_fallback, "display_name", "displayName", "name")
        if not email:
            email = _read_field(session_fallback, "email") or None

    enrichment = None
    if lark_open_id and lark_enrichment:
        enrichment = lark_enrichment.get(lark_open_id)

    avatar_url = enrichment.avatar_url if enrichment else None
    if enrichment:
        lark_union_id = lark_union_id or enrichment.union_id
        lark_user_id = lark_user_id or enrichment.user_id
        department_id = department_id or enrichment.department_id
        display_name = display_name or enrichment.display_name or display_name

    department_name = enrichment.department_name if enrichment else None
    if not department_name and department_id:
        department_name = department_id

    payload: dict[str, Any] = {
        "id": user_id,
        "company_id": company_id,
        "display_name": display_name or email or user_id,
        "email": email,
        "avatar_url": avatar_url,
        "lark_open_id": lark_open_id,
        "lark_union_id": lark_union_id,
        "lark_user_id": lark_user_id,
        "department_id": department_id,
        "department_name": department_name,
        "role": role,
        "status": status,
        "provider": provider or "lark",
        "first_login_at": _serialize_timestamp(row.get("created_at") or row.get("createdAt")),
        "last_login_at": _serialize_timestamp(row.get("updated_at") or row.get("updatedAt")),
    }
    if include_company_name:
        payload["company_name"] = company_name or ""
    return payload


def synthesize_session_company_user(
    session: Mapping[str, Any],
    *,
    company_id: str,
    company_name: str | None = None,
    lark_enrichment: Mapping[str, LarkContactProfile] | None = None,
) -> dict[str, Any]:
    """Build a minimal company user row from an authenticated dashboard session."""
    provider = _read_field(session, "provider") or "dashboard"
    provider_user_id = _read_field(session, "user_id", "userId")
    from company_identity import dashboard_company_user_id

    user_id = dashboard_company_user_id(company_id, provider, provider_user_id)
    row = {
        "id": user_id,
        "company_id": company_id,
        "display_name": _read_field(session, "display_name", "displayName", "name"),
        "email": _read_field(session, "email") or None,
        "role": "MEMBER",
        "department_id": None,
        "status": "active",
        "created_at": None,
        "updated_at": None,
    }
    return serialize_company_user(
        row,
        session_fallback=session,
        lark_enrichment=lark_enrichment,
        company_name=company_name,
        include_company_name=True,
    )


def company_display_name(company_row: Mapping[str, Any] | None) -> str:
    if not company_row:
        return ""
    return _read_field(company_row, "display_name", "name", "slug")


def resolve_lark_open_id(
    *,
    channel_identities: list[Mapping[str, Any]] | None = None,
    session_fallback: Mapping[str, Any] | None = None,
) -> str | None:
    channel = _pick_dashboard_channel_identity(channel_identities)
    open_id, _, _, _ = _lark_ids_from_channel(channel)
    if open_id:
        return open_id
    if session_fallback is not None:
        provider = _read_field(session_fallback, "provider")
        user_id = _read_field(session_fallback, "user_id", "userId")
        if provider == "lark" and user_id:
            return user_id
    return None


def resolve_channel_identity_id(
    *,
    channel_identities: list[Mapping[str, Any]] | None = None,
) -> str | None:
    channel = _pick_dashboard_channel_identity(channel_identities)
    if channel is None:
        return None
    value = _read_field(channel, "id")
    return value or None
