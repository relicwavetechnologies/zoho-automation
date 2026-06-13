"""Per-company connector credentials, read natively from runtime Postgres.

The transformed Hermes runtime owns connector execution. Instead of per-process
env credentials, it reads each company's encrypted OAuth credentials from a
Hermes-owned connector credential table and decrypts them in process via
:mod:`enterprise.token_crypto`.

During migration we still understand the old Divo-shaped tables
(``ZohoConnectionProfile``, ``GoogleUserAuthLink``, ``LarkWorkspaceConfig``) as
read-only references. Native Hermes rows always win when present.

The connection is injected (like ``EnterpriseIdentityRepository``) so tests use a
fake connection and production uses a psycopg connection owned by the gateway.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

from enterprise.token_crypto import decrypt_token, encrypt_token, try_decrypt_token

NATIVE_CONNECTOR_TABLE = "HermesConnectorCredential"
NATIVE_CONNECTOR_PROVIDERS = {"zoho", "google", "lark"}


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
    source: str  # "user" | "company"
    access_token: str = ""
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
    from ``app_id`` + ``app_secret``. ``source`` is ``"native"`` (Hermes-owned),
    ``"config"`` (legacy per-company ``LarkWorkspaceConfig``) or ``"env"``
    (shared ``LARK_APP_*`` fallback, never used by enterprise runtime tools).
    """

    company_id: str
    app_id: str
    app_secret: str
    api_base_url: str = "https://open.larksuite.com"
    static_tenant_access_token: Optional[str] = None
    source: str = "config"


