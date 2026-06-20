"""Google Workspace scope gating and structured reconnect/upgrade errors."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable

from enterprise.google_token import google_oauth_app_configured
from enterprise.integration_plugins.catalog import GOOGLE_WORKSPACE_PLUGIN_ID, get_integration_plugin
from tools.registry import tool_error

GOOGLE_TOOL_NAMES = frozenset({
    "gmail",
    "google_calendar",
    "google_drive",
    "google_docs",
    "google_sheets",
    "google_slides",
})

USER_SCOPED_CONNECTOR_PROVIDERS = frozenset({"google"})


@dataclass(frozen=True)
class GoogleConnectionContext:
    company_id: str
    company_user_id: str
    credentials: Any
    granted_scopes: frozenset[str]
    account_email: str | None = None


def parse_granted_scopes(raw: Any) -> set[str]:
    if raw is None:
        return set()
    if isinstance(raw, (list, tuple, set)):
        return {str(item).strip() for item in raw if str(item).strip()}
    text = str(raw).strip()
    if not text:
        return set()
    return {part.strip() for part in text.replace(",", " ").split() if part.strip()}


@lru_cache(maxsize=1)
def _google_manifest():
    return get_integration_plugin(GOOGLE_WORKSPACE_PLUGIN_ID)


def required_scopes_for_tool(tool_name: str) -> tuple[str, ...]:
    manifest = _google_manifest()
    if manifest is None:
        return ()
    for capability in manifest.capabilities:
        if capability.tool_name == tool_name:
            return tuple(capability.required_scopes)
    return ()


def scopes_satisfied(granted: Iterable[str], required: Iterable[str]) -> bool:
    granted_set = {str(s).strip() for s in granted if str(s).strip()}
    required_list = [str(s).strip() for s in required if str(s).strip()]
    if not required_list:
        return True
    return all(scope in granted_set for scope in required_list)


def missing_scopes(granted: Iterable[str], required: Iterable[str]) -> list[str]:
    granted_set = {str(s).strip() for s in granted if str(s).strip()}
    return [str(s).strip() for s in required if str(s).strip() and str(s).strip() not in granted_set]


def scope_upgrade_error(
    *,
    tool_name: str,
    missing: list[str],
    operation: str | None = None,
) -> str:
    labels = ", ".join(missing[:5])
    extra = f" (+{len(missing) - 5} more)" if len(missing) > 5 else ""
    return tool_error(
        f"Google scope upgrade required for {tool_name}. "
        f"Reconnect Google Workspace in Plugins to grant: {labels}{extra}",
        success=False,
        code="scope_upgrade_required",
        tool=tool_name,
        missing_scopes=missing,
        operation=operation or "",
    )


def reconnect_required_error(*, tool_name: str, operation: str | None = None) -> str:
    return tool_error(
        "No active Google connection for this user. Connect Google Workspace in Plugins first.",
        success=False,
        code="reconnect_required",
        tool=tool_name,
        operation=operation or "",
    )


def require_google_scopes(
    granted: Iterable[str],
    required: Iterable[str],
    *,
    tool_name: str,
    operation: str | None = None,
) -> str | None:
    missing = missing_scopes(granted, required)
    if missing:
        return scope_upgrade_error(tool_name=tool_name, missing=missing, operation=operation)
    return None


def map_google_api_error(exc: Exception, *, tool_name: str, operation: str | None = None) -> str:
    message = str(exc)
    lowered = message.lower()
    if "has not been used in project" in lowered or "it is disabled" in lowered or "api has not been used" in lowered:
        return tool_error(
            message,
            success=False,
            code="api_not_enabled",
            tool=tool_name,
            operation=operation or "",
        )
    if "403" in message or "insufficient" in lowered or "scope" in lowered:
        return tool_error(
            message,
            success=False,
            code="scope_upgrade_required",
            tool=tool_name,
            operation=operation or "",
        )
    if "401" in message:
        return reconnect_required_error(tool_name=tool_name, operation=operation)
    return tool_error(message, success=False, operation=operation or "", tool=tool_name)


def google_capabilities_fingerprint(company_id: str, company_user_id: str) -> str:
    """Stable hash of which google tools are available for this user right now."""
    available = sorted(
        name
        for name in GOOGLE_TOOL_NAMES
        if google_tool_available(name, company_id=company_id, company_user_id=company_user_id)
    )
    return "|".join(available)


def google_tool_available(
    tool_name: str,
    *,
    company_id: str | None = None,
    company_user_id: str | None = None,
    channel_identity_id: str | None = None,
) -> bool:
    """Whether *tool_name* should appear in the active agent schema."""
    tool_name = str(tool_name or "").strip()
    if tool_name not in GOOGLE_TOOL_NAMES:
        return False
    try:
        from tools.google_runtime import enterprise_enabled, get_google_connection
    except Exception:  # noqa: BLE001
        return False

    if not enterprise_enabled() or not google_oauth_app_configured():
        return False

    if company_id is None or company_user_id is None or channel_identity_id is None:
        try:
            from gateway.session_context import get_session_env
        except Exception:  # noqa: BLE001
            return False
        company_id = company_id or get_session_env("HERMES_COMPANY_ID", "")
        company_user_id = company_user_id or get_session_env("HERMES_COMPANY_USER_ID", "")
        channel_identity_id = channel_identity_id or get_session_env("HERMES_CHANNEL_IDENTITY_ID", "")

    company_id = str(company_id or "").strip()
    company_user_id = str(company_user_id or "").strip()
    channel_identity_id = str(channel_identity_id or "").strip()
    if not company_id or not company_user_id or not channel_identity_id:
        return False

    connection = get_google_connection(company_id, company_user_id)
    if connection is None:
        return False

    required = required_scopes_for_tool(tool_name)
    return scopes_satisfied(connection.granted_scopes, required)


def make_google_check_fn(tool_name: str):
    """Factory for per-tool ``check_fn`` callables."""

    def _check() -> bool:
        return google_tool_available(tool_name)

    _check.__name__ = f"google_tool_available_{tool_name}"
    _check.__qualname__ = _check.__name__
    return _check
