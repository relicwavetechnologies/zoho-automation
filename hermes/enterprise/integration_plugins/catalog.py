"""Static integration plugin manifests."""

from __future__ import annotations

from enterprise.integration_plugins.models import (
    IntegrationPluginCapabilityDef,
    IntegrationPluginManifest,
    IntegrationPluginScopeDef,
)

GOOGLE_WORKSPACE_PLUGIN_ID = "google-workspace"
LARK_PLUGIN_ID = "lark"

_GOOGLE_OAUTH_SCOPES: tuple[IntegrationPluginScopeDef, ...] = (
    IntegrationPluginScopeDef(
        id="openid",
        label="OpenID",
        description="Sign in with Google and verify identity.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/userinfo.email",
        label="Email address",
        description="See your primary Google account email address.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/userinfo.profile",
        label="Basic profile",
        description="See your basic profile information.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/gmail.readonly",
        label="Gmail read",
        description="Read your Gmail messages and settings.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/gmail.compose",
        label="Gmail compose",
        description="Create and update Gmail drafts.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/gmail.send",
        label="Gmail send",
        description="Send email on your behalf.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/gmail.modify",
        label="Gmail modify",
        description="Read, compose, send, and permanently delete Gmail messages.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/drive.readonly",
        label="Drive read",
        description="See and download your Google Drive files.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/drive.file",
        label="Drive file access",
        description="Create and access files Divo creates or opens for you.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/calendar.readonly",
        label="Calendar read",
        description="View your Google Calendar events.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/calendar.events",
        label="Calendar events",
        description="View and manage events on calendars you can access.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/documents",
        label="Google Docs",
        description="Create, read, and edit Google Docs.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/spreadsheets",
        label="Google Sheets",
        description="Create, read, and edit Google Sheets.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="https://www.googleapis.com/auth/presentations",
        label="Google Slides",
        description="Create, read, and edit Google Slides.",
        required=True,
    ),
)

_GOOGLE_WORKSPACE = IntegrationPluginManifest(
    id=GOOGLE_WORKSPACE_PLUGIN_ID,
    name="Google Workspace",
    description=(
        "Connect Gmail, Calendar, Drive, Docs, Sheets, and Slides so Divo can "
        "search, draft, schedule, and create on your behalf."
    ),
    category="Productivity",
    featured=True,
    logo_key="google-workspace",
    auth_model="oauth",
    connector_provider="google",
    connection_scope="user",
    oauth_scopes=_GOOGLE_OAUTH_SCOPES,
    capabilities=(
        IntegrationPluginCapabilityDef(
            id="gmail",
            label="Gmail",
            description="Search, read, draft, and send email from your inbox.",
            tool_name="gmail",
            required_scopes=(
                "https://www.googleapis.com/auth/gmail.readonly",
                "https://www.googleapis.com/auth/gmail.compose",
                "https://www.googleapis.com/auth/gmail.send",
                "https://www.googleapis.com/auth/gmail.modify",
            ),
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="google_drive",
            label="Google Drive",
            description="Search and read files in your Drive.",
            tool_name="google_drive",
            required_scopes=(
                "https://www.googleapis.com/auth/drive.readonly",
                "https://www.googleapis.com/auth/drive.file",
            ),
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="google_calendar",
            label="Google Calendar",
            description="List events, check availability, and schedule meetings.",
            tool_name="google_calendar",
            required_scopes=(
                "https://www.googleapis.com/auth/calendar.readonly",
                "https://www.googleapis.com/auth/calendar.events",
            ),
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="google_docs",
            label="Google Docs",
            description="Create, read, and update Google Docs.",
            tool_name="google_docs",
            required_scopes=("https://www.googleapis.com/auth/documents",),
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="google_sheets",
            label="Google Sheets",
            description="Create, read, and update Google Sheets.",
            tool_name="google_sheets",
            required_scopes=("https://www.googleapis.com/auth/spreadsheets",),
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="google_slides",
            label="Google Slides",
            description="Create, read, and export Google Slides decks.",
            tool_name="google_slides",
            required_scopes=("https://www.googleapis.com/auth/presentations",),
            phase=1,
        ),
    ),
    examples=(
        "Search my Gmail for client emails.",
        "Schedule a meeting and add Google Meet.",
        "Create a Sheet from this report.",
        "Find the latest file in Drive.",
        "Draft a proposal in Docs.",
    ),
    env_requirements=(
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REDIRECT_URI",
    ),
)

