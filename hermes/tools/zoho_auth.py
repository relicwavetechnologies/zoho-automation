"""Zoho OAuth helpers for Hermes-native Zoho tools."""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx


DEFAULT_ZOHO_ACCOUNTS_BASE_URL = "https://accounts.zoho.com"
DEFAULT_ZOHO_API_BASE_URL = "https://www.zohoapis.com"
DEFAULT_TOKEN_SKEW_SECONDS = 120


class ZohoAuthError(RuntimeError):
    """Base class for Zoho auth failures."""


class ZohoConfigError(ZohoAuthError):
    """Raised when Zoho credentials are missing or invalid."""


class ZohoTokenError(ZohoAuthError):
    """Raised when Zoho token acquisition fails."""


@dataclass(frozen=True)
class ZohoCredentials:
    """Normalized single-connection Zoho OAuth credentials.

    Divo stores refresh tokens per company. Hermes is single-user today, so
    this native port reads one refresh token and optional Books organization ID
    from the process environment.
    """

    client_id: str
    client_secret: str
    refresh_token: str
    organization_id: str | None = None
    accounts_base_url: str = DEFAULT_ZOHO_ACCOUNTS_BASE_URL
    api_base_url: str = DEFAULT_ZOHO_API_BASE_URL
    scopes: str | None = None

    @property
    def token_url(self) -> str:
        return f"{self.accounts_base_url.rstrip('/')}/oauth/v2/token"

    @classmethod
    def from_env(
        cls,
        environ: dict[str, str] | None = None,
        *,
        required: bool = True,
    ) -> "ZohoCredentials | None":
        env = environ if environ is not None else os.environ
        client_id = (env.get("ZOHO_CLIENT_ID") or "").strip()
        client_secret = (env.get("ZOHO_CLIENT_SECRET") or "").strip()
        refresh_token = (
            env.get("ZOHO_REFRESH_TOKEN")
            or env.get("ZOHO_OAUTH_REFRESH_TOKEN")
            or env.get("ZOHO_BOOKS_REFRESH_TOKEN")
            or env.get("ZOHO_CRM_REFRESH_TOKEN")
            or ""
        ).strip()
        organization_id = (
            env.get("ZOHO_ORGANIZATION_ID")
            or env.get("ZOHO_ORG_ID")
            or env.get("ZOHO_BOOKS_ORGANIZATION_ID")
            or ""
        ).strip()
        accounts_base_url = (
            env.get("ZOHO_ACCOUNTS_BASE_URL")
            or env.get("ZOHO_ACCOUNTS_BASE")
            or DEFAULT_ZOHO_ACCOUNTS_BASE_URL
        ).strip()
        api_base_url = (
            env.get("ZOHO_API_BASE_URL") or DEFAULT_ZOHO_API_BASE_URL
        ).strip()
        scopes = (env.get("ZOHO_SCOPES") or "").strip()

        missing = [
            name
            for name, value in (
                ("ZOHO_CLIENT_ID", client_id),
                ("ZOHO_CLIENT_SECRET", client_secret),
                ("ZOHO_REFRESH_TOKEN", refresh_token),
            )
            if not value
        ]
        if missing:
            if not required:
                return None
            raise ZohoConfigError(
                f"Missing Zoho configuration: {', '.join(missing)}"
            )

        return cls(
            client_id=client_id,
            client_secret=client_secret,
            refresh_token=refresh_token,
            organization_id=organization_id or None,
            accounts_base_url=accounts_base_url.rstrip("/"),
            api_base_url=api_base_url.rstrip("/"),
            scopes=scopes or None,
        )


@dataclass
class CachedZohoAccessToken:
    """Cached Zoho OAuth access token."""

    access_token: str
    expires_at: float
    token_type: str = "Bearer"
    api_domain: str | None = None
    scope: str | None = None

    def is_expired(self, *, skew_seconds: int = DEFAULT_TOKEN_SKEW_SECONDS) -> bool:
        return self.expires_at <= (time.time() + max(0, int(skew_seconds)))

    @property
    def expires_in_seconds(self) -> int:
        return max(0, int(self.expires_at - time.time()))


