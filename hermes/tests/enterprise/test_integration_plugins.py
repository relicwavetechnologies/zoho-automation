"""Tests for enterprise integration plugin manifests and status mapping."""

from __future__ import annotations

from enterprise.integration_plugins.catalog import (
    GOOGLE_WORKSPACE_PLUGIN_ID,
    LARK_PLUGIN_ID,
    get_integration_plugin,
    list_integration_plugins,
)
from enterprise.integration_plugins.lark_oauth import required_lark_oauth_scope_ids
from enterprise.integration_plugins.status import (
    build_integration_plugins_response,
    resolve_plugin_status,
)


def _google_credential_row(
    *,
    company_user_id: str = "user_alice",
    status: str = "active",
    revoked_at: str | None = None,
    google_email: str = "alice@example.com",
    oauth_scope: str = (
        "https://www.googleapis.com/auth/gmail.readonly "
        "https://www.googleapis.com/auth/gmail.compose "
        "https://www.googleapis.com/auth/gmail.send "
        "https://www.googleapis.com/auth/gmail.modify "
        "https://www.googleapis.com/auth/drive.readonly "
        "https://www.googleapis.com/auth/drive.file"
    ),
) -> dict:
    return {
        "id": "cc_google_alice",
        "provider": "google",
        "scope": "user",
        "company_user_id": company_user_id,
        "status": status,
        "revoked_at": revoked_at,
        "created_at": "2026-06-17T10:00:00Z",
        "updated_at": "2026-06-17T10:00:00Z",
        "metadata": {
            "google_email": google_email,
            "oauth_scope": oauth_scope,
        },
    }


def test_catalog_includes_google_workspace_manifest():
    manifests = list_integration_plugins()
    assert len(manifests) >= 1
    manifest = get_integration_plugin(GOOGLE_WORKSPACE_PLUGIN_ID)
    assert manifest is not None
    assert manifest.name == "Google Workspace"
    assert manifest.connector_provider == "google"
    assert manifest.connection_scope == "user"
    assert any(capability.id == "gmail" for capability in manifest.capabilities)
    assert any(scope.id.endswith("gmail.readonly") for scope in manifest.oauth_scopes)
    assert all(scope.required for scope in manifest.oauth_scopes)
    assert any(scope.id.endswith("documents") for scope in manifest.oauth_scopes)
    assert any(scope.id.endswith("spreadsheets") for scope in manifest.oauth_scopes)
    assert any(scope.id.endswith("presentations") for scope in manifest.oauth_scopes)


def test_lark_manifest_requests_calendar_event_create_update_scopes():
    manifest = get_integration_plugin(LARK_PLUGIN_ID)
    assert manifest is not None
    scope_ids = {scope.id for scope in manifest.oauth_scopes}
    assert "calendar:calendar:read" in scope_ids
    assert "calendar:calendar.event:read" in scope_ids
    assert "calendar:calendar.event:create" in scope_ids
    assert "calendar:calendar.event:update" in scope_ids
    assert "calendar:calendar.event:delete" in scope_ids
    assert "calendar:calendar.free_busy:read" in scope_ids
    assert "docs:permission.setting:write_only" in scope_ids

    docs = next(capability for capability in manifest.capabilities if capability.id == "lark_doc")
    assert "docs:permission.setting:write_only" in docs.required_scopes
    calendar = next(capability for capability in manifest.capabilities if capability.id == "lark_calendar")
    assert "calendar:calendar.event:create" in calendar.required_scopes
    assert "calendar:calendar.event:update" in calendar.required_scopes
    assert "calendar:calendar.event:delete" in calendar.required_scopes
    assert "calendar:calendar.free_busy:read" in calendar.required_scopes
    required_scope_ids = required_lark_oauth_scope_ids(manifest)
    assert "calendar:calendar.event:create" in required_scope_ids
    assert "calendar:calendar.event:update" in required_scope_ids
    assert "calendar:calendar.event:delete" in required_scope_ids
    assert "calendar:calendar.free_busy:read" in required_scope_ids
    assert "docs:permission.setting:write_only" in required_scope_ids


def test_status_mapper_not_connected():
    manifest = get_integration_plugin(GOOGLE_WORKSPACE_PLUGIN_ID)
    assert manifest is not None
    view = resolve_plugin_status(
        manifest,
        [],
        company_user_id="user_alice",
        is_admin=False,
        oauth_configured=True,
    )
    assert view.connection["status"] == "not_connected"
    assert all(capability["status"] == "needs_connection" for capability in view.capabilities)
    assert view.actions["can_connect"] is True


def test_status_mapper_connected_user_scoped_google():
    manifest = get_integration_plugin(GOOGLE_WORKSPACE_PLUGIN_ID)
    assert manifest is not None
    view = resolve_plugin_status(
        manifest,
        [_google_credential_row()],
        company_user_id="user_alice",
        is_admin=False,
        oauth_configured=True,
    )
    assert view.connection["status"] == "connected"
    assert view.connection["account_email"] == "alice@example.com"
    gmail = next(item for item in view.capabilities if item["id"] == "gmail")
    drive = next(item for item in view.capabilities if item["id"] == "google_drive")
    calendar = next(item for item in view.capabilities if item["id"] == "google_calendar")
    assert gmail["status"] == "available"
    assert drive["status"] == "available"
    assert calendar["status"] == "needs_scope"
    assert view.actions["can_connect"] is True


def test_status_mapper_revoked_needs_reconnect():
    manifest = get_integration_plugin(GOOGLE_WORKSPACE_PLUGIN_ID)
    assert manifest is not None
    view = resolve_plugin_status(
        manifest,
        [_google_credential_row(status="revoked", revoked_at="2026-06-17T11:00:00Z")],
        company_user_id="user_alice",
        is_admin=False,
        oauth_configured=True,
    )
    assert view.connection["status"] == "revoked"
    assert view.actions["can_connect"] is True


def test_status_mapper_admin_stats():
    manifest = get_integration_plugin(GOOGLE_WORKSPACE_PLUGIN_ID)
    assert manifest is not None
    rows = [
        _google_credential_row(company_user_id="user_alice"),
        _google_credential_row(company_user_id="user_bob", google_email="bob@example.com"),
    ]
    admin_view = resolve_plugin_status(
        manifest,
        rows,
        company_user_id="user_alice",
        is_admin=True,
        oauth_configured=True,
    )
    member_view = resolve_plugin_status(
        manifest,
        rows,
        company_user_id="user_alice",
        is_admin=False,
        oauth_configured=True,
    )
    assert admin_view.admin_stats == {"connected_user_count": 2, "total_credentials": 2}
    assert member_view.admin_stats is None


def test_build_integration_plugins_response_shape():
    payload = build_integration_plugins_response(
        company_id="company_hermes",
        actor={"id": "user_alice", "role": "MEMBER"},
        connector_rows=[],
    )
    assert payload["company_id"] == "company_hermes"
    assert payload["actor"]["company_user_id"] == "user_alice"
    assert payload["actor"]["is_admin"] is False
    assert "google_configured" in payload["oauth"]
    assert payload["plugins"][0]["id"] == GOOGLE_WORKSPACE_PLUGIN_ID
