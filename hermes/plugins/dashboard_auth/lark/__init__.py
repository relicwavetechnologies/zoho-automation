"""LarkDashboardAuthProvider — Lark employee login for Hermes dashboard auth.

Implements the dashboard's OAuth provider protocol natively against Lark's
browser-web authorization flow:

  * authorize: ``https://accounts.larksuite.com/open-apis/authen/v1/authorize``
  * token: ``https://open.larksuite.com/open-apis/authen/v2/oauth/token``
  * user info: ``https://open.larksuite.com/open-apis/authen/v1/user_info``

Unlike the Nous / self-hosted providers, the Lark ``access_token`` is treated
as opaque to Hermes. The provider therefore mints its own HMAC-signed session
blobs for the dashboard cookies and stores the real Lark ``refresh_token``
inside the signed refresh cookie payload. This keeps request-time session
verification local (no per-request round-trip to Lark) while preserving the
ability to rotate the underlying Lark token pair when the access token expires.

Configuration surfaces (env wins over config when set non-empty):

  ``config.yaml`` — canonical surface::

      dashboard:
        oauth:
          lark:
            app_id: cli_xxxxx
            app_secret: secret_xxxxx
            scopes: offline_access
            accounts_base_url: https://accounts.larksuite.com
            api_base_url: https://open.larksuite.com

  Environment overrides::

      HERMES_DASHBOARD_LARK_APP_ID
      HERMES_DASHBOARD_LARK_APP_SECRET
      HERMES_DASHBOARD_LARK_SCOPES
      HERMES_DASHBOARD_LARK_ACCOUNTS_URL
      HERMES_DASHBOARD_LARK_API_BASE_URL

To reduce operator friction, the provider also accepts Hermes' shared Lark app
credentials when the dashboard-specific overrides are unset:

      LARK_APP_ID
      LARK_APP_SECRET
      LARK_API_BASE_URL

The callback URL itself is not configured here: Hermes already reconstructs it
from the incoming request (and/or ``HERMES_DASHBOARD_PUBLIC_URL``) in
``dashboard_auth.routes._redirect_uri``. Operators must allowlist that
``.../auth/callback`` URL in the Lark developer console.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider,
    InvalidCodeError,
    LoginStart,
    ProviderError,
    RefreshExpiredError,
    Session,
)

logger = logging.getLogger(__name__)


_DEFAULT_ACCOUNTS_BASE_URL = "https://accounts.larksuite.com"
_DEFAULT_API_BASE_URL = "https://open.larksuite.com"
_DEFAULT_SCOPES = (
    "offline_access "
    "contact:user:search contact:user.email:readonly "
    "task:task:read task:task:write "
    "docs:permission.setting:write_only "
    "calendar:calendar:read calendar:calendar.event:read "
    "calendar:calendar.event:create calendar:calendar.event:update "
    "calendar:calendar.event:delete calendar:calendar.free_busy:read"
)
_AUTHORIZE_PATH = "/open-apis/authen/v1/authorize"
_TOKEN_PATH = "/open-apis/authen/v2/oauth/token"
_USER_INFO_PATH = "/open-apis/authen/v1/user_info"
_TOKEN_TIMEOUT_SEC = 10.0
_USER_INFO_TIMEOUT_SEC = 10.0
_SIG_LEN = hashlib.sha256().digest_size


LAST_SKIP_REASON: str = ""


def _b64url_no_pad(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _sign(payload: dict[str, Any], secret: bytes) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sig = hmac.new(secret, raw, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(raw + sig).decode()


def _unsign(token: str, secret: bytes) -> Optional[dict[str, Any]]:
    try:
        blob = base64.urlsafe_b64decode(token.encode())
        if len(blob) <= _SIG_LEN:
            return None
        raw, sig = blob[:-_SIG_LEN], blob[-_SIG_LEN:]
        expected = hmac.new(secret, raw, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


class LarkDashboardAuthProvider(DashboardAuthProvider):
    """Lark OAuth provider for employee dashboard login."""

    name = "lark"
    display_name = "Lark"

    def __init__(
        self,
        *,
        app_id: str,
        app_secret: str,
        scopes: str = _DEFAULT_SCOPES,
        accounts_base_url: str = _DEFAULT_ACCOUNTS_BASE_URL,
        api_base_url: str = _DEFAULT_API_BASE_URL,
    ) -> None:
        if not app_id:
            raise ValueError("app_id is required")
        if not app_secret:
            raise ValueError("app_secret is required")

        self._app_id = app_id
        self._app_secret = app_secret
        self._scopes = (scopes or "").strip()
        self._accounts_base_url = accounts_base_url.rstrip("/")
        self._api_base_url = api_base_url.rstrip("/")
        self._authorize_url = f"{self._accounts_base_url}{_AUTHORIZE_PATH}"
        self._token_url = f"{self._api_base_url}{_TOKEN_PATH}"
        self._user_info_url = f"{self._api_base_url}{_USER_INFO_PATH}"
        self._session_secret = hashlib.sha256(
            f"hermes-dashboard-lark\x1f{app_id}\x1f{app_secret}".encode("utf-8")
        ).digest()

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        self._validate_redirect_uri(redirect_uri)

        code_verifier = _b64url_no_pad(secrets.token_bytes(64))
        code_challenge = _b64url_no_pad(
            hashlib.sha256(code_verifier.encode("ascii")).digest()
        )
        state = _b64url_no_pad(secrets.token_bytes(32))

        params = {
            "client_id": self._app_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        if self._scopes:
            params["scope"] = self._scopes

        redirect_url = f"{self._authorize_url}?{urllib.parse.urlencode(params)}"
        return LoginStart(
            redirect_url=redirect_url,
            cookie_payload={
                "hermes_session_pkce": f"state={state};verifier={code_verifier}",
            },
        )

    def complete_login(
        self,
        *,
        code: str,
        state: str,
        code_verifier: str,
        redirect_uri: str,
    ) -> Session:
        _ = state
        payload = self._exchange_token(
            {
                "grant_type": "authorization_code",
                "client_id": self._app_id,
                "client_secret": self._app_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            },
            bad_request_exc=InvalidCodeError,
        )
        user = self._fetch_user_info(payload["access_token"])
        return self._session_from_lark(
            access_token=payload["access_token"],
            refresh_token=payload["refresh_token"],
            expires_in=payload["expires_in"],
            refresh_expires_in=payload["refresh_expires_in"],
            user=user,
        )

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        payload = _unsign(access_token, self._session_secret)
        if not payload:
            return None
        if payload.get("provider") != self.name:
            return None
        exp = int(payload.get("exp") or 0)
        if exp <= int(time.time()):
            return None
        return Session(
            user_id=str(payload.get("sub") or ""),
            email=str(payload.get("email") or ""),
            display_name=str(payload.get("name") or ""),
            org_id=str(payload.get("org_id") or ""),
            provider=self.name,
            expires_at=exp,
            access_token=access_token,
            refresh_token="",
            user_id_alt=str(payload.get("user_id_alt") or ""),
        )

    def refresh_session(self, *, refresh_token: str) -> Session:
        payload = _unsign(refresh_token, self._session_secret)
        if not payload or payload.get("provider") != self.name:
            raise RefreshExpiredError("invalid dashboard refresh token")
        if int(payload.get("exp") or 0) <= int(time.time()):
            raise RefreshExpiredError("dashboard refresh token expired")

        raw_refresh_token = str(payload.get("rt") or "")
        if not raw_refresh_token:
            raise RefreshExpiredError("missing Lark refresh token")

        token_payload = self._refresh_lark_token(
            refresh_token=raw_refresh_token,
            session_payload=payload,
        )

        try:
            user = self._fetch_user_info(token_payload["access_token"])
        except ProviderError as exc:
            logger.warning(
                "dashboard-auth-lark: user_info refresh failed; falling back to cached identity: %s",
                exc,
            )
            user = {
                "open_id": payload.get("sub") or "",
                "email": payload.get("email") or "",
                "name": payload.get("name") or "",
                "tenant_key": payload.get("org_id") or "",
                "union_id": payload.get("user_id_alt") or "",
            }

        return self._session_from_lark(
            access_token=token_payload["access_token"],
            refresh_token=token_payload["refresh_token"],
            expires_in=token_payload["expires_in"],
            refresh_expires_in=token_payload["refresh_expires_in"],
            user=user,
        )

    def revoke_session(self, *, refresh_token: str) -> None:
        return None

    def _refresh_lark_token(
        self,
        *,
        refresh_token: str,
        session_payload: dict[str, Any],
    ) -> dict[str, Any]:
        try:
            return self._exchange_refresh_token(refresh_token)
        except RefreshExpiredError:
            synced_refresh = _find_synced_refresh_token(session_payload)
            if not synced_refresh or synced_refresh == refresh_token:
                raise
            logger.info(
                "dashboard-auth-lark: retrying refresh with synced tool-vault token"
            )
            return self._exchange_refresh_token(synced_refresh)

    def _exchange_refresh_token(self, refresh_token: str) -> dict[str, Any]:
        return self._exchange_token(
            {
                "grant_type": "refresh_token",
                "client_id": self._app_id,
                "client_secret": self._app_secret,
                "refresh_token": refresh_token,
            },
            bad_request_exc=RefreshExpiredError,
        )

    def _exchange_token(
        self,
        request_body: dict[str, Any],
        *,
        bad_request_exc: type[Exception],
    ) -> dict[str, Any]:
        try:
            response = httpx.post(
                self._token_url,
                json=request_body,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout=_TOKEN_TIMEOUT_SEC,
            )
        except httpx.RequestError as exc:
            raise ProviderError(f"Lark token endpoint unreachable: {exc}") from exc

        body = self._parse_json_body(response)
        api_code = body.get("code")
        if response.status_code >= 500:
            raise ProviderError(
                f"Lark token endpoint failed with HTTP {response.status_code}"
            )
        if response.status_code >= 400 or api_code not in (0, None):
            message = str(body.get("msg") or response.text or "request failed")
            raise bad_request_exc(f"Lark token exchange failed: {message}")

        payload = body.get("data") if isinstance(body.get("data"), dict) else body
        access_token = str(payload.get("access_token") or "").strip()
        refresh_token = str(payload.get("refresh_token") or "").strip()
        expires_in = int(payload.get("expires_in") or 0)
        refresh_expires_in = int(
            payload.get("refresh_token_expires_in")
            or payload.get("refresh_expires_in")
            or 0
        )

        if not access_token:
            raise ProviderError("Lark token response had no access_token")
        if not refresh_token:
            raise ProviderError(
                "Lark token response had no refresh_token; ensure offline_access is granted"
            )
        if expires_in <= 0:
            raise ProviderError("Lark token response had no expires_in")
        if refresh_expires_in <= 0:
            # Docs show ~7d; accept the common default if omitted.
            refresh_expires_in = 7 * 24 * 60 * 60

        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_in": expires_in,
            "refresh_expires_in": refresh_expires_in,
            "scope": str(payload.get("scope") or self._scopes or "").strip(),
            "token_type": str(payload.get("token_type") or "Bearer").strip(),
        }

    def _fetch_user_info(self, user_access_token: str) -> dict[str, Any]:
        try:
            response = httpx.get(
                self._user_info_url,
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {user_access_token}",
                },
                timeout=_USER_INFO_TIMEOUT_SEC,
            )
        except httpx.RequestError as exc:
            raise ProviderError(f"Lark user-info endpoint unreachable: {exc}") from exc

        body = self._parse_json_body(response)
        api_code = body.get("code")
        if response.status_code >= 500:
            raise ProviderError(
                f"Lark user-info endpoint failed with HTTP {response.status_code}"
            )
        if response.status_code >= 400 or api_code not in (0, None):
            raise ProviderError(
                f"Lark user-info request failed: {body.get('msg') or response.text}"
            )

        data = body.get("data") if isinstance(body.get("data"), dict) else body
        user_id = str(
            data.get("open_id") or data.get("user_id") or data.get("union_id") or ""
        ).strip()
        if not user_id:
            raise ProviderError("Lark user-info response had no open_id/user_id")
        tenant_key = str(data.get("tenant_key") or "").strip()
        if not tenant_key:
            raise ProviderError("Lark user-info response had no tenant_key")
        return data

    def _session_from_lark(
        self,
        *,
        access_token: str,
        refresh_token: str,
        expires_in: int,
        refresh_expires_in: int,
        user: dict[str, Any],
    ) -> Session:
        now = int(time.time())
        user_id = str(
            user.get("open_id") or user.get("user_id") or user.get("union_id") or ""
        ).strip()
        if not user_id:
            raise ProviderError("Lark user profile missing stable user id")
        email = str(user.get("email") or user.get("enterprise_email") or "").strip()
        display_name = str(
            user.get("name") or user.get("en_name") or email or user_id
        ).strip()
        user_id_alt = str(user.get("union_id") or "").strip()
        org_id = str(user.get("tenant_key") or "").strip()
        if not org_id:
            raise ProviderError("Lark user profile missing tenant_key")

        access_exp = now + max(60, int(expires_in))
        refresh_exp = now + max(60, int(refresh_expires_in))
        signed_access = _sign(
            {
                "provider": self.name,
                "sub": user_id,
                "email": email,
                "name": display_name,
                "user_id_alt": user_id_alt,
                "org_id": org_id,
                "exp": access_exp,
            },
            self._session_secret,
        )
        signed_refresh = _sign(
            {
                "provider": self.name,
                "sub": user_id,
                "email": email,
                "name": display_name,
                "user_id_alt": user_id_alt,
                "org_id": org_id,
                "exp": refresh_exp,
                "rt": refresh_token,
            },
            self._session_secret,
        )

        return Session(
            user_id=user_id,
            email=email,
            display_name=display_name,
            org_id=org_id,
            provider=self.name,
            expires_at=access_exp,
            access_token=signed_access,
            refresh_token=signed_refresh,
            user_id_alt=user_id_alt,
            auth_metadata={
                "lark_access_token": access_token,
                "lark_refresh_token": refresh_token,
                "lark_open_id": str(user.get("open_id") or user_id or "").strip(),
                "lark_user_id": str(user.get("user_id") or "").strip(),
                "lark_email": email,
                "lark_name": display_name,
                "lark_tenant_key": org_id,
                "scope": self._scopes,
                "token_type": "Bearer",
                "access_token_expires_at": datetime.fromtimestamp(access_exp, tz=timezone.utc).isoformat(),
                "refresh_token_expires_at": datetime.fromtimestamp(refresh_exp, tz=timezone.utc).isoformat(),
            },
        )

    def _validate_redirect_uri(self, redirect_uri: str) -> None:
        parsed = urllib.parse.urlparse(redirect_uri)
        if parsed.scheme not in ("https", "http"):
            raise ProviderError(
                f"redirect_uri must be http(s), got {redirect_uri!r}"
            )
        if parsed.scheme == "http" and parsed.hostname not in (
            "localhost",
            "127.0.0.1",
        ):
            raise ProviderError(
                "redirect_uri may only use http:// for localhost/127.0.0.1, "
                f"got {redirect_uri!r}"
            )
        if not parsed.path or not parsed.path.endswith("/auth/callback"):
            raise ProviderError(
                "redirect_uri path must end with '/auth/callback', "
                f"got {redirect_uri!r}"
            )

    def _parse_json_body(self, response: httpx.Response) -> Dict[str, Any]:
        ctype = response.headers.get("content-type", "")
        if not ctype.startswith("application/json"):
            return {}
        try:
            body = response.json()
        except ValueError:
            return {}
        return body if isinstance(body, dict) else {}


def _load_config_oauth_section() -> dict[str, Any]:
    try:
        from hermes_cli.config import cfg_get, load_config

        cfg = load_config()
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "dashboard-auth-lark: load_config() raised %s; falling back to env-only configuration",
            exc,
        )
        return {}
    section = cfg_get(cfg, "dashboard", "oauth", default=None)
    return section if isinstance(section, dict) else {}


def _lark_subsection(oauth_section: dict[str, Any]) -> dict[str, Any]:
    sub = oauth_section.get("lark")
    return sub if isinstance(sub, dict) else {}


def _resolve_setting(env_vars: tuple[str, ...], cfg_value: Any) -> str:
    for env_var in env_vars:
        value = _expand_env_reference(os.environ.get(env_var, "")).strip()
        if value:
            return value
    return _expand_env_reference(cfg_value).strip()


def _expand_env_reference(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    expanded = os.path.expandvars(text).strip()
    if expanded.startswith("$"):
        return ""
    return expanded


def _find_synced_refresh_token(payload: dict[str, Any]) -> str:
    try:
        from hermes_cli.dashboard_auth.lark_tool_link import find_synced_lark_refresh_token

        return find_synced_lark_refresh_token(payload)
    except Exception as exc:  # noqa: BLE001
        logger.debug("dashboard-auth-lark: synced refresh fallback unavailable: %s", exc)
        return ""


def register(ctx) -> None:
    global LAST_SKIP_REASON
    LAST_SKIP_REASON = ""

    oauth_section = _load_config_oauth_section()
    lark_cfg = _lark_subsection(oauth_section)

    app_id = _resolve_setting(
        ("HERMES_DASHBOARD_LARK_APP_ID", "LARK_APP_ID"),
        lark_cfg.get("app_id"),
    )
    app_secret = _resolve_setting(
        ("HERMES_DASHBOARD_LARK_APP_SECRET", "LARK_APP_SECRET"),
        lark_cfg.get("app_secret"),
    )
    scopes = _resolve_setting(
        ("HERMES_DASHBOARD_LARK_SCOPES",),
        lark_cfg.get("scopes"),
    )
    accounts_base_url = _resolve_setting(
        ("HERMES_DASHBOARD_LARK_ACCOUNTS_URL",),
        lark_cfg.get("accounts_base_url"),
    ) or _DEFAULT_ACCOUNTS_BASE_URL
    api_base_url = _resolve_setting(
        ("HERMES_DASHBOARD_LARK_API_BASE_URL", "LARK_API_BASE_URL"),
        lark_cfg.get("api_base_url"),
    ) or _DEFAULT_API_BASE_URL

    if not app_id or not app_secret:
        LAST_SKIP_REASON = (
            "missing Lark app credentials. Configure either "
            "dashboard.oauth.lark.{app_id,app_secret} in config.yaml, "
            "HERMES_DASHBOARD_LARK_APP_ID/HERMES_DASHBOARD_LARK_APP_SECRET, "
            "or the shared LARK_APP_ID/LARK_APP_SECRET env vars."
        )
        logger.info("dashboard-auth-lark: %s", LAST_SKIP_REASON)
        return

    try:
        provider = LarkDashboardAuthProvider(
            app_id=app_id,
            app_secret=app_secret,
            scopes=scopes or _DEFAULT_SCOPES,
            accounts_base_url=accounts_base_url,
            api_base_url=api_base_url,
        )
    except Exception as exc:  # noqa: BLE001
        LAST_SKIP_REASON = f"invalid Lark dashboard auth configuration: {exc}"
        logger.warning("dashboard-auth-lark: %s", LAST_SKIP_REASON)
        return

    ctx.register_dashboard_auth_provider(provider)
    LAST_SKIP_REASON = ""
