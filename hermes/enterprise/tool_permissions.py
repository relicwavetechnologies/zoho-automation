"""Company-mode tool permission policy.

Compatibility wrapper for the central enterprise policy layer.  The tool
registry still imports ``check_tool_permission`` from this module, but all
real decisions now flow through ``enterprise.policy``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from enterprise.policy import check_tool_policy


IDENTITY_FIELDS = (
    "company_id",
    "company_user_id",
    "channel_identity_id",
    "company_role",
    "department_id",
    "session_id",
    "session_key",
    "status",
    "email",
)

REQUIRED_COMPANY_IDENTITY_FIELDS = (
    "company_id",
    "company_user_id",
    "channel_identity_id",
)


@dataclass(frozen=True)
class ToolPermissionDecision:
    allowed: bool
    reason: str = ""
    code: str = ""
    needs_approval: bool = False
    policy_mode: str = "shadow"


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
    decision = check_tool_policy(
        tool_name=tool_name,
        toolset=toolset,
        identity=identity,
        phase="dispatch",
    )
    return ToolPermissionDecision(
        allowed=decision.allowed,
        reason=decision.reason,
        code=decision.code,
        needs_approval=decision.needs_approval,
        policy_mode=decision.policy_mode,
    )
