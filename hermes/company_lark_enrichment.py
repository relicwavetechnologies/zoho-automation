"""Best-effort Lark Contact API enrichment for company member profiles."""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 300
_USER_CACHE: dict[str, tuple[float, "LarkContactProfile"]] = {}
_DEPT_CACHE: dict[str, tuple[float, str]] = {}


@dataclass(frozen=True)
class LarkContactProfile:
    open_id: str
    union_id: str | None = None
    user_id: str | None = None
    avatar_url: str | None = None
    department_id: str | None = None
    department_name: str | None = None
    display_name: str | None = None


def _lark_credentials() -> tuple[str, str, str] | None:
    app_id = (
        os.getenv("HERMES_DASHBOARD_LARK_APP_ID", "").strip()
        or os.getenv("LARK_APP_ID", "").strip()
    )
    app_secret = (
        os.getenv("HERMES_DASHBOARD_LARK_APP_SECRET", "").strip()
        or os.getenv("LARK_APP_SECRET", "").strip()
    )
    api_base = (
        os.getenv("HERMES_DASHBOARD_LARK_API_BASE_URL", "").strip()
        or os.getenv("LARK_API_BASE_URL", "").strip()
        or "https://open.larksuite.com"
    ).rstrip("/")
    if not app_id or not app_secret:
        return None
    return app_id, app_secret, api_base


def _cache_get(cache: dict[str, tuple[float, Any]], key: str) -> Any | None:
    entry = cache.get(key)
    if not entry:
        return None
    expires_at, value = entry
    if expires_at <= time.time():
        cache.pop(key, None)
        return None
    return value


def _cache_set(cache: dict[str, tuple[float, Any]], key: str, value: Any) -> None:
    cache[key] = (time.time() + _CACHE_TTL_SECONDS, value)


def _tenant_access_token(client: httpx.Client, api_base: str, app_id: str, app_secret: str) -> str:
    response = client.post(
        f"{api_base}/open-apis/auth/v3/tenant_access_token/internal",
        json={"app_id": app_id, "app_secret": app_secret},
    )
    payload = response.json() if response.content else {}
    if response.status_code >= 400 or payload.get("code") not in (0, None):
        raise RuntimeError(
            f"Lark tenant token failed (http {response.status_code}, code {payload.get('code')})"
        )
    token = str(payload.get("tenant_access_token") or "").strip()
    if not token:
        raise RuntimeError("Lark tenant token response had no tenant_access_token")
    return token


def _avatar_url_from_user(user: dict[str, Any]) -> str | None:
    avatar = user.get("avatar")
    if isinstance(avatar, dict):
        for key in ("avatar_origin", "avatar_640", "avatar_72", "avatar_240"):
            value = avatar.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    for key in ("avatar_url", "avatar_big", "avatar_thumb"):
        value = user.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _department_id_from_user(user: dict[str, Any]) -> str | None:
    department_ids = user.get("department_ids")
    if isinstance(department_ids, list) and department_ids:
        first = str(department_ids[0] or "").strip()
        if first:
            return first
    for key in ("open_department_id", "department_id"):
        value = user.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _fetch_department_name(
    client: httpx.Client,
    *,
    api_base: str,
    token: str,
    department_id: str,
) -> str | None:
    cached = _cache_get(_DEPT_CACHE, department_id)
    if cached:
        return cached
    response = client.get(
        f"{api_base}/open-apis/contact/v3/departments/{department_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"department_id_type": "open_department_id"},
    )
    payload = response.json() if response.content else {}
    if response.status_code >= 400 or payload.get("code") not in (0, None):
        return None
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    department = data.get("department") if isinstance(data, dict) else None
    if not isinstance(department, dict):
        return None
    name = str(department.get("name") or department.get("i18n_name", {}).get("en_us") or "").strip()
    if name:
        _cache_set(_DEPT_CACHE, department_id, name)
    return name or None


def _fetch_lark_contact_profile(
    open_id: str,
    *,
    credentials: tuple[str, str, str],
) -> LarkContactProfile | None:
    cached = _cache_get(_USER_CACHE, open_id)
    if cached:
        return cached

    app_id, app_secret, api_base = credentials
    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            token = _tenant_access_token(client, api_base, app_id, app_secret)
            response = client.get(
                f"{api_base}/open-apis/contact/v3/users/{open_id}",
                headers={"Authorization": f"Bearer {token}"},
                params={"user_id_type": "open_id"},
            )
            payload = response.json() if response.content else {}
            if response.status_code >= 400 or payload.get("code") not in (0, None):
                return None
            data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
            user = data.get("user") if isinstance(data, dict) else None
            if not isinstance(user, dict):
                return None

            department_id = _department_id_from_user(user)
            department_name = None
            if department_id:
                department_name = _fetch_department_name(
                    client,
                    api_base=api_base,
                    token=token,
                    department_id=department_id,
                )

            profile = LarkContactProfile(
                open_id=open_id,
                union_id=str(user.get("union_id") or "").strip() or None,
                user_id=str(user.get("user_id") or "").strip() or None,
                avatar_url=_avatar_url_from_user(user),
                department_id=department_id,
                department_name=department_name,
                display_name=str(user.get("name") or user.get("en_name") or "").strip() or None,
            )
            _cache_set(_USER_CACHE, open_id, profile)
            return profile
    except Exception as exc:  # noqa: BLE001
        logger.debug("Lark contact enrichment failed for %s: %s", open_id, exc)
        return None


def fetch_lark_profiles_by_open_ids(open_ids: list[str]) -> dict[str, LarkContactProfile]:
    """Return Lark Contact profiles keyed by open_id. Skips when creds are missing."""
    credentials = _lark_credentials()
    if credentials is None:
        return {}

    profiles: dict[str, LarkContactProfile] = {}
    seen: set[str] = set()
    for raw in open_ids:
        open_id = str(raw or "").strip()
        if not open_id or open_id in seen:
            continue
        seen.add(open_id)
        profile = _fetch_lark_contact_profile(open_id, credentials=credentials)
        if profile is not None:
            profiles[open_id] = profile
    return profiles
