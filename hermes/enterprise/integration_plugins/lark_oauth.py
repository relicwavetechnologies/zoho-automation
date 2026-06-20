"""Lark integration-plugin OAuth (authorize + callback)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Mapping

import httpx

from enterprise.integration_plugins.catalog import LARK_PLUGIN_ID, get_integration_plugin
from enterprise.integration_plugins.models import IntegrationPluginManifest

_STATE_TTL_SECONDS = 600
_SIG_LEN = 32


class LarkIntegrationOAuthError(RuntimeError):
    """Raised when Lark integration OAuth cannot start or complete."""


def lark_api_base_url() -> str:
    return (os.getenv("LARK_API_BASE_URL") or "https://open.larksuite.com").strip().rstrip("/")


def lark_auth_base_url(api_base_url: str | None = None) -> str:
    api_base = (api_base_url or lark_api_base_url()).strip()
    if "open.feishu.cn" in api_base:
        return "https://accounts.feishu.cn"
    if "open.larksuite.com" in api_base:
        return "https://accounts.larksuite.com"
    return api_base.rstrip("/")


def lark_oauth_app_configured() -> bool:
    app_id, app_secret = lark_oauth_client_config(raise_on_missing=False)
    return bool(app_id and app_secret)


def _env_value(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if value.startswith("$") and len(value) > 1:
        return (os.getenv(value[1:]) or "").strip()
    return value


def lark_oauth_client_config(*, raise_on_missing: bool = True) -> tuple[str, str]:
    app_id = (
        _env_value("HERMES_DASHBOARD_LARK_APP_ID")
        or _env_value("LARK_APP_ID")
        or ""
    ).strip()
    app_secret = (
        _env_value("HERMES_DASHBOARD_LARK_APP_SECRET")
        or _env_value("LARK_APP_SECRET")
        or ""
    ).strip()
    if raise_on_missing and (not app_id or not app_secret):
        raise LarkIntegrationOAuthError("Lark OAuth app credentials are not configured")
    return app_id, app_secret


def lark_redirect_uri(*, request_base_url: str | None = None) -> str:
    explicit = (
        os.getenv("LARK_OAUTH_REDIRECT_URI")
        or os.getenv("HERMES_LARK_OAUTH_REDIRECT_URI")
        or ""
    ).strip()
    if explicit:
        return explicit
    public_url = (
        os.getenv("HERMES_DASHBOARD_PUBLIC_URL")
        or request_base_url
        or ""
    ).strip().rstrip("/")
    if not public_url:
        raise LarkIntegrationOAuthError(
            "Set HERMES_DASHBOARD_PUBLIC_URL or HERMES_LARK_OAUTH_REDIRECT_URI before connecting Lark"
        )
    return f"{public_url}/api/company/integration-plugins/{LARK_PLUGIN_ID}/oauth/callback"


def _oauth_state_secret() -> bytes:
    raw = (
        (os.getenv("HERMES_OAUTH_STATE_SECRET") or "").strip()
        or (os.getenv("ZOHO_TOKEN_ENCRYPTION_KEY") or "").strip()
        or "hermes-integration-oauth-dev"
    )
    return hashlib.sha256(raw.encode("utf-8")).digest()


def _sign_state(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(dict(payload), separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(_oauth_state_secret(), raw, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(raw + sig).decode()


def _unsign_state(token: str) -> dict[str, Any] | None:
    try:
        blob = base64.urlsafe_b64decode(token.encode())
        if len(blob) <= _SIG_LEN:
            return None
        raw, sig = blob[:-_SIG_LEN], blob[-_SIG_LEN:]
        expected = hmac.new(_oauth_state_secret(), raw, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def required_lark_oauth_scope_ids(manifest: IntegrationPluginManifest) -> list[str]:
    configured = (os.getenv("LARK_OAUTH_SCOPES") or os.getenv("HERMES_LARK_OAUTH_SCOPES") or "").strip()
    if configured:
        return [part.strip() for part in configured.replace(",", " ").split() if part.strip()]
    return [scope.id for scope in manifest.oauth_scopes if scope.required]


def build_lark_authorize_url(
    *,
    company_id: str,
    company_user_id: str,
    user_id: str | None = None,
    user_email: str | None = None,
    plugin_id: str = LARK_PLUGIN_ID,
    redirect_uri: str | None = None,
    request_base_url: str | None = None,
) -> str:
    manifest = get_integration_plugin(plugin_id)
    if manifest is None:
        raise LarkIntegrationOAuthError(f"Unknown integration plugin {plugin_id!r}")

    redirect = (redirect_uri or lark_redirect_uri(request_base_url=request_base_url)).strip()
    app_id, _app_secret = lark_oauth_client_config()
    state = _sign_state(
        {
            "v": 1,
            "company_id": company_id,
            "company_user_id": company_user_id,
            "user_id": user_id or "",
            "user_email": user_email or "",
            "plugin_id": plugin_id,
            "redirect_uri": redirect,
            "exp": int(time.time()) + _STATE_TTL_SECONDS,
        }
    )
    params = {
        "client_id": app_id,
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": " ".join(required_lark_oauth_scope_ids(manifest)),
        "state": state,
    }
    return f"{lark_auth_base_url()}/open-apis/authen/v1/authorize?{urllib.parse.urlencode(params)}"


async def complete_lark_oauth_callback(
    *,
    code: str,
    state: str,
    repo: Any,
    invalidate_runtime_cache: Any | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    payload = _unsign_state(state)
    if payload is None:
        raise LarkIntegrationOAuthError("Invalid or expired OAuth state")

    exp = int(payload.get("exp") or 0)
    if exp <= int(time.time()):
        raise LarkIntegrationOAuthError("OAuth state expired - try connecting again")

    company_id = str(payload.get("company_id") or "").strip()
    company_user_id = str(payload.get("company_user_id") or "").strip()
    user_id = str(payload.get("user_id") or "").strip() or None
    user_email = str(payload.get("user_email") or "").strip()
    plugin_id = str(payload.get("plugin_id") or LARK_PLUGIN_ID).strip()
    redirect_uri = str(payload.get("redirect_uri") or lark_redirect_uri()).strip()
    if not company_id or not company_user_id:
        raise LarkIntegrationOAuthError("OAuth state is missing required fields")

    manifest = get_integration_plugin(plugin_id)
    if manifest is None:
        raise LarkIntegrationOAuthError(f"Unknown integration plugin {plugin_id!r}")

    app_id, app_secret = lark_oauth_client_config()
    token_data = await _exchange_lark_authorization_code(
        app_id=app_id,
        app_secret=app_secret,
        code=code,
        redirect_uri=redirect_uri,
        transport=transport,
    )
    access_token = str(token_data.get("access_token") or "").strip()
    refresh_token = str(token_data.get("refresh_token") or "").strip()
    if not access_token:
        raise LarkIntegrationOAuthError("Lark did not return an access token")

    profile = await _fetch_lark_user_info(access_token, transport=transport)
    lark_open_id = str(profile.get("open_id") or token_data.get("open_id") or "").strip()
    lark_user_id = str(profile.get("user_id") or token_data.get("user_id") or "").strip()
    lark_email = str(
        profile.get("enterprise_email")
        or profile.get("email")
        or token_data.get("enterprise_email")
        or token_data.get("email")
        or user_email
        or ""
    ).strip()
    lark_name = str(profile.get("name") or token_data.get("name") or "").strip()
    tenant_key = str(profile.get("tenant_key") or token_data.get("tenant_key") or "").strip()
    scope_text = str(token_data.get("scope") or " ".join(required_lark_oauth_scope_ids(manifest))).strip()
    expires_in = int(token_data.get("expires_in") or token_data.get("expire") or 7200)
    refresh_expires_in = token_data.get("refresh_token_expires_in") or token_data.get("refresh_expires_in")
    access_expires_at = datetime.fromtimestamp(time.time() + max(0, expires_in), tz=timezone.utc).isoformat()
    refresh_expires_at = (
        datetime.fromtimestamp(time.time() + max(0, int(refresh_expires_in)), tz=timezone.utc).isoformat()
        if refresh_expires_in
        else None
    )

    resolved_user_id = repo.upsert_lark_user_auth_link(
        company_id=company_id,
        company_user_id=company_user_id,
        user_id=user_id,
        lark_tenant_key=tenant_key,
        lark_open_id=lark_open_id,
        lark_user_id=lark_user_id or None,
        lark_email=lark_email,
        lark_name=lark_name or None,
        access_token=access_token,
        refresh_token=refresh_token or None,
        token_type=str(token_data.get("token_type") or "Bearer"),
        access_token_expires_at=access_expires_at,
        refresh_token_expires_at=refresh_expires_at,
        token_metadata={
            "oauth_scope": scope_text,
            "configured_by_company_user_id": company_user_id,
            "provider": manifest.connector_provider,
        },
    )

    credential_payload = {
        key: value
        for key, value in {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "lark_open_id": lark_open_id,
            "lark_user_id": lark_user_id,
            "lark_email": lark_email,
            "scope": scope_text,
            "token_type": str(token_data.get("token_type") or "Bearer"),
            "access_token_expires_at": access_expires_at,
            "refresh_token_expires_at": refresh_expires_at,
        }.items()
        if value
    }
    repo.put_connector_credential(
        provider=manifest.connector_provider,
        company_id=company_id,
        company_user_id=company_user_id,
        scope=manifest.connection_scope,
        payload=credential_payload,
        metadata={
            "lark_email": lark_email,
            "email": lark_email,
            "lark_open_id": lark_open_id,
            "oauth_scope": scope_text,
            "configured_by_company_user_id": company_user_id,
            "provider": manifest.connector_provider,
            "runtime_user_id": resolved_user_id,
        },
    )
    if invalidate_runtime_cache is not None:
        invalidate_runtime_cache(manifest.connector_provider)

    return {
        "ok": True,
        "company_user_id": company_user_id,
        "user_id": resolved_user_id,
        "plugin_id": plugin_id,
        "lark_email": lark_email,
        "lark_open_id": lark_open_id,
    }


async def _exchange_lark_authorization_code(
    *,
    app_id: str,
    app_secret: str,
    code: str,
    redirect_uri: str,
    transport: httpx.AsyncBaseTransport | None,
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), transport=transport) as client:
        resp = await client.post(
            f"{lark_api_base_url()}/open-apis/authen/v2/oauth/token",
            json={
                "grant_type": "authorization_code",
                "client_id": app_id,
                "client_secret": app_secret,
                "code": code,
                "redirect_uri": redirect_uri,
            },
        )
    body = resp.json() if resp.content else {}
    code_value = body.get("code") if isinstance(body, dict) else None
    if resp.status_code >= 400 or code_value not in (0, "0", None):
        message = body.get("error_description") or body.get("msg") or body.get("message") if isinstance(body, dict) else resp.text
        raise LarkIntegrationOAuthError(f"Lark token exchange failed ({resp.status_code}): {message}")
    data = body.get("data") if isinstance(body, dict) and isinstance(body.get("data"), dict) else body
    return data if isinstance(data, dict) else {}


async def _fetch_lark_user_info(
    access_token: str,
    *,
    transport: httpx.AsyncBaseTransport | None,
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), transport=transport) as client:
        resp = await client.get(
            f"{lark_api_base_url()}/open-apis/authen/v1/user_info",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    body = resp.json() if resp.content else {}
    code_value = body.get("code") if isinstance(body, dict) else None
    if resp.status_code >= 400 or code_value not in (0, "0"):
        message = body.get("msg") or body.get("message") if isinstance(body, dict) else resp.text
        raise LarkIntegrationOAuthError(f"Lark user info failed ({resp.status_code}): {message}")
    data = body.get("data") if isinstance(body, dict) else {}
    return data if isinstance(data, dict) else {}
