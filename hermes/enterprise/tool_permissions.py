"""Company-mode tool permission policy.

This module is intentionally small and dependency-light: the central tool
registry calls it before exposing or dispatching tools. Legacy/local mode is
left untouched; company mode fails closed when identity is incomplete.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Mapping


IDENTITY_FIELDS = (
    "company_id",
    "company_user_id",
    "channel_identity_id",
    "company_role",
    "department_id",
    "session_id",
    "session_key",
)

REQUIRED_COMPANY_IDENTITY_FIELDS = (
    "company_id",
    "company_user_id",
    "channel_identity_id",
)

ADMIN_ROLES = {"ADMIN", "OWNER"}
DEFAULT_ADMIN_TOOLS = {"discord_admin", "skill_manage"}
DEFAULT_ADMIN_TOOLSETS = {"discord_admin"}

_POLICY_JSON_ENV = "HERMES_TOOL_PERMISSION_POLICY_JSON"
_ADMIN_TOOLS_ENV = "HERMES_TOOL_ADMIN_TOOLS"
_ADMIN_TOOLSETS_ENV = "HERMES_TOOL_ADMIN_TOOLSETS"


@dataclass(frozen=True)
class ToolPermissionDecision:
    allowed: bool
    reason: str = ""
    code: str = ""


def normalize_role(value: Any) -> str:
    return str(value or "").strip().upper()


def normalize_department(value: Any) -> str:
    return str(value or "").strip().lower()


def normalize_identity(identity: Mapping[str, Any] | None) -> dict[str, str]:
    source = dict(identity or {})
    return {
        field: str(source.get(field) or "").strip()
        for field in IDENTITY_FIELDS
    }


def is_company_mode_identity(identity: Mapping[str, Any] | None) -> bool:
    normalized = normalize_identity(identity)
    return any(normalized.get(field) for field in REQUIRED_COMPANY_IDENTITY_FIELDS)


def check_tool_permission(
    *,
    tool_name: str,
    toolset: str,
    identity: Mapping[str, Any] | None,
) -> ToolPermissionDecision:
    """Return whether *identity* may use the tool.

    Rules:
    - No company identity present means legacy/local mode: allow.
    - Partial company identity means company mode is active but unsafe: deny.
    - Default high-risk management tools require ADMIN/OWNER.
    - Optional JSON policy can restrict roles/departments by tool or toolset.
    """
    normalized = normalize_identity(identity)
    if not is_company_mode_identity(normalized):
        return ToolPermissionDecision(True)

    missing = [
        field
        for field in REQUIRED_COMPANY_IDENTITY_FIELDS
        if not normalized.get(field)
    ]
    if missing:
        return ToolPermissionDecision(
            False,
            reason=(
                "Hermes company identity is incomplete for tool execution: "
                + ", ".join(missing)
            ),
            code="company_identity_required",
        )

    role = normalize_role(normalized.get("company_role")) or "MEMBER"
    department = normalize_department(normalized.get("department_id"))
    tool_name = str(tool_name or "").strip()
    toolset = str(toolset or "").strip()

    admin_tools = _configured_set(_ADMIN_TOOLS_ENV, DEFAULT_ADMIN_TOOLS)
    admin_toolsets = _configured_set(_ADMIN_TOOLSETS_ENV, DEFAULT_ADMIN_TOOLSETS)
    if tool_name in admin_tools or toolset in admin_toolsets:
        if role not in ADMIN_ROLES:
            return ToolPermissionDecision(
                False,
                reason=f"Tool {tool_name} requires ADMIN role in company mode",
                code="admin_required",
            )

    policy = _load_policy()
    scoped_rule = _matching_rule(policy, tool_name=tool_name, toolset=toolset)
    if scoped_rule:
        decision = _check_rule(
            scoped_rule,
            tool_name=tool_name,
            role=role,
            department=department,
        )
        if not decision.allowed:
            return decision

    return ToolPermissionDecision(True)


def _configured_set(env_name: str, default: set[str]) -> set[str]:
    raw = os.getenv(env_name, "")
    if not raw.strip():
        return set(default)
    return {part.strip() for part in raw.split(",") if part.strip()}


def _load_policy() -> Mapping[str, Any]:
    raw = os.getenv(_POLICY_JSON_ENV, "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, Mapping) else {}


def _matching_rule(
    policy: Mapping[str, Any],
    *,
    tool_name: str,
    toolset: str,
) -> Mapping[str, Any] | None:
    tools = policy.get("tools")
    if isinstance(tools, Mapping):
        rule = tools.get(tool_name)
        if isinstance(rule, Mapping):
            return rule
    toolsets = policy.get("toolsets")
    if isinstance(toolsets, Mapping):
        rule = toolsets.get(toolset)
        if isinstance(rule, Mapping):
            return rule
    return None


def _check_rule(
    rule: Mapping[str, Any],
    *,
    tool_name: str,
    role: str,
    department: str,
) -> ToolPermissionDecision:
    roles = _rule_values(rule.get("roles"), upper=True)
    if roles and role not in roles:
        return ToolPermissionDecision(
            False,
            reason=f"Tool {tool_name} is not allowed for role {role or 'UNKNOWN'}",
            code="role_not_allowed",
        )
    departments = _rule_values(rule.get("departments"), upper=False)
    if departments and department not in departments:
        return ToolPermissionDecision(
            False,
            reason=(
                f"Tool {tool_name} is not allowed for department "
                f"{department or 'UNKNOWN'}"
            ),
            code="department_not_allowed",
        )
    return ToolPermissionDecision(True)


def _rule_values(value: Any, *, upper: bool) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, str):
        raw_items = [value]
    elif isinstance(value, (list, tuple, set)):
        raw_items = list(value)
    else:
        return set()
    items = {str(item or "").strip() for item in raw_items}
    if upper:
        return {item.upper() for item in items if item}
    return {item.lower() for item in items if item}