class ZohoTokenProvider:
    """Acquire and cache Zoho access tokens using a refresh token."""

    def __init__(
        self,
        credentials: ZohoCredentials,
        *,
        timeout: float = 20.0,
        skew_seconds: int = DEFAULT_TOKEN_SKEW_SECONDS,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.credentials = credentials
        self.timeout = timeout
        self.skew_seconds = max(0, int(skew_seconds))
        self._transport = transport
        self._cached_token: CachedZohoAccessToken | None = None
        self._lock = asyncio.Lock()

    @classmethod
    def from_env(
        cls,
        environ: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> "ZohoTokenProvider":
        credentials = ZohoCredentials.from_env(environ)
        return cls(credentials, **kwargs)

    def clear_cache(self) -> None:
        self._cached_token = None

    def inspect_token_health(self) -> dict[str, Any]:
        cached = self._cached_token
        return {
            "configured": True,
            "client_id": self.credentials.client_id,
            "accounts_base_url": self.credentials.accounts_base_url,
            "api_base_url": self.credentials.api_base_url,
            "organization_id": self.credentials.organization_id,
            "token_url": self.credentials.token_url,
            "cached": bool(cached),
            "expires_in_seconds": cached.expires_in_seconds if cached else None,
            "is_expired": cached.is_expired(skew_seconds=0) if cached else None,
            "refresh_skew_seconds": self.skew_seconds,
            "scope": cached.scope if cached else self.credentials.scopes,
            "api_domain": cached.api_domain if cached else None,
        }

    async def get_access_token(self, *, force_refresh: bool = False) -> str:
        cached = self._cached_token
        if not force_refresh and cached and not cached.is_expired(
            skew_seconds=self.skew_seconds
        ):
            return cached.access_token

        async with self._lock:
            cached = self._cached_token
            if not force_refresh and cached and not cached.is_expired(
                skew_seconds=self.skew_seconds
            ):
                return cached.access_token

            token = await self._fetch_access_token()
            self._cached_token = token
            return token.access_token

    async def _fetch_access_token(self) -> CachedZohoAccessToken:
        data = {
            "grant_type": "refresh_token",
            "client_id": self.credentials.client_id,
            "client_secret": self.credentials.client_secret,
            "refresh_token": self.credentials.refresh_token,
        }
        headers = {"Content-Type": "application/x-www-form-urlencoded"}

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(self.timeout),
            transport=self._transport,
        ) as client:
            response = await client.post(
                self.credentials.token_url,
                data=data,
                headers=headers,
            )

        if response.status_code >= 400:
            detail = _extract_error_detail(response)
            raise ZohoTokenError(
                "Zoho token request failed with HTTP "
                f"{response.status_code}: {detail}"
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise ZohoTokenError("Zoho token response was not valid JSON.") from exc

        access_token = str(payload.get("access_token") or "").strip()
        token_type = str(payload.get("token_type") or "Bearer").strip() or "Bearer"
        expires_in = payload.get("expires_in")

        if not access_token:
            detail = _extract_payload_error(payload)
            raise ZohoTokenError(
                f"Zoho token response did not include access_token: {detail}"
            )

        try:
            expires_in_seconds = int(expires_in)
        except (TypeError, ValueError) as exc:
            raise ZohoTokenError(
                "Zoho token response did not include a valid expires_in."
            ) from exc

        return CachedZohoAccessToken(
            access_token=access_token,
            token_type=token_type,
            expires_at=time.time() + max(0, expires_in_seconds),
            api_domain=str(payload.get("api_domain") or "").strip() or None,
            scope=str(payload.get("scope") or "").strip() or None,
        )


def check_zoho_requirements(
    environ: dict[str, str] | None = None,
) -> bool:
    """Return True when the single Hermes Zoho connection is configured."""
    return ZohoCredentials.from_env(environ, required=False) is not None


def _extract_payload_error(payload: Any) -> str:
    if isinstance(payload, dict):
        if isinstance(payload.get("error_description"), str):
            return payload["error_description"]
        if isinstance(payload.get("error"), str):
            return payload["error"]
    return str(payload)


def _extract_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        text = response.text.strip()
        return text or "unknown error"
    return _extract_payload_error(payload)
