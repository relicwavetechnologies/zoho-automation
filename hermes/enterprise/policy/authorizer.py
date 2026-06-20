"""Central Hermes policy authorizer.

This module is intentionally local-only: it does not call AWS Verified
Permissions.  The request/response shape mirrors Cedar's PARC model so a
future local Rust helper using the official ``cedar-policy`` crate can be
plugged in behind the same public functions.
"""

from __future__ import annotations

import json
import os
from typing import Any, Mapping

from .audit import write_policy_audit
from .catalog import (
    ADMIN_ROLES,
    FIRST_CLASS_USER_SCOPED_CONNECTORS,
    FIRST_CLASS_USER_SCOPED_TOOLSETS,
    HIGH_RISK_ADMIN_TOOL_NAMES,
    HIGH_RISK_ADMIN_TOOLSETS,
    KNOWN_COMPANY_ROLES,
    MANAGE,
    SENSITIVE_TOOLSETS,
    SUPER_ADMIN_ROLES,
    AdminRoutePolicy,
    READ,
    capability_keys,
    route_policy_for_path,
)
from .cedar_adapter import evaluate_with_local_cedar
from .models import ALLOW, DENY, NEEDS_APPROVAL, PolicyContext, PolicyDecision, PolicyPrincipal, PolicyResource
from .repository import matching_policy_bindings


POLICY_MODE_ENV = "HERMES_POLICY_MODE"
BOOTSTRAP_SUPER_ADMIN_EMAILS_ENV = "HERMES_BOOTSTRAP_SUPER_ADMIN_EMAILS"
TOOL_POLICY_JSON_ENV = "HERMES_TOOL_PERMISSION_POLICY_JSON"
ADMIN_TOOLS_ENV = "HERMES_TOOL_ADMIN_TOOLS"
ADMIN_TOOLSETS_ENV = "HERMES_TOOL_ADMIN_TOOLSETS"

_REQUIRED_COMPANY_IDENTITY_FIELDS = ("company_id", "company_user_id", "channel_identity_id")


def policy_mode() -> str:
    mode = str(os.getenv(POLICY_MODE_ENV, "shadow") or "shadow").strip().lower()
    if mode not in {"off", "shadow", "enforce"}:
        return "shadow"
    return mode


def is_enforced() -> bool:
    return policy_mode() == "enforce"


def bootstrap_super_admin_emails() -> set[str]:
    raw = os.getenv(BOOTSTRAP_SUPER_ADMIN_EMAILS_ENV, "")
    return {
        part.strip().lower()
        for part in raw.split(",")
        if part.strip()
    }


def is_bootstrap_super_admin_email(email: str | None) -> bool:
    normalized = str(email or "").strip().lower()
    return bool(normalized and normalized in bootstrap_super_admin_emails())


def bootstrap_super_admin_actor(
    row: Mapping[str, Any] | None,
    *,
    store: Any,
    company_id: str,
    source: str,
) -> dict[str, Any] | None:
    if not row:
        return None
    actor = dict(row)
    if not is_bootstrap_super_admin_email(str(actor.get("email") or "")):
        return actor
    if _status(actor) != "active":
        return actor
    if _role(actor) == "SUPER_ADMIN":
        return actor

    company_user_id = str(actor.get("id") or actor.get("company_user_id") or actor.get("companyUserId") or "")
    if not company_user_id:
        return actor
    updater = getattr(store, "update_company_user", None)
    if updater is None:
        return actor
    try:
        updated = updater(
            company_user_id=company_user_id,
            company_id=company_id,
            role="SUPER_ADMIN",
        )
    except TypeError:
        updated = updater(company_user_id=company_user_id, role="SUPER_ADMIN")
    if updated:
        actor = dict(updated)
    else:
        actor["role"] = "SUPER_ADMIN"
    write_policy_audit({
        "event": "bootstrap_super_admin",
        "source": source,
        "company_id": company_id,
        "company_user_id": company_user_id,
        "email": str(actor.get("email") or "").lower(),
        "decision": ALLOW,
        "reason": "bootstrap email matched",
    })
    return actor


