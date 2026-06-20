"""Google Workspace integration-plugin OAuth (authorize + callback)."""

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

from enterprise.integration_plugins.catalog import GOOGLE_WORKSPACE_PLUGIN_ID, get_integration_plugin
from enterprise.integration_plugins.models import IntegrationPluginManifest

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
_STATE_TTL_SECONDS = 600
_SIG_LEN = 32


class GoogleIntegrationOAuthError(RuntimeError):
    """Raised when Google integration OAuth cannot start or complete."""


def google_redirect_uri() -> str:
    return (os.getenv("GOOGLE_OAUTH_REDIRECT_URI") or "").strip()


def google_oauth_client_config() -> tuple[str, str]:
    client_id = (os.getenv("GOOGLE_OAUTH_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("GOOGLE_OAUTH_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret:
        raise GoogleIntegrationOAuthError("Google OAuth app credentials are not configured")
    return client_id, client_secret


def _oauth_state_secret() -> bytes:
    raw = (
        (os.getenv("HERMES_OAUTH_STATE_SECRET") or "").strip()
        or (os.getenv("ZOHO_TOKEN_ENCRYPTION_KEY") or "").strip()
        or "hermes-integration-oauth-dev"
    )
    return hashlib.sha256(raw.encode("utf-8")).digest()


def _b64url_no_pad(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


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


def required_oauth_scope_ids(manifest: IntegrationPluginManifest) -> list[str]:
    return [scope.id for scope in manifest.oauth_scopes if scope.required]


def build_google_authorize_url(
    *,
    company_id: str,
    company_user_id: str,
    plugin_id: str = GOOGLE_WORKSPACE_PLUGIN_ID,
    redirect_uri: str | None = None,
) -> str:
    manifest = get_integration_plugin(plugin_id)
    if manifest is None:
        raise GoogleIntegrationOAuthError(f"Unknown integration plugin {plugin_id!r}")

    redirect = (redirect_uri or google_redirect_uri()).strip()
    if not redirect:
        raise GoogleIntegrationOAuthError("GOOGLE_OAUTH_REDIRECT_URI is not configured")

    client_id, _client_secret = google_oauth_client_config()
    code_verifier = _b64url_no_pad(secrets.token_bytes(64))
    code_challenge = _b64url_no_pad(hashlib.sha256(code_verifier.encode("ascii")).digest())
    state = _sign_state(
        {
            "v": 1,
            "company_id": company_id,
            "company_user_id": company_user_id,
            "plugin_id": plugin_id,
            "redirect_uri": redirect,
            "code_verifier": code_verifier,
            "exp": int(time.time()) + _STATE_TTL_SECONDS,
        }
    )
    params = {
        "client_id": client_id,
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": " ".join(required_oauth_scope_ids(manifest)),
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "access_type": "offline",
        "include_granted_scopes": "true",
        "prompt": "consent",
    }
    return f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"


async def complete_google_oauth_callback(
    *,
    code: str,
    state: str,
    repo: Any,
    invalidate_runtime_cache: Any | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    payload = _unsign_state(state)
    if payload is None:
        raise GoogleIntegrationOAuthError("Invalid or expired OAuth state")

    exp = int(payload.get("exp") or 0)
    if exp <= int(time.time()):
        raise GoogleIntegrationOAuthError("OAuth state expired — try connecting again")

    company_id = str(payload.get("company_id") or "").strip()
    company_user_id = str(payload.get("company_user_id") or "").strip()
    plugin_id = str(payload.get("plugin_id") or GOOGLE_WORKSPACE_PLUGIN_ID).strip()
    redirect_uri = str(payload.get("redirect_uri") or google_redirect_uri()).strip()
    code_verifier = str(payload.get("code_verifier") or "").strip()
    if not company_id or not company_user_id or not code_verifier:
        raise GoogleIntegrationOAuthError("OAuth state is missing required fields")

    manifest = get_integration_plugin(plugin_id)
    if manifest is None:
        raise GoogleIntegrationOAuthError(f"Unknown integration plugin {plugin_id!r}")

    client_id, client_secret = google_oauth_client_config()
    token_data = await _exchange_authorization_code(
        client_id=client_id,
        client_secret=client_secret,
        code=code,
        redirect_uri=redirect_uri,
        code_verifier=code_verifier,
        transport=transport,
    )
    access_token = str(token_data.get("access_token") or "").strip()
    refresh_token = str(token_data.get("refresh_token") or "").strip()
    if not refresh_token and not access_token:
        raise GoogleIntegrationOAuthError("Google did not return tokens")

    scope_text = str(token_data.get("scope") or " ".join(required_oauth_scope_ids(manifest))).strip()
    expires_in = int(token_data.get("expires_in") or 3600)
    expires_at = datetime.fromtimestamp(time.time() + max(0, expires_in), tz=timezone.utc).isoformat()

    profile = await _fetch_google_profile(access_token, transport=transport)
    google_email = str(profile.get("email") or "").strip()

    credential_payload = {
        key: value
        for key, value in {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "google_email": google_email,
            "scope": scope_text,
            "token_type": str(token_data.get("token_type") or "Bearer"),
            "access_token_expires_at": expires_at,
        }.items()
        if value
    }
    metadata = {
        "google_email": google_email,
        "oauth_scope": scope_text,
        "configured_by_company_user_id": company_user_id,
        "provider": manifest.connector_provider,
    }
    credential_id = repo.put_connector_credential(
        provider=manifest.connector_provider,
        company_id=company_id,
        company_user_id=company_user_id,
        scope=manifest.connection_scope,
        payload=credential_payload,
        metadata=metadata,
    )
    if invalidate_runtime_cache is not None:
        invalidate_runtime_cache(manifest.connector_provider)

    return {
        "ok": True,
        "credential_id": credential_id,
        "google_email": google_email,
        "company_user_id": company_user_id,
        "plugin_id": plugin_id,
    }


async def _exchange_authorization_code(
    *,
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
    code_verifier: str,
    transport: httpx.AsyncBaseTransport | None,
) -> dict[str, Any]:
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
        "code_verifier": code_verifier,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), transport=transport) as client:
        resp = await client.post(GOOGLE_TOKEN_URL, data=data)
    if resp.status_code >= 400:
        raise GoogleIntegrationOAuthError(
            f"Google token exchange failed ({resp.status_code}): {resp.text[:200]}"
        )
    body = resp.json()
    return body if isinstance(body, dict) else {}


async def _fetch_google_profile(
    access_token: str,
    *,
    transport: httpx.AsyncBaseTransport | None,
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0), transport=transport) as client:
        resp = await client.get(GOOGLE_USERINFO_URL, headers=headers)
    if resp.status_code >= 400:
        raise GoogleIntegrationOAuthError(
            f"Google profile lookup failed ({resp.status_code}): {resp.text[:200]}"
        )
    body = resp.json()
    return body if isinstance(body, dict) else {}