class ConnectorCredentialRepository:
    """Read/write encrypted per-company connector credentials from Postgres."""

    def __init__(self, connection: Any, *, encryption_key: str | None = None):
        self._connection = connection
        # None → token_crypto resolves ZOHO_TOKEN_ENCRYPTION_KEY from env.
        self._encryption_key = encryption_key

    def put_connector_credential(
        self,
        *,
        provider: str,
        company_id: str,
        payload: Mapping[str, Any],
        company_user_id: str | None = None,
        scope: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        status: str = "active",
    ) -> str:
        """Upsert one Hermes-owned encrypted connector credential row.

        ``payload`` is encrypted as a single JSON document so provider-specific
        token shapes can evolve without schema churn. The deterministic row id
        makes repeated OAuth setup idempotent for a provider/company/user scope.
        """
        provider = self._normalize_provider(provider)
        company_id = str(company_id or "").strip()
        company_user_id = str(company_user_id or "").strip() or None
        if not company_id:
            raise ValueError("company_id is required")
        if not isinstance(payload, Mapping) or not payload:
            raise ValueError("payload must be a non-empty mapping")

        effective_scope = str(scope or ("user" if company_user_id else "company")).strip() or "company"
        credential_id = self._stable_credential_id(
            provider=provider,
            company_id=company_id,
            company_user_id=company_user_id,
            scope=effective_scope,
        )
        encrypted_payload = encrypt_token(
            json.dumps(dict(payload), sort_keys=True, separators=(",", ":")),
            self._encryption_key,
        )
        self._execute(
            f"""
            INSERT INTO "{NATIVE_CONNECTOR_TABLE}" (
                "id", "companyId", "companyUserId", "provider", "scope",
                "payloadEncrypted", "metadata", "status", "createdAt", "updatedAt"
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, now(), now())
            ON CONFLICT ("id") DO UPDATE SET
                "payloadEncrypted" = excluded."payloadEncrypted",
                "metadata" = excluded."metadata",
                "status" = excluded."status",
                "revokedAt" = NULL,
                "updatedAt" = now()
            """,
            (
                credential_id,
                company_id,
                company_user_id,
                provider,
                effective_scope,
                encrypted_payload,
                json.dumps(dict(metadata or {}), sort_keys=True, separators=(",", ":")),
                str(status or "active"),
            ),
        )
        return credential_id

    def list_connector_credentials(self, *, company_id: str) -> list[dict[str, Any]]:
        """Return non-secret native connector credential rows for one company."""
        company_id = str(company_id or "").strip()
        if not company_id:
            return []
        rows = self._fetchall_optional(
            f"""
            SELECT
                "id",
                "companyId",
                "companyUserId",
                "provider",
                "scope",
                "metadata",
                "status",
                "createdAt",
                "updatedAt",
                "revokedAt"
            FROM "{NATIVE_CONNECTOR_TABLE}"
            WHERE "companyId" = %s
            ORDER BY "provider" ASC, "scope" ASC, "updatedAt" DESC
            """,
            (company_id,),
        )
        return [self._public_connector_row(row) for row in rows]

    def revoke_connector_credentials(
        self,
        *,
        provider: str,
        company_id: str,
        company_user_id: str | None = None,
        scope: str | None = None,
    ) -> int:
        """Mark native connector credentials revoked for a company/provider."""
        provider = self._normalize_provider(provider)
        company_id = str(company_id or "").strip()
        company_user_id = str(company_user_id or "").strip() or None
        scope = str(scope or "").strip() or None
        if not company_id:
            return 0

        filters = [
            '"companyId" = %s',
            '"provider" = %s',
            '"revokedAt" IS NULL',
        ]
        args: list[Any] = [company_id, provider]
        if company_user_id is not None:
            filters.append('"companyUserId" = %s')
            args.append(company_user_id)
        if scope is not None:
            filters.append('"scope" = %s')
            args.append(scope)

        return self._execute_rowcount(
            f"""
            UPDATE "{NATIVE_CONNECTOR_TABLE}"
            SET "status" = 'revoked',
                "revokedAt" = now(),
                "updatedAt" = now()
            WHERE {' AND '.join(filters)}
            """,
            tuple(args),
        )

    def get_zoho_credentials(self, company_id: str) -> Optional[ZohoConnectionCredentials]:
        """Active Zoho connection for *company_id*, or ``None`` if not connected.

        Prefers the active ``ZohoConnectionProfile`` (it carries the client
        id/secret needed to refresh). Returns ``None`` when no active profile
        exists or its required secrets cannot be decrypted.
        """
        company_id = str(company_id or "").strip()
        if not company_id:
            return None

        native = self._get_native_connector_payload("zoho", company_id)
        if native is not None:
            return self._zoho_from_native_payload(company_id, native)

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

        native = self._get_native_connector_payload(
            "google",
            company_id,
            company_user_id=user_id,
            allow_company_fallback=True,
        )
        if native is not None:
            return self._google_from_native_payload(
                company_id,
                native,
                user_id=user_id,
            )

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
        self,
        company_id: str,
        *,
        env: Mapping[str, str] | None = None,
        allow_env_fallback: bool = True,
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

        native = self._get_native_connector_payload("lark", company_id)
        if native is not None:
            return self._lark_from_native_payload(company_id, native)

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

        if allow_env_fallback:
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

    def _get_native_connector_payload(
        self,
        provider: str,
        company_id: str,
        *,
        company_user_id: str | None = None,
        allow_company_fallback: bool = False,
    ) -> Optional[Mapping[str, Any]]:
        provider = self._normalize_provider(provider)
        company_id = str(company_id or "").strip()
        company_user_id = str(company_user_id or "").strip() or None
        if not company_id:
            return None

        rows_to_try: list[tuple[str, tuple[Any, ...]]] = []
        if company_user_id:
            rows_to_try.append((
                f"""
                SELECT "payloadEncrypted", "metadata", "scope", "companyUserId"
                FROM "{NATIVE_CONNECTOR_TABLE}"
                WHERE "companyId" = %s
                  AND "companyUserId" = %s
                  AND "provider" = %s
                  AND COALESCE("status", 'active') = 'active'
                  AND "revokedAt" IS NULL
                ORDER BY "updatedAt" DESC
                LIMIT 1
                """,
                (company_id, company_user_id, provider),
            ))
        if allow_company_fallback or not company_user_id:
            rows_to_try.append((
                f"""
                SELECT "payloadEncrypted", "metadata", "scope", "companyUserId"
                FROM "{NATIVE_CONNECTOR_TABLE}"
                WHERE "companyId" = %s
                  AND "companyUserId" IS NULL
                  AND "provider" = %s
                  AND COALESCE("status", 'active') = 'active'
                  AND "revokedAt" IS NULL
                ORDER BY "updatedAt" DESC
                LIMIT 1
                """,
                (company_id, provider),
            ))

        for sql, args in rows_to_try:
            row = self._fetchone_optional(sql, args)
            payload = self._decode_native_payload(row)
            if payload is not None:
                return payload
        return None

    def _zoho_from_native_payload(
        self, company_id: str, payload: Mapping[str, Any]
    ) -> Optional[ZohoConnectionCredentials]:
        client_id = self._payload_get(payload, "client_id", "clientId")
        client_secret = self._payload_get(payload, "client_secret", "clientSecret")
        refresh_token = self._payload_get(payload, "refresh_token", "refreshToken")
        if not client_id or not client_secret or not refresh_token:
            return None
        scopes = payload.get("scopes") or []
        if isinstance(scopes, str):
            scopes = [s for s in scopes.split() if s]
        return ZohoConnectionCredentials(
            company_id=company_id,
            client_id=client_id,
            client_secret=client_secret,
            refresh_token=refresh_token,
            access_token=self._payload_get(payload, "access_token", "accessToken") or None,
            access_token_expires_at=payload.get("access_token_expires_at") or payload.get("accessTokenExpiresAt"),
            accounts_base_url=(
                self._payload_get(payload, "accounts_base_url", "accountsBaseUrl")
                or "https://accounts.zoho.com"
            ).rstrip("/"),
            api_base_url=(
                self._payload_get(payload, "api_base_url", "apiBaseUrl")
                or "https://www.zohoapis.com"
            ).rstrip("/"),
            api_domain=self._payload_get(payload, "api_domain", "apiDomain") or None,
            environment=self._payload_get(payload, "environment") or "prod",
            status=self._payload_get(payload, "status") or "active",
            scopes=list(scopes),
        )

    def _google_from_native_payload(
        self,
        company_id: str,
        payload: Mapping[str, Any],
        *,
        user_id: str | None = None,
    ) -> Optional[GoogleConnectionCredentials]:
        access_token = self._payload_get(payload, "access_token", "accessToken")
        refresh_token = self._payload_get(payload, "refresh_token", "refreshToken")
        if not access_token and not refresh_token:
            return None
        native_user_id = self._payload_get(payload, "_credential_company_user_id")
        native_scope = self._payload_get(payload, "_credential_scope")
        source = "user" if native_user_id or native_scope == "user" else "company"
        return GoogleConnectionCredentials(
            company_id=company_id,
            access_token=access_token or "",
            source=source,
            user_id=native_user_id or (str(user_id) if (user_id and source == "user") else None),
            google_email=self._payload_get(payload, "google_email", "googleEmail") or None,
            refresh_token=refresh_token or None,
            access_token_expires_at=payload.get("access_token_expires_at") or payload.get("accessTokenExpiresAt"),
            scope=self._payload_get(payload, "scope") or None,
            token_type=self._payload_get(payload, "token_type", "tokenType") or "Bearer",
        )

    def _lark_from_native_payload(
        self, company_id: str, payload: Mapping[str, Any]
    ) -> Optional[LarkConnectionCredentials]:
        app_id = self._payload_get(payload, "app_id", "appId")
        app_secret = self._payload_get(payload, "app_secret", "appSecret")
        if not app_id or not app_secret:
            return None
        return LarkConnectionCredentials(
            company_id=company_id,
            app_id=app_id,
            app_secret=app_secret,
            api_base_url=(
                self._payload_get(payload, "api_base_url", "apiBaseUrl")
                or "https://open.larksuite.com"
            ).rstrip("/"),
            static_tenant_access_token=(
                self._payload_get(payload, "static_tenant_access_token", "staticTenantAccessToken")
                or None
            ),
            source="native",
        )

    # -- connection helpers (mirror EnterpriseIdentityRepository) -----------

    @staticmethod
    def _normalize_provider(provider: str) -> str:
        normalized = str(provider or "").strip().lower()
        if normalized not in NATIVE_CONNECTOR_PROVIDERS:
            raise ValueError(f"Unsupported connector provider: {provider!r}")
        return normalized

    @staticmethod
    def _stable_credential_id(
        *,
        provider: str,
        company_id: str,
        company_user_id: str | None,
        scope: str,
    ) -> str:
        seed = "\x1f".join((provider, company_id, company_user_id or "", scope))
        digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
        return f"cc_{digest}"

    @staticmethod
    def _payload_get(payload: Mapping[str, Any], *keys: str) -> str:
        for key in keys:
            value = payload.get(key)
            if value is not None:
                text = str(value).strip()
                if text:
                    return text
        return ""

    def _decode_native_payload(self, row: Any) -> Optional[Mapping[str, Any]]:
        if row is None:
            return None
        encrypted = self._row_get(row, "payloadEncrypted")
        raw = try_decrypt_token(encrypted, self._encryption_key)
        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if not isinstance(payload, Mapping):
            return None
        decoded = dict(payload)
        scope = self._row_get(row, "scope")
        company_user_id = self._row_get(row, "companyUserId")
        if scope:
            decoded["_credential_scope"] = str(scope)
        if company_user_id:
            decoded["_credential_company_user_id"] = str(company_user_id)
        return decoded

    def _fetchone_optional(self, sql: str, args: tuple[Any, ...]) -> Any:
        try:
            return self._fetchone(sql, args)
        except Exception:  # noqa: BLE001 — native table may not exist during migration
            return None

    def _fetchall_optional(self, sql: str, args: tuple[Any, ...]) -> list[Any]:
        try:
            return self._fetchall(sql, args)
        except Exception:  # noqa: BLE001 — native table may not exist during migration
            return []

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
            return list(fetchall() or [])
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()

    def _execute(self, sql: str, args: tuple[Any, ...]) -> None:
        result = self._connection.execute(sql, args)
        close = getattr(result, "close", None)
        if close is not None:
            close()

    def _execute_rowcount(self, sql: str, args: tuple[Any, ...]) -> int:
        result = self._connection.execute(sql, args)
        rowcount = int(getattr(result, "rowcount", 0) or 0)
        close = getattr(result, "close", None)
        if close is not None:
            close()
        return rowcount

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

    def _public_connector_row(self, row: Any) -> dict[str, Any]:
        metadata = self._row_get(row, "metadata") or {}
        if not isinstance(metadata, Mapping):
            metadata = {}
        return {
            "id": str(self._row_get(row, "id") or ""),
            "company_id": str(self._row_get(row, "companyId") or ""),
            "company_user_id": str(self._row_get(row, "companyUserId") or ""),
            "provider": str(self._row_get(row, "provider") or ""),
            "scope": str(self._row_get(row, "scope") or ""),
            "metadata": dict(metadata),
            "status": str(self._row_get(row, "status") or ""),
            "created_at": self._row_get(row, "createdAt"),
            "updated_at": self._row_get(row, "updatedAt"),
            "revoked_at": self._row_get(row, "revokedAt"),
        }