def authorize(
    *,
    principal: PolicyPrincipal | Mapping[str, Any] | None,
    action: str,
    resource: PolicyResource,
    context: PolicyContext | None = None,
) -> PolicyDecision:
    mode = policy_mode()
    principal_model = (
        principal
        if isinstance(principal, PolicyPrincipal)
        else PolicyPrincipal.from_identity(principal)
    )
    action = str(action or "").strip() or MANAGE
    context = context or PolicyContext()
    preflight_decision = _preflight_decision(principal_model, resource)
    cedar_decision = None
    if preflight_decision is None:
        cedar_decision = evaluate_with_local_cedar(
            principal=principal_model,
            action=action,
            resource=resource,
            context=context,
        )
        if cedar_decision is not None and cedar_decision.allowed:
            if not _role_ceiling_allows(principal_model, resource):
                cedar_decision = PolicyDecision.deny(
                    reason="Company role ceiling blocks this Cedar decision",
                    code="role_ceiling_denied",
                )
            elif _requires_approval(resource, action, context):
                cedar_decision = PolicyDecision.approval(reason="High-risk action requires approval")
    decision = preflight_decision or cedar_decision or _evaluate(principal_model, action, resource, context)
    decision = PolicyDecision(
        decision=decision.decision,
        allowed=decision.allowed,
        reason=decision.reason,
        code=decision.code,
        needs_approval=decision.needs_approval,
        policy_mode=mode,
        shadow_decision=decision.decision if mode == "shadow" else "",
        resource_key=f"{resource.type}:{resource.id}",
        action=action,
    )
    write_policy_audit({
        "event": "policy_decision",
        "mode": mode,
        "principal": principal_model.company_user_id,
        "company_id": principal_model.company_id,
        "role": principal_model.role,
        "action": action,
        "resource": decision.resource_key,
        "decision": decision.decision,
        "allowed": decision.allowed,
        "code": decision.code,
        "reason": decision.reason,
        "phase": context.phase,
        "request_id": context.request_id,
    })
    return decision


def require_policy(
    *,
    principal: Mapping[str, Any] | PolicyPrincipal | None,
    action: str,
    resource: PolicyResource,
    context: PolicyContext | None = None,
) -> PolicyDecision:
    decision = authorize(
        principal=principal,
        action=action,
        resource=resource,
        context=context,
    )
    if is_enforced() and not decision.allowed:
        try:
            from fastapi import HTTPException

            raise HTTPException(status_code=403, detail=decision.reason or "Access denied")
        except ImportError:
            raise PermissionError(decision.reason or "Access denied")
    return decision


def decision_allows_effectively(decision: PolicyDecision) -> bool:
    return decision.allowed or policy_mode() in {"off", "shadow"}


def company_mode_identity(identity: Mapping[str, Any] | None) -> bool:
    source = dict(identity or {})
    return any(str(source.get(field) or "").strip() for field in _REQUIRED_COMPANY_IDENTITY_FIELDS)


