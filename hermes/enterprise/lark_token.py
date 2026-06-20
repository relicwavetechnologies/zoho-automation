"""Lark tenant-access-token minting + minimal authorized client.

Lark authenticates the app: a tenant access token is minted from
``app_id`` + ``app_secret`` (``/open-apis/auth/v3/tenant_access_token/internal``)
and lives ~2h. Mirrors Divo's Lark adapter token flow.

Read-only on credentials: tokens are cached in-memory, never persisted.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

TENANT_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal"
DEFAULT_TOKEN_SKEW_SECONDS = 120


class LarkAuthError(RuntimeError):
    """Raised when a Lark tenant access token cannot be acquired."""


class LarkAPIError(RuntimeError):
    """Raised when a Lark API call returns a non-zero code."""


@dataclass
class _CachedLarkToken:
    token: str
    expires_at: float

    def is_expired(self, *, skew_seconds: int = DEFAULT_TOKEN_SKEW_SECONDS) -> bool:
        return self.expires_at <= (time.time() + max(0, int(skew_seconds)))


class LarkTokenProvider:
    """Mint and cache a tenant access token from app credentials."""

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        *,
        api_base_url: str = "https://open.larksuite.com",
        static_token: str | None = None,
        skew_seconds: int = DEFAULT_TOKEN_SKEW_SECONDS,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.app_id = app_id
        self.app_secret = app_secret
        self.api_base_url = api_base_url.rstrip("/")
        self.skew_seconds = max(0, int(skew_seconds))
        self.timeout = timeout
        self._transport = transport
        self._lock = asyncio.Lock()
        self._cached: Optional[_CachedLarkToken] = None
        # A statically-provisioned tenant token (rare) is used as-is; we cannot
        # know its expiry, so assume the standard ~2h window from first use.
        self._static_token = (static_token or "").strip() or None

    async def get_token(self, *, force_refresh: bool = False) -> str:
        if self._static_token and not force_refresh:
            return self._static_token
        cached = self._cached
        if not force_refresh and cached and not cached.is_expired(skew_seconds=self.skew_seconds):
            return cached.token
        async with self._lock:
            cached = self._cached
            if not force_refresh and cached and not cached.is_expired(skew_seconds=self.skew_seconds):
                return cached.token
            token = await self._mint()
            self._cached = token
            return token.token

    async def _mint(self) -> _CachedLarkToken:
        if not self.app_id or not self.app_secret:
            raise LarkAuthError("Lark app_id/app_secret not configured")
        async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout), transport=self._transport) as client:
            resp = await client.post(
                f"{self.api_base_url}{TENANT_TOKEN_PATH}",
                json={"app_id": self.app_id, "app_secret": self.app_secret},
            )
        payload = resp.json() if resp.content else {}
        if resp.status_code >= 400 or payload.get("code") not in (0, None):
            raise LarkAuthError(
                f"Lark tenant token failed (http {resp.status_code}, code {payload.get('code')}): "
                f"{payload.get('msg')}"
            )
        token = str(payload.get("tenant_access_token") or "").strip()
        if not token:
            raise LarkAuthError("Lark tenant token response had no tenant_access_token")
        expire = int(payload.get("expire") or 7200)
        return _CachedLarkToken(token, time.time() + max(0, expire))


class LarkStaticTokenProvider:
    """Token provider for an already-minted user access token."""

    def __init__(self, access_token: str) -> None:
        self.access_token = str(access_token or "").strip()

    async def get_token(self, *, force_refresh: bool = False) -> str:
        if not self.access_token:
            raise LarkAuthError("Lark user access token not configured")
        return self.access_token


class LarkClient:
    """Minimal authorized JSON client for Lark Open APIs."""

    def __init__(
        self,
        token_provider: LarkTokenProvider,
        *,
        api_base_url: str = "https://open.larksuite.com",
        timeout: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.token_provider = token_provider
        self.api_base_url = api_base_url.rstrip("/")
        self.timeout = timeout
        self._transport = transport

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
    ) -> Any:
        url = path if path.startswith("http") else f"{self.api_base_url}{path}"
        for attempt in range(2):
            token = await self.token_provider.get_token(force_refresh=attempt == 1)
            headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"}
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout), transport=self._transport) as client:
                resp = await client.request(method, url, params=params, json=json_body, headers=headers)
            try:
                payload = resp.json() if resp.content else {}
            except json.JSONDecodeError:
                payload = {}
            code = payload.get("code")
            # 99991663/99991661 = invalid/expired tenant token → refresh once.
            if code in (99991663, 99991661) and attempt == 0:
                continue
            if resp.status_code >= 400:
                raise LarkAPIError(f"Lark API {method} {path} failed (http {resp.status_code}): {resp.text[:300]}")
            if code not in (0, None):
                raise LarkAPIError(f"Lark API {method} {path} returned code {code}: {payload.get('msg')}")
            return payload.get("data", payload)
        raise LarkAPIError("Lark API request failed after token refresh")
