"""Persist Lark dashboard OAuth tokens for native Lark tool execution."""

from __future__ import annotations

import logging
from typing import Any, Mapping

logger = logging.getLogger(__name__)


def sync_lark_tool_auth(session: Any, *, company_row: Mapping[str, Any] | None = None) -> bool:
    """Update ``LarkUserAuthLink`` from a successful Lark dashboard login/refresh.

    Dashboard auth and Lark tools share the same Lark OAuth app in Divo. Logging
    into Divo with Lark should therefore also refresh the per-user tool token
    vault; otherwise the dashboard session is valid while user-scoped Lark tools
    still fail with stale credentials.
    """
    if getattr(session, "provider", "") != "lark":
        return False
    metadata = getattr(session, "auth_metadata", None)
    if not isinstance(metadata, Mapping):
        return False
    access_token = str(metadata.get("lark_access_token") or "").strip()
    refresh_token = str(metadata.get("lark_refresh_token") or "").strip()
    if not access_token:
        return False

    try:
        from gateway.company_identity import get_identity_store

        store = get_identity_store()
        company_id = _row_field(company_row, "company_id", "companyId") or store.ensure_default_company()
        company_user_id = _row_field(company_row, "id", "company_user_id", "companyUserId")
        user_id = _row_field(company_row, "userId", "user_id") or None
        if not company_user_id:
            from gateway.company_identity import find_dashboard_company_user

            row = find_dashboard_company_user(
                provider=getattr(session, "provider", "") or "lark",
                provider_user_id=getattr(session, "user_id", "") or "",
                company_id=company_id,
                db=store,
            )
            company_user_id = _row_field(row, "id", "company_user_id", "companyUserId")
            user_id = _row_field(row, "userId", "user_id") or user_id

        from hermes_cli.web_server import _get_company_connector_repository, _invalidate_connector_runtime_cache

        repo = _get_company_connector_repository()
        repo.upsert_lark_user_auth_link(
            company_id=company_id,
            company_user_id=company_user_id or None,
            user_id=user_id,
            lark_tenant_key=str(metadata.get("lark_tenant_key") or getattr(session, "org_id", "") or ""),
            lark_open_id=str(metadata.get("lark_open_id") or getattr(session, "user_id", "") or ""),
            lark_user_id=str(metadata.get("lark_user_id") or "") or None,
            lark_email=str(metadata.get("lark_email") or getattr(session, "email", "") or ""),
            lark_name=str(metadata.get("lark_name") or getattr(session, "display_name", "") or "") or None,
            access_token=access_token,
            refresh_token=refresh_token or None,
            token_type=str(metadata.get("token_type") or "Bearer"),
            access_token_expires_at=metadata.get("access_token_expires_at"),
            refresh_token_expires_at=metadata.get("refresh_token_expires_at"),
            token_metadata={
                "oauth_scope": str(metadata.get("scope") or ""),
                "source": "dashboard_lark_login",
                "configured_by_company_user_id": company_user_id or "",
                "provider": "lark",
            },
        )
        repo.put_connector_credential(
            provider="lark",
            company_id=company_id,
            company_user_id=company_user_id or None,
            scope="user",
            payload={
                key: value
                for key, value in {
                    "access_token": access_token,
                    "refresh_token": refresh_token,
                    "lark_open_id": str(metadata.get("lark_open_id") or getattr(session, "user_id", "") or ""),
                    "lark_user_id": str(metadata.get("lark_user_id") or ""),
                    "lark_email": str(metadata.get("lark_email") or getattr(session, "email", "") or ""),
                    "scope": str(metadata.get("scope") or ""),
                    "token_type": str(metadata.get("token_type") or "Bearer"),
                    "access_token_expires_at": metadata.get("access_token_expires_at"),
                    "refresh_token_expires_at": metadata.get("refresh_token_expires_at"),
                }.items()
                if value
            },
            metadata={
                "lark_email": str(metadata.get("lark_email") or getattr(session, "email", "") or ""),
                "email": str(metadata.get("lark_email") or getattr(session, "email", "") or ""),
                "lark_open_id": str(metadata.get("lark_open_id") or getattr(session, "user_id", "") or ""),
                "oauth_scope": str(metadata.get("scope") or ""),
                "configured_by_company_user_id": company_user_id or "",
                "provider": "lark",
                "source": "dashboard_lark_login",
            },
        )
        _invalidate_connector_runtime_cache("lark")
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("dashboard-auth-lark: failed to sync tool OAuth link: %s", exc)
        return False


def find_synced_lark_refresh_token(payload: Mapping[str, Any]) -> str:
    """Return the current tool-vault Lark refresh token for a dashboard session.

    Lark refresh tokens rotate. Dashboard auth and native Lark tools share the
    same user OAuth grant, so a tool call can rotate the token before the
    dashboard cookie needs to refresh. This lookup lets dashboard auth recover
    from that legitimate rotation instead of forcing the user through OAuth.
    """
    if str(payload.get("provider") or "") != "lark":
        return ""
    lark_open_id = str(payload.get("sub") or "").strip()
    email = str(payload.get("email") or "").strip()
    if not lark_open_id and not email:
        return ""

    try:
        from gateway.company_identity import find_dashboard_company_user, get_identity_store
        from hermes_cli.web_server import _get_company_connector_repository

        store = get_identity_store()
        company_id = store.ensure_default_company()
        row = find_dashboard_company_user(
            provider="lark",
            provider_user_id=lark_open_id,
            company_id=company_id,
            db=store,
        )
        company_user_id = _row_field(row, "id", "company_user_id", "companyUserId") or None
        user_id = _row_field(row, "userId", "user_id") or None

        repo = _get_company_connector_repository()
        creds = repo.get_lark_user_credentials(
            company_id,
            company_user_id=company_user_id,
            user_id=user_id,
            lark_open_id=lark_open_id or None,
            email=email or None,
        )
        refresh_token = str(getattr(creds, "refresh_token", "") or "").strip()
        return refresh_token
    except Exception as exc:  # noqa: BLE001
        logger.debug("dashboard-auth-lark: synced refresh lookup failed: %s", exc)
        return ""


def _row_field(row: Mapping[str, Any] | None, *keys: str) -> str:
    if not row:
        return ""
    for key in keys:
        value = row.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""