def check_tool_policy(
    *,
    tool_name: str,
    toolset: str,
    identity: Mapping[str, Any] | None,
    phase: str = "dispatch",
    args: Mapping[str, Any] | None = None,
) -> PolicyDecision:
    source = dict(identity or {})
    if not company_mode_identity(source):
        return PolicyDecision.allow(reason="legacy local mode", code="legacy_local_mode", policy_mode=policy_mode())

    missing = [
        field
        for field in _REQUIRED_COMPANY_IDENTITY_FIELDS
        if not str(source.get(field) or "").strip()
    ]
    if missing:
        return PolicyDecision.deny(
            reason="Hermes company identity is incomplete for tool execution: " + ", ".join(missing),
            code="company_identity_required",
            policy_mode=policy_mode(),
        )

    principal = PolicyPrincipal.from_identity(source)

    tool_name = str(tool_name or "").strip()
    toolset = str(toolset or "").strip()
    admin_tools = _configured_set(ADMIN_TOOLS_ENV, set(HIGH_RISK_ADMIN_TOOL_NAMES))
    admin_toolsets = _configured_set(ADMIN_TOOLSETS_ENV, set(HIGH_RISK_ADMIN_TOOLSETS))
    risk_class = "sensitive" if toolset in SENSITIVE_TOOLSETS else "normal"
    if tool_name in admin_tools or toolset in admin_toolsets:
        risk_class = "admin"
    if not principal.role:
        if risk_class == "normal":
            return PolicyDecision.allow(
                reason="non-sensitive tool allowed without role",
                code="non_sensitive_tool",
                policy_mode=policy_mode(),
            )
        return PolicyDecision.deny(
            reason="Hermes company identity is missing a role",
            code="company_role_required",
            policy_mode=policy_mode(),
        )

    env_decision = _decision_from_tool_policy_json(
        tool_name=tool_name,
        toolset=toolset,
        principal=principal,
    )
    if env_decision is not None:
        return env_decision

    resource = PolicyResource(
        type="Tool",
        id=tool_name,
        company_id=principal.company_id,
        risk_class=risk_class,
        attributes={
            "toolset": toolset,
            "args_present": bool(args),
        },
    )
    action = _tool_action_for_name(tool_name, toolset, args)
    return authorize(
        principal=principal,
        action=action,
        resource=resource,
        context=PolicyContext(phase=phase),
    )


def admin_route_decision(
    *,
    path: str,
    method: str,
    principal: Mapping[str, Any] | PolicyPrincipal | None,
) -> PolicyDecision | None:
    route_policy = route_policy_for_path(path, method)
    if route_policy is None:
        return None
    resource = PolicyResource(
        type="AdminRoute",
        id=route_policy.resource.split(":", 1)[-1],
        company_id=_principal_company_id(principal),
        risk_class="admin" if route_policy.admin_only else "normal",
        attributes={"capability": route_policy.capability},
    )
    return authorize(
        principal=principal,
        action=route_policy.action,
        resource=resource,
        context=PolicyContext(phase="admin_route"),
    )


def build_capabilities(principal: Mapping[str, Any] | PolicyPrincipal | None) -> dict[str, bool]:
    result: dict[str, bool] = {}
    for key in capability_keys():
        route = _route_policy_for_capability(key)
        if route is None:
            result[key] = False
            continue
        decision = authorize(
            principal=principal,
            action=route.action,
            resource=PolicyResource(
                type="AdminRoute",
                id=route.resource.split(":", 1)[-1],
                company_id=_principal_company_id(principal),
                risk_class="admin" if route.admin_only else "normal",
                attributes={"capability": route.capability},
            ),
            context=PolicyContext(phase="capability"),
        )
        result[key] = decision.allowed
    return result