_LARK_OAUTH_SCOPES: tuple[IntegrationPluginScopeDef, ...] = (
    IntegrationPluginScopeDef(
        id="offline_access",
        label="Offline access",
        description="Refresh your Lark authorization without asking you to reconnect every few hours.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="contact:user:search",
        label="Contact search",
        description="Search visible Lark workspace contacts by name, email, or Lark id.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="contact:user.email:readonly",
        label="Contact email",
        description="Resolve workspace contacts and match people by email.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="task:task:read",
        label="Task read",
        description="Read Lark tasks visible to you.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="task:task:write",
        label="Task write",
        description="Create and update Lark tasks on your behalf.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="docs:permission.setting:write_only",
        label="Docs permission settings",
        description="Update Lark Doc link-sharing settings.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="calendar:calendar:read",
        label="Calendar read",
        description="Read your Lark calendar and today's meetings.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="calendar:calendar.event:read",
        label="Calendar events",
        description="Read event details on calendars you can access.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="calendar:calendar.event:create",
        label="Calendar event create",
        description="Create calendar events on calendars you can access.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="calendar:calendar.event:update",
        label="Calendar event update",
        description="Update calendar events and manage attendees on calendars you can access.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="calendar:calendar.event:delete",
        label="Calendar event delete",
        description="Delete calendar events on calendars you can access.",
        required=True,
    ),
    IntegrationPluginScopeDef(
        id="calendar:calendar.free_busy:read",
        label="Calendar free/busy",
        description="Read free/busy availability for scheduling.",
        required=True,
    ),
)

_LARK = IntegrationPluginManifest(
    id=LARK_PLUGIN_ID,
    name="Lark",
    description=(
        "Connect your Lark account so Divo can resolve people, create docs, "
        "manage tasks, schedule calendar events, send messages, use Base, and handle approvals."
    ),
    category="Productivity",
    featured=True,
    logo_key="lark",
    auth_model="oauth",
    connector_provider="lark",
    connection_scope="user",
    oauth_scopes=_LARK_OAUTH_SCOPES,
    capabilities=(
        IntegrationPluginCapabilityDef(
            id="lark_messaging",
            label="Messages",
            description="Send and reply to Lark messages.",
            tool_name="lark_messaging",
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="lark_doc",
            label="Docs",
            description="Create, read, and update Lark docs.",
            tool_name="lark_doc",
            required_scopes=("docs:permission.setting:write_only",),
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="lark_task",
            label="Tasks",
            description="Create, list, update, complete, and comment on tasks.",
            tool_name="lark_task",
            required_scopes=("task:task:read", "task:task:write"),
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="lark_calendar",
            label="Calendar",
            description="Create, search, update, and delete calendar events.",
            tool_name="lark_calendar",
            required_scopes=(
                "calendar:calendar:read",
                "calendar:calendar.event:read",
                "calendar:calendar.event:create",
                "calendar:calendar.event:update",
                "calendar:calendar.event:delete",
                "calendar:calendar.free_busy:read",
            ),
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="lark_contacts",
            label="Contacts",
            description="Resolve company contacts by name, email, or Lark id.",
            tool_name="lark_contacts",
            required_scopes=("contact:user:search", "contact:user.email:readonly"),
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="lark_base",
            label="Base",
            description="Read and edit Lark Base records.",
            tool_name="lark_base",
            phase=1,
        ),
        IntegrationPluginCapabilityDef(
            id="lark_approval",
            label="Approvals",
            description="List, read, and create approval instances.",
            tool_name="lark_approval",
            phase=1,
        ),
    ),
    examples=(
        "Find Abhishek in Lark and send him a DM.",
        "Create a task and assign it to the right person.",
        "Create a Lark doc from this meeting summary.",
        "Schedule a calendar event with resolved attendees.",
    ),
    env_requirements=(
        "LARK_APP_ID",
        "LARK_APP_SECRET",
    ),
)

_INTEGRATION_PLUGINS: dict[str, IntegrationPluginManifest] = {
    GOOGLE_WORKSPACE_PLUGIN_ID: _GOOGLE_WORKSPACE,
    LARK_PLUGIN_ID: _LARK,
}


def list_integration_plugins() -> list[IntegrationPluginManifest]:
    return list(_INTEGRATION_PLUGINS.values())


def get_integration_plugin(plugin_id: str) -> IntegrationPluginManifest | None:
    return _INTEGRATION_PLUGINS.get(str(plugin_id or "").strip())
