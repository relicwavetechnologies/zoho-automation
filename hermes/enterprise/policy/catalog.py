"""Canonical policy resource/action catalog for Hermes admin and tool gates."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


READ = "read"
CREATE = "create"
UPDATE = "update"
DELETE = "delete"
SEND = "send"
EXECUTE = "execute"
MANAGE = "manage"
APPROVE = "approve"

ADMIN_ROLES = frozenset({"ADMIN", "COMPANY_ADMIN", "SUPER_ADMIN", "OWNER"})
SUPER_ADMIN_ROLES = frozenset({"SUPER_ADMIN", "OWNER"})
KNOWN_COMPANY_ROLES = frozenset({"MEMBER", "ADMIN", "COMPANY_ADMIN", "SUPER_ADMIN", "OWNER"})

HIGH_RISK_ADMIN_TOOL_NAMES = frozenset({"skill_manage", "discord_admin"})
HIGH_RISK_ADMIN_TOOLSETS = frozenset({"discord_admin"})
FIRST_CLASS_USER_SCOPED_CONNECTORS = frozenset({"google"})
FIRST_CLASS_USER_SCOPED_TOOLSETS = frozenset({"google"})
SENSITIVE_TOOLSETS = frozenset({
    "credentials",
    "env",
    "google",
    "lark",
    "mcp",
    "ops",
    "skills",
    "system",
    "zoho",
})


@dataclass(frozen=True)
class AdminRoutePolicy:
    capability: str
    action: str
    resource: str
    label: str
    admin_only: bool = True


ADMIN_ROUTE_POLICIES: dict[str, AdminRoutePolicy] = {
    "sessions": AdminRoutePolicy("sessions.read", READ, "AdminRoute:sessions", "Sessions", admin_only=False),
    "logs": AdminRoutePolicy("logs.read", READ, "AdminRoute:logs", "Logs"),
    "cron": AdminRoutePolicy("cron.manage", MANAGE, "AdminRoute:cron", "Cron"),
    "skills": AdminRoutePolicy("skills.manage", MANAGE, "AdminRoute:skills", "Skills"),
    "plugins": AdminRoutePolicy("plugins.manage", MANAGE, "AdminRoute:plugins", "Plugins"),
    "mcp": AdminRoutePolicy("mcp.manage", MANAGE, "AdminRoute:mcp", "MCP"),
    "pairing": AdminRoutePolicy("pairing.manage", MANAGE, "AdminRoute:pairing", "Pairing"),
    "channels": AdminRoutePolicy("channels.manage", MANAGE, "AdminRoute:channels", "Channels"),
    "webhooks": AdminRoutePolicy("webhooks.manage", MANAGE, "AdminRoute:webhooks", "Webhooks"),
    "employees": AdminRoutePolicy("employees.manage", MANAGE, "AdminRoute:employees", "Employees"),
    "connectors": AdminRoutePolicy("connectors.manage", MANAGE, "AdminRoute:connectors", "Connectors"),
    "integrations": AdminRoutePolicy(
        "integrations.read",
        READ,
        "AdminRoute:integrations",
        "Plugins",
        admin_only=False,
    ),
    "config": AdminRoutePolicy("config.manage", MANAGE, "AdminRoute:config", "Config"),
    "env": AdminRoutePolicy("env.manage", MANAGE, "AdminRoute:env", "Keys"),
    "system": AdminRoutePolicy("system.manage", MANAGE, "AdminRoute:system", "System"),
    "policy": AdminRoutePolicy("policy.manage", MANAGE, "AdminRoute:policy", "Policy"),
}

NAV_PATH_CAPABILITIES: dict[str, str] = {
    "/sessions": "sessions.read",
    "/logs": "logs.read",
    "/cron": "cron.manage",
    "/skills": "skills.manage",
    "/plugins": "plugins.manage",
    "/mcp": "mcp.manage",
    "/pairing": "pairing.manage",
    "/channels": "channels.manage",
    "/webhooks": "webhooks.manage",
    "/employees": "employees.manage",
    "/team": "employees.manage",
    "/connectors": "connectors.manage",
    "/config": "config.manage",
    "/env": "env.manage",
    "/system": "system.manage",
    "/policy": "policy.manage",
}


def route_policy_for_path(path: str, method: str = "GET") -> AdminRoutePolicy | None:
    clean = "/" + str(path or "").strip().lstrip("/")
    method = str(method or "GET").upper()
    if "/oauth/callback" in clean and clean.startswith("/api/company/integration-plugins/"):
        return None
    if clean.startswith("/api/company/team-members"):
        return ADMIN_ROUTE_POLICIES["employees"]
    if clean.startswith("/api/company/integration-plugins"):
        return ADMIN_ROUTE_POLICIES["integrations"]
    if clean.startswith("/api/company/connectors"):
        return ADMIN_ROUTE_POLICIES["connectors"]
    if clean.startswith("/api/config/raw") or clean.startswith("/api/config"):
        return ADMIN_ROUTE_POLICIES["config"]
    if clean.startswith("/api/env") or clean.startswith("/api/providers/validate"):
        return ADMIN_ROUTE_POLICIES["env"]
    if clean.startswith("/api/mcp"):
        return ADMIN_ROUTE_POLICIES["mcp"]
    if clean.startswith("/api/pairing"):
        return ADMIN_ROUTE_POLICIES["pairing"]
    if clean.startswith("/api/messaging"):
        return ADMIN_ROUTE_POLICIES["channels"]
    if clean.startswith("/api/webhooks"):
        return ADMIN_ROUTE_POLICIES["webhooks"]
    if clean.startswith("/api/gateway"):
        return ADMIN_ROUTE_POLICIES["system"]
    if clean.startswith("/api/credentials/pool"):
        return ADMIN_ROUTE_POLICIES["env"]
    if clean.startswith("/api/ops") or clean.startswith("/api/system"):
        return ADMIN_ROUTE_POLICIES["system"]
    if clean.startswith("/api/skills") or clean.startswith("/api/tools"):
        return ADMIN_ROUTE_POLICIES["skills"]
    if clean.startswith("/api/dashboard/agent-plugins") or clean.startswith("/api/dashboard/plugin"):
        return ADMIN_ROUTE_POLICIES["plugins"]
    if clean.startswith("/api/logs"):
        return ADMIN_ROUTE_POLICIES["logs"]
    if clean.startswith("/api/cron"):
        return ADMIN_ROUTE_POLICIES["cron"]
    if clean.startswith("/api/policy/audit") or clean.startswith("/api/policy/bindings") or clean.startswith("/api/policy/catalog"):
        return ADMIN_ROUTE_POLICIES["policy"]
    if clean.startswith("/api/sessions"):
        if method in {"GET", "HEAD"}:
            return ADMIN_ROUTE_POLICIES["sessions"]
        return AdminRoutePolicy("sessions.manage", MANAGE, "AdminRoute:sessions", "Sessions")
    return None


def capability_keys() -> Iterable[str]:
    yielded = set()
    for policy in ADMIN_ROUTE_POLICIES.values():
        if policy.capability not in yielded:
            yielded.add(policy.capability)
            yield policy.capability
    yield "sessions.manage"