def _evaluate(
    principal: PolicyPrincipal,
    action: str,
    resource: PolicyResource,
    context: PolicyContext,
) -> PolicyDecision:
    preflight = _preflight_decision(principal, resource)
    if preflight is not None:
        return preflight
    if principal.role in SUPER_ADMIN_ROLES:
        return PolicyDecision.allow(reason="super admin")

    binding_decision = _decision_from_policy_bindings(
        principal=principal,
        action=action,
        resource=resource,
    )
    if binding_decision is not None:
        return binding_decision

    if resource.type == "AdminRoute":
        capability = str(resource.attributes.get("capability") or "")
        if capability in {"sessions.read", "integrations.read"}:
            return PolicyDecision.allow(reason="authenticated member route read")
        if capability == "policy.manage" or resource.id == "policy":
            return PolicyDecision.deny(
                reason="Super admin role required",
                code="super_admin_required",
            )
        if principal.role in ADMIN_ROLES:
            return PolicyDecision.allow(reason="company admin")
        return PolicyDecision.deny(
            reason="Company admin role required",
            code="admin_required",
        )

    if resource.type == "Tool":
        toolset = str(resource.attributes.get("toolset") or "").strip().lower()
        if toolset in FIRST_CLASS_USER_SCOPED_TOOLSETS and principal.company_user_id:
            if _requires_approval(resource, action, context):
                return PolicyDecision.approval(reason="High-risk tool action requires approval")
            return PolicyDecision.allow(reason=f"user-scoped {toolset} workspace tool")
        if resource.risk_class in {"admin", "sensitive"} and principal.role not in ADMIN_ROLES:
            return PolicyDecision.deny(
                reason=f"Tool {resource.id} requires admin role in company mode",
                code="admin_required",
            )
        if _requires_approval(resource, action, context):
            return PolicyDecision.approval(reason="High-risk tool action requires approval")
        return PolicyDecision.allow(reason="tool allowed")

    if resource.type in {"Connector", "DataScope", "Policy"}:
        if (
            resource.type == "Connector"
            and action == READ
            and str(resource.id or "").strip().lower() in FIRST_CLASS_USER_SCOPED_CONNECTORS
            and principal.company_user_id
        ):
            return PolicyDecision.allow(
                reason=f"user-scoped {str(resource.id or '').strip().lower()} connector read"
            )
        if principal.role in ADMIN_ROLES:
            return PolicyDecision.allow(reason="company admin")
        return PolicyDecision.deny(
            reason="Company admin role required",
            code="admin_required",
        )

    return PolicyDecision.deny(
        reason="No matching permit policy",
        code="implicit_deny",
    )


def _preflight_decision(
    principal: PolicyPrincipal,
    resource: PolicyResource,
) -> PolicyDecision | None:
    if not principal.company_id or not principal.company_user_id:
        return PolicyDecision.deny(
            reason="Company identity is required",
            code="company_identity_required",
        )
    if not principal.role:
        return PolicyDecision.deny(
            reason="Company role is required",
            code="company_role_required",
        )
    if principal.status != "active":
        return PolicyDecision.deny(
            reason="Current employee is disabled",
            code="company_user_disabled",
        )
    if principal.role not in KNOWN_COMPANY_ROLES:
        return PolicyDecision.deny(
            reason=f"Unknown company role {principal.role}",
            code="unknown_company_role",
        )
    if resource.company_id and resource.company_id != principal.company_id:
        return PolicyDecision.deny(
            reason="Cross-company access denied",
            code="cross_company_denied",
        )
    return None


def _decision_from_policy_bindings(
    *,
    principal: PolicyPrincipal,
    action: str,
    resource: PolicyResource,
) -> PolicyDecision | None:
    try:
        bindings = matching_policy_bindings(
            principal=principal,
            action=action,
            resource=resource,
        )
    except Exception:
        bindings = []
    if not bindings:
        return None
    forbid = next((binding for binding in bindings if binding.effect == "forbid"), None)
    if forbid is not None:
        return PolicyDecision.deny(
            reason=f"Denied by policy binding {forbid.id}",
            code="policy_binding_forbid",
        )
    approval = next((binding for binding in bindings if binding.effect == "approval"), None)
    if approval is not None:
        return PolicyDecision.approval(
            reason=f"Approval required by policy binding {approval.id}",
            code="policy_binding_approval",
        )
    permit = next((binding for binding in bindings if binding.effect == "permit"), None)
    if permit is None:
        return None
    if not _role_ceiling_allows(principal, resource):
        return PolicyDecision.deny(
            reason="Company role ceiling blocks this policy binding",
            code="role_ceiling_denied",
        )
    return PolicyDecision.allow(
        reason=f"Allowed by policy binding {permit.id}",
        code="policy_binding_permit",
    )


def _role_ceiling_allows(principal: PolicyPrincipal, resource: PolicyResource) -> bool:
    if resource.type == "AdminRoute":
        capability = str(resource.attributes.get("capability") or "")
        if capability in {"sessions.read", "integrations.read"}:
            return True
        if capability == "policy.manage" or resource.id == "policy":
            return principal.role in SUPER_ADMIN_ROLES
        return principal.role in ADMIN_ROLES
    if resource.type == "Policy":
        return principal.role in ADMIN_ROLES
    if resource.type in {"Connector", "DataScope"}:
        return True
    if resource.type == "Tool" and resource.risk_class == "admin":
        return principal.role in ADMIN_ROLES
    return True


