"""Google OAuth token refresh + minimal authorized client for native tools.

Google uses a shared OAuth app (``GOOGLE_OAUTH_CLIENT_ID`` /
``GOOGLE_OAUTH_CLIENT_SECRET`` from env) plus a per-link refresh token read from
Postgres (``GoogleUserAuthLink`` / ``CompanyGoogleAuthLink``). This mirrors
Divo's ``google-oauth.service.ts``.

Read-only: refreshed access tokens are cached in-memory and never written back
to Postgres this phase.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
DEFAULT_TOKEN_SKEW_SECONDS = 120


class GoogleAuthError(RuntimeError):
    """Raised when a Google access token cannot be acquired."""


@dataclass
class _CachedGoogleToken:
    access_token: str
    expires_at: float

    def is_expired(self, *, skew_seconds: int = DEFAULT_TOKEN_SKEW_SECONDS) -> bool:
        return self.expires_at <= (time.time() + max(0, int(skew_seconds)))


def google_oauth_app_configured(environ: dict[str, str] | None = None) -> bool:
    env = environ if environ is not None else os.environ
    return bool(
        (env.get("GOOGLE_OAUTH_CLIENT_ID") or "").strip()
        and (env.get("GOOGLE_OAUTH_CLIENT_SECRET") or "").strip()
    )


class GoogleTokenProvider:
    """Acquire/cache a Google access token from a refresh token."""

    def __init__(
        self,
        refresh_token: str | None,
        *,
        client_id: str | None = None,
        client_secret: str | None = None,
        seed_access_token: str | None = None,
        seed_expires_at: float | None = None,
        skew_seconds: int = DEFAULT_TOKEN_SKEW_SECONDS,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        env = os.environ
        self.client_id = (client_id if client_id is not None else env.get("GOOGLE_OAUTH_CLIENT_ID", "")).strip()
        self.client_secret = (
            client_secret if client_secret is not None else env.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
        ).strip()
        self.refresh_token = (refresh_token or "").strip()
        self.skew_seconds = max(0, int(skew_seconds))
        self.timeout = timeout
        self._transport = transport
        self._lock = asyncio.Lock()
        self._cached: Optional[_CachedGoogleToken] = None
        if seed_access_token and seed_expires_at:
            self._cached = _CachedGoogleToken(seed_access_token, seed_expires_at)

    async def get_access_token(self, *, force_refresh: bool = False) -> str:
        cached = self._cached
        if not force_refresh and cached and not cached.is_expired(skew_seconds=self.skew_seconds):
            return cached.access_token
        async with self._lock:
            cached = self._cached
            if not force_refresh and cached and not cached.is_expired(skew_seconds=self.skew_seconds):
                return cached.access_token
            token = await self._refresh()
            self._cached = token
            return token.access_token

    async def _refresh(self) -> _CachedGoogleToken:
        if not self.refresh_token:
            raise GoogleAuthError("No Google refresh token available for this connection")
        if not self.client_id or not self.client_secret:
            raise GoogleAuthError(
                "Google OAuth app not configured (GOOGLE_OAUTH_CLIENT_ID/SECRET)"
            )
        data = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "refresh_token": self.refresh_token,
            "grant_type": "refresh_token",
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout), transport=self._transport) as client:
            resp = await client.post(GOOGLE_TOKEN_URL, data=data)
        if resp.status_code >= 400:
            raise GoogleAuthError(f"Google token refresh failed ({resp.status_code}): {resp.text[:200]}")
        payload = resp.json()
        access_token = str(payload.get("access_token") or "").strip()
        if not access_token:
            raise GoogleAuthError("Google token refresh returned no access_token")
        expires_in = int(payload.get("expires_in") or 3600)
        return _CachedGoogleToken(access_token, time.time() + max(0, expires_in))


class GoogleClient:
    """Minimal authorized JSON client for Google REST APIs.

    Injects the bearer token and transparently refreshes once on 401. Tool
    families (calendar/drive/gmail) build their requests on top of this.
    """

    def __init__(
        self,
        token_provider: GoogleTokenProvider,
        *,
        timeout: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.token_provider = token_provider
        self.timeout = timeout
        self._transport = transport

    async def request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
    ) -> Any:
        for attempt in range(2):
            token = await self.token_provider.get_access_token(force_refresh=attempt == 1)
            headers = {"Authorization": f"Bearer {token}"}
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout), transport=self._transport) as client:
                resp = await client.request(method, url, params=params, json=json_body, headers=headers)
            if resp.status_code == 401 and attempt == 0:
                continue  # token expired between cache and call — refresh once
            if resp.status_code >= 400:
                raise GoogleAuthError(f"Google API {method} {url} failed ({resp.status_code}): {resp.text[:300]}")
            if resp.status_code == 204 or not resp.content:
                return None
            return resp.json()
        raise GoogleAuthError("Google API request failed after token refresh")
