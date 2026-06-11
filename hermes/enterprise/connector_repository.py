"""Per-company connector credentials, read natively from the runtime Postgres.

The transformed Hermes runtime owns connector execution. Instead of per-process
env credentials, it reads each company's encrypted OAuth credentials directly
from the Divo schema (``ZohoConnectionProfile`` / ``ZohoConnection``) and
decrypts them in process via :mod:`enterprise.token_crypto`.

This phase is **read-only**: we never write refreshed tokens back to Postgres.
Access tokens are refreshed in-memory by the token provider (see
``tools/zoho_auth.py``) so they don't expire mid-use, mirroring Divo's
``zoho-token.service.ts`` without taking ownership of the write path yet.

The connection is injected (like ``EnterpriseIdentityRepository``) so tests use a
fake connection and production uses a psycopg connection owned by the gateway.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

from enterprise.token_crypto import decrypt_token, try_decrypt_token


@dataclass(frozen=True)
class ZohoConnectionCredentials:
    """Decrypted Zoho OAuth credentials for one company.

    ``organization_id`` is intentionally absent: Zoho Books resolves it at
    runtime from the ``/organizations`` endpoint (Divo does the same), so it is
    not stored on the connection.
    """

    company_id: str
    client_id: str
    client_secret: str
    refresh_token: str
    accounts_base_url: str
    api_base_url: str
    access_token: Optional[str] = None
    access_token_expires_at: Optional[Any] = None
    api_domain: Optional[str] = None
    environment: str = "prod"
    status: str = ""
    scopes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class GoogleConnectionCredentials:
    """Decrypted Google OAuth credentials for one company (or company-user).

    Google uses a shared OAuth app (client id/secret from env) plus a per-link
    refresh token, unlike Zoho's per-company client. ``source`` records whether
    the link was the per-user (``GoogleUserAuthLink``) or company-level
    (``CompanyGoogleAuthLink``) row.
    """

    company_id: str
    access_token: str
    source: str  # "user" | "company"
    user_id: Optional[str] = None
    google_email: Optional[str] = None
    refresh_token: Optional[str] = None
    access_token_expires_at: Optional[Any] = None
    scope: Optional[str] = None
    token_type: str = "Bearer"


@dataclass(frozen=True)
class LarkConnectionCredentials:
    """Lark app credentials for one company.

    Lark authenticates the *app* (not a user): a tenant access token is minted
    from ``app_id`` + ``app_secret``. ``source`` is ``"config"`` (per-company
    ``LarkWorkspaceConfig``) or ``"env"`` (shared ``LARK_APP_*`` fallback).
    """

    company_id: str
    app_id: str
    app_secret: str
    api_base_url: str = "https://open.larksuite.com"
    static_tenant_access_token: Optional[str] = None
    source: str = "config"


class ConnectorCredentialRepository:
    """Read + decrypt per-company connector credentials from Postgres."""

    def __init__(self, connection: Any, *, encryption_key: str | None = None):
        self._connection = connection
        # None → token_crypto resolves ZOHO_TOKEN_ENCRYPTION_KEY from env.
        self._encryption_key = encryption_key

    def get_zoho_credentials(self, company_id: str) -> Optional[ZohoConnectionCredentials]:
        """Active Zoho connection for *company_id*, or ``None`` if not connected.

        Prefers the active ``ZohoConnectionProfile`` (it carries the client
        id/secret needed to refresh). Returns ``None`` when no active profile
        exists or its required secrets cannot be decrypted.
        """
        company_id = str(company_id or "").strip()
        if not company_id:
            return None

        row = self._fetchone(
            """
            SELECT
                "clientId",
                "clientSecretEncrypted",
                "refreshTokenEncrypted",
                "accessTokenEncrypted",
                "accessTokenExpiresAt",
                "accountsBaseUrl",
                "apiBaseUrl",
                "tokenMetadata",
                "environment",
                "status",
                "scopes"
            FROM "ZohoConnectionProfile"
            WHERE "companyId" = %s AND "isActive" = true
            ORDER BY "updatedAt" DESC
            LIMIT 1
            """,
            (company_id,),
        )
        if row is None:
            return None

        client_id = self._row_get(row, "clientId") or ""
        client_secret_enc = self._row_get(row, "clientSecretEncrypted")
        refresh_enc = self._row_get(row, "refreshTokenEncrypted")
        if not client_id or not client_secret_enc or not refresh_enc:
            # An active profile without the secrets needed to refresh is
            # unusable — treat as not connected rather than half-built creds.
            return None

        try:
            client_secret = decrypt_token(client_secret_enc, self._encryption_key)
            refresh_token = decrypt_token(refresh_enc, self._encryption_key)
        except Exception:  # noqa: BLE001 — decrypt failure ⇒ unusable connection
            return None

        access_token = try_decrypt_token(
            self._row_get(row, "accessTokenEncrypted"), self._encryption_key
        )
        metadata = self._row_get(row, "tokenMetadata") or {}
        api_domain = metadata.get("apiDomain") if isinstance(metadata, Mapping) else None

        return ZohoConnectionCredentials(
            company_id=company_id,
            client_id=client_id,
            client_secret=client_secret,
            refresh_token=refresh_token,
            access_token=access_token,
            access_token_expires_at=self._row_get(row, "accessTokenExpiresAt"),
            accounts_base_url=(self._row_get(row, "accountsBaseUrl") or "").rstrip("/"),
            api_base_url=(self._row_get(row, "apiBaseUrl") or "").rstrip("/"),
            api_domain=api_domain,
            environment=self._row_get(row, "environment") or "prod",
            status=self._row_get(row, "status") or "",
            scopes=list(self._row_get(row, "scopes") or []),
        )

    def get_google_credentials(
        self, company_id: str, user_id: str | None = None
    ) -> Optional[GoogleConnectionCredentials]:
        """Google credentials for *company_id* (preferring the per-user link).

        Resolution order: an active ``GoogleUserAuthLink`` for ``(company, user)``
        when ``user_id`` is given, else the company-level ``CompanyGoogleAuthLink``.
        Returns ``None`` when neither exists or the access token cannot decrypt.
        """
        company_id = str(company_id or "").strip()
        if not company_id:
            return None

        row = None
        source = "company"
        if user_id:
            row = self._fetchone(
                """
                SELECT "googleEmail", "scope", "tokenType",
                       "accessTokenEncrypted", "refreshTokenEncrypted",
                       "accessTokenExpiresAt"
                FROM "GoogleUserAuthLink"
                WHERE "companyId" = %s AND "userId" = %s AND "revokedAt" IS NULL
                ORDER BY "linkedAt" DESC
                LIMIT 1
                """,
                (company_id, str(user_id)),
            )
            if row is not None:
                source = "user"

        if row is None:
            row = self._fetchone(
                """
                SELECT "googleEmail", "scope", "tokenType",
                       "accessTokenEncrypted", "refreshTokenEncrypted",
                       "accessTokenExpiresAt"
                FROM "CompanyGoogleAuthLink"
                WHERE "companyId" = %s AND "revokedAt" IS NULL
                LIMIT 1
                """,
                (company_id,),
            )
            source = "company"

        if row is None:
            return None

        access_token = try_decrypt_token(
            self._row_get(row, "accessTokenEncrypted"), self._encryption_key
        )
        if not access_token:
            # accessTokenEncrypted is NOT NULL; a decrypt miss means a key
            # mismatch — the link is unusable.
            return None

        return GoogleConnectionCredentials(
            company_id=company_id,
            access_token=access_token,
            source=source,
            user_id=str(user_id) if (user_id and source == "user") else None,
            google_email=self._row_get(row, "googleEmail"),
            refresh_token=try_decrypt_token(
                self._row_get(row, "refreshTokenEncrypted"), self._encryption_key
            ),
            access_token_expires_at=self._row_get(row, "accessTokenExpiresAt"),
            scope=self._row_get(row, "scope"),
            token_type=self._row_get(row, "tokenType") or "Bearer",
        )

    def get_lark_credentials(
        self, company_id: str, *, env: Mapping[str, str] | None = None
    ) -> Optional[LarkConnectionCredentials]:
        """Lark app credentials for *company_id*.

        Prefers a per-company ``LarkWorkspaceConfig`` (decrypting the app
        secret); falls back to shared ``LARK_APP_ID`` / ``LARK_APP_SECRET`` env
        vars (what Divo uses today). Returns ``None`` when neither is available.
        """
        import os

        company_id = str(company_id or "").strip()
        if not company_id:
            return None

        row = self._fetchone(
            """
            SELECT "appId", "appSecretEncrypted", "apiBaseUrl",
                   "staticTenantAccessTokenEncrypted"
            FROM "LarkWorkspaceConfig"
            WHERE "companyId" = %s
            LIMIT 1
            """,
            (company_id,),
        )
        if row is not None:
            app_id = self._row_get(row, "appId") or ""
            app_secret = try_decrypt_token(
                self._row_get(row, "appSecretEncrypted"), self._encryption_key
            )
            if app_id and app_secret:
                return LarkConnectionCredentials(
                    company_id=company_id,
                    app_id=app_id,
                    app_secret=app_secret,
                    api_base_url=(self._row_get(row, "apiBaseUrl") or "https://open.larksuite.com").rstrip("/"),
                    static_tenant_access_token=try_decrypt_token(
                        self._row_get(row, "staticTenantAccessTokenEncrypted"), self._encryption_key
                    ),
                    source="config",
                )

        environ = env if env is not None else os.environ
        app_id = (environ.get("LARK_APP_ID") or "").strip()
        app_secret = (environ.get("LARK_APP_SECRET") or "").strip()
        if app_id and app_secret:
            return LarkConnectionCredentials(
                company_id=company_id,
                app_id=app_id,
                app_secret=app_secret,
                api_base_url=(environ.get("LARK_API_BASE_URL") or "https://open.larksuite.com").rstrip("/"),
                source="env",
            )
        return None

    # -- connection helpers (mirror EnterpriseIdentityRepository) -----------

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