def _decision_from_tool_policy_json(
    *,
    tool_name: str,
    toolset: str,
    principal: PolicyPrincipal,
) -> PolicyDecision | None:
    raw = os.getenv(TOOL_POLICY_JSON_ENV, "").strip()
    if not raw:
        return None
    try:
        policy = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(policy, Mapping):
        return None
    rule: Mapping[str, Any] | None = None
    tools = policy.get("tools")
    if isinstance(tools, Mapping) and isinstance(tools.get(tool_name), Mapping):
        rule = tools.get(tool_name)
    toolsets = policy.get("toolsets")
    if rule is None and isinstance(toolsets, Mapping) and isinstance(toolsets.get(toolset), Mapping):
        rule = toolsets.get(toolset)
    if rule is None:
        return None
    roles = _rule_values(rule.get("roles"), upper=True)
    if roles and principal.role not in roles:
        return PolicyDecision.deny(
            reason=f"Tool {tool_name} is not allowed for role {principal.role or 'UNKNOWN'}",
            code="role_not_allowed",
            policy_mode=policy_mode(),
        )
    departments = _rule_values(rule.get("departments"), upper=False)
    if departments and principal.department_id not in departments:
        return PolicyDecision.deny(
            reason=f"Tool {tool_name} is not allowed for department {principal.department_id or 'unknown'}",
            code="department_not_allowed",
            policy_mode=policy_mode(),
        )
    return PolicyDecision.allow(reason="env tool policy", code="env_tool_policy", policy_mode=policy_mode())


def _tool_action_for_name(tool_name: str, toolset: str, args: Mapping[str, Any] | None) -> str:
    name = f"{toolset}.{tool_name}".lower()
    if any(token in name for token in ("delete", "remove", "revoke", "disable")):
        return "delete"
    if any(token in name for token in ("send", "email", "message", "notify")):
        return "send"
    if any(token in name for token in ("create", "add", "insert", "upsert")):
        return "create"
    if any(token in name for token in ("update", "patch", "set", "edit", "manage")):
        return "update"
    if any(token in name for token in ("execute", "run", "terminal")):
        return "execute"
    return "read"


def _requires_approval(resource: PolicyResource, action: str, context: PolicyContext) -> bool:
    if context.approval_grant_id:
        return False
    return resource.risk_class == "critical" and action in {"delete", "send", "execute", "update"}


def _configured_set(env_name: str, default: set[str]) -> set[str]:
    raw = os.getenv(env_name, "")
    if not raw.strip():
        return set(default)
    return {part.strip() for part in raw.split(",") if part.strip()}


def _rule_values(value: Any, *, upper: bool) -> set[str]:
    if not isinstance(value, (list, tuple, set)):
        return set()
    result = {str(item or "").strip() for item in value if str(item or "").strip()}
    return {item.upper() for item in result} if upper else {item.lower() for item in result}


def _role(row: Mapping[str, Any]) -> str:
    return str(row.get("role") or row.get("company_role") or "").strip().upper() or "MEMBER"


def _status(row: Mapping[str, Any]) -> str:
    return str(row.get("status") or "active").strip().lower() or "active"


def _principal_company_id(principal: Mapping[str, Any] | PolicyPrincipal | None) -> str:
    if isinstance(principal, PolicyPrincipal):
        return principal.company_id
    source = dict(principal or {})
    return str(source.get("company_id") or source.get("companyId") or "").strip()


def _route_policy_for_capability(capability: str) -> AdminRoutePolicy | None:
    from .catalog import ADMIN_ROUTE_POLICIES

    for route in ADMIN_ROUTE_POLICIES.values():
        if route.capability == capability:
            return route
    if capability == "sessions.manage":
        return AdminRoutePolicy("sessions.manage", MANAGE, "AdminRoute:sessions", "Sessions")
    return None
