"""Merge static integration plugin manifests with connector credential state."""

from __future__ import annotations

import os
from typing import Any, Mapping

from enterprise.google_token import google_oauth_app_configured
from enterprise.integration_plugins.catalog import (
    GOOGLE_WORKSPACE_PLUGIN_ID,
    LARK_PLUGIN_ID,
    list_integration_plugins,
)
from enterprise.integration_plugins.lark_oauth import lark_oauth_app_configured
from enterprise.integration_plugins.models import (
    CapabilityRuntimeStatus,
    ConnectionStatus,
    IntegrationPluginActions,
    IntegrationPluginCapabilityView,
    IntegrationPluginConnectionView,
    IntegrationPluginManifest,
    IntegrationPluginStatusView,
)


def _row_field(row: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _parse_granted_scopes(metadata: Mapping[str, Any]) -> set[str]:
    raw = metadata.get("oauth_scope") or metadata.get("scope") or metadata.get("scopes")
    if isinstance(raw, list):
        return {str(item).strip() for item in raw if str(item).strip()}
    if isinstance(raw, str):
        return {part.strip() for part in raw.replace(",", " ").split() if part.strip()}
    return set()


def _is_active_credential(row: Mapping[str, Any]) -> bool:
    status = _row_field(row, "status").lower()
    revoked_at = _row_field(row, "revoked_at", "revokedAt")
    return status == "active" and not revoked_at


def _matching_credentials(
    rows: list[Mapping[str, Any]],
    *,
    manifest: IntegrationPluginManifest,
    company_user_id: str,
) -> list[Mapping[str, Any]]:
    matches: list[Mapping[str, Any]] = []
    for row in rows:
        provider = _row_field(row, "provider")
        scope = _row_field(row, "scope")
        row_user_id = _row_field(row, "company_user_id", "companyUserId")
        if provider != manifest.connector_provider:
            continue
        if scope != manifest.connection_scope:
            continue
        if manifest.connection_scope == "user" and row_user_id != company_user_id:
            continue
        matches.append(row)
    matches.sort(
        key=lambda row: _row_field(row, "updated_at", "updatedAt", "created_at", "createdAt"),
        reverse=True,
    )
    return matches


def _connection_status_for_rows(rows: list[Mapping[str, Any]]) -> ConnectionStatus:
    if not rows:
        return "not_connected"
    if any(_is_active_credential(row) for row in rows):
        return "connected"
    if any(_row_field(row, "status").lower() == "revoked" or _row_field(row, "revoked_at", "revokedAt") for row in rows):
        return "revoked"
    return "needs_reconnect"


def _primary_credential(rows: list[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    active = [row for row in rows if _is_active_credential(row)]
    if active:
        return active[0]
    return rows[0] if rows else None


def _capability_status(
    *,
    capability_required_scopes: tuple[str, ...],
    connection_status: ConnectionStatus,
    granted_scopes: set[str],
    phase: int,
) -> CapabilityRuntimeStatus:
    if connection_status in {"not_connected", "revoked"}:
        return "needs_connection"
    if connection_status == "needs_reconnect":
        return "needs_connection"
    if not capability_required_scopes:
        return "available"
    if all(scope in granted_scopes for scope in capability_required_scopes):
        return "available"
    return "needs_scope"


def resolve_plugin_status(
    manifest: IntegrationPluginManifest,
    connector_rows: list[Mapping[str, Any]],
    *,
    company_user_id: str,
    is_admin: bool,
    oauth_configured: bool,
) -> IntegrationPluginStatusView:
    user_rows = _matching_credentials(
        connector_rows,
        manifest=manifest,
        company_user_id=company_user_id,
    )
    connection_status = _connection_status_for_rows(user_rows)
    primary = _primary_credential(user_rows)
    metadata = primary.get("metadata") if isinstance(primary, Mapping) else {}
    metadata = metadata if isinstance(metadata, dict) else {}
    granted_scopes = _parse_granted_scopes(metadata)
    account_email = _row_field(metadata, "google_email", "lark_email", "email") or None
    connected_at = None
    credential_id = None
    if primary:
        connected_at = _row_field(primary, "updated_at", "updatedAt", "created_at", "createdAt") or None
        credential_id = _row_field(primary, "id") or None

    connection = IntegrationPluginConnectionView(
        status=connection_status,
        account_email=account_email,
        granted_scopes=tuple(sorted(granted_scopes)),
        connected_at=connected_at,
        credential_id=credential_id,
    )

    capability_views: list[IntegrationPluginCapabilityView] = []
    for capability in manifest.capabilities:
        capability_views.append(
            IntegrationPluginCapabilityView(
                id=capability.id,
                label=capability.label,
                description=capability.description,
                tool_name=capability.tool_name,
                status=_capability_status(
                    capability_required_scopes=capability.required_scopes,
                    connection_status=connection_status,
                    granted_scopes=granted_scopes,
                    phase=capability.phase,
                ),
                phase=capability.phase,
            )
        )

    needs_scope_upgrade = (
        connection_status == "connected"
        and any(view.status == "needs_scope" for view in capability_views)
    )
    can_connect = (
        manifest.auth_model == "oauth"
        and (connection_status in {"not_connected", "needs_reconnect", "revoked"} or needs_scope_upgrade)
        and oauth_configured
    )
    actions = IntegrationPluginActions(
        can_connect=can_connect,
        can_disconnect=False,
        can_manage_admin=is_admin,
    )

    admin_stats = None
    if is_admin:
        provider_rows = [
            row
            for row in connector_rows
            if _row_field(row, "provider") == manifest.connector_provider
            and _row_field(row, "scope") == manifest.connection_scope
        ]
        connected_users = {
            _row_field(row, "company_user_id", "companyUserId")
            for row in provider_rows
            if _is_active_credential(row) and _row_field(row, "company_user_id", "companyUserId")
        }
        admin_stats = {
            "connected_user_count": len(connected_users),
            "total_credentials": len(provider_rows),
        }

    return IntegrationPluginStatusView(
        id=manifest.id,
        manifest=manifest.to_public_dict(),
        connection={
            "status": connection.status,
            "account_email": connection.account_email,
            "granted_scopes": list(connection.granted_scopes),
            "connected_at": connection.connected_at,
            "credential_id": connection.credential_id,
        },
        capabilities=[
            {
                "id": view.id,
                "label": view.label,
                "description": view.description,
                "tool_name": view.tool_name,
                "status": view.status,
                "phase": view.phase,
            }
            for view in capability_views
        ],
        actions={
            "can_connect": actions.can_connect,
            "can_disconnect": actions.can_disconnect,
            "can_manage_admin": actions.can_manage_admin,
        },
        admin_stats=admin_stats,
    )


def oauth_environment_status() -> dict[str, bool]:
    redirect_configured = bool((os.getenv("GOOGLE_OAUTH_REDIRECT_URI") or "").strip())
    return {
        "google_configured": google_oauth_app_configured(),
        "lark_configured": lark_oauth_app_configured(),
        "redirect_configured": redirect_configured,
    }


def build_integration_plugins_response(
    *,
    company_id: str,
    actor: Mapping[str, Any],
    connector_rows: list[Mapping[str, Any]],
) -> dict[str, Any]:
    company_user_id = _row_field(actor, "id", "company_user_id", "companyUserId")
    role = _row_field(actor, "role").upper()
    is_admin = role in {"ADMIN", "COMPANY_ADMIN", "SUPER_ADMIN", "OWNER"}
    oauth = oauth_environment_status()
    plugins = []
    for manifest in list_integration_plugins():
        plugin_oauth_configured = False
        if manifest.id == GOOGLE_WORKSPACE_PLUGIN_ID:
            plugin_oauth_configured = oauth["google_configured"] and oauth["redirect_configured"]
        elif manifest.id == LARK_PLUGIN_ID:
            plugin_oauth_configured = oauth["lark_configured"]
        view = resolve_plugin_status(
            manifest,
            connector_rows,
            company_user_id=company_user_id,
            is_admin=is_admin,
            oauth_configured=plugin_oauth_configured,
        )
        payload = {
            "id": view.id,
            "manifest": view.manifest,
            "connection": view.connection,
            "capabilities": view.capabilities,
            "actions": view.actions,
        }
        if view.admin_stats is not None:
            payload["admin_stats"] = view.admin_stats
        plugins.append(payload)
    return {
        "company_id": company_id,
        "actor": {
            "company_user_id": company_user_id,
            "role": role or "MEMBER",
            "is_admin": is_admin,
        },
        "oauth": oauth,
        "plugins": plugins,
    }
