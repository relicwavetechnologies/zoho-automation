"""Typed policy request/response models for Hermes enterprise authorization."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping


ALLOW = "allow"
DENY = "deny"
NEEDS_APPROVAL = "needs_approval"


@dataclass(frozen=True)
class PolicyPrincipal:
    company_id: str = ""
    company_user_id: str = ""
    role: str = ""
    department_id: str = ""
    status: str = "active"
    email: str = ""

    @classmethod
    def from_identity(cls, identity: Mapping[str, Any] | None) -> "PolicyPrincipal":
        source = dict(identity or {})
        return cls(
            company_id=_text(source.get("company_id") or source.get("companyId")),
            company_user_id=_text(source.get("company_user_id") or source.get("companyUserId") or source.get("id")),
            role=_text(source.get("company_role") or source.get("role")).upper(),
            department_id=_text(source.get("department_id") or source.get("departmentId")).lower(),
            status=(_text(source.get("status")) or "active").lower(),
            email=_text(source.get("email")).lower(),
        )

    @property
    def is_complete(self) -> bool:
        return bool(self.company_id and self.company_user_id and self.role)


@dataclass(frozen=True)
class PolicyResource:
    type: str
    id: str
    company_id: str = ""
    department_id: str = ""
    risk_class: str = "normal"
    attributes: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PolicyContext:
    channel: str = ""
    session_id: str = ""
    phase: str = ""
    request_id: str = ""
    approval_grant_id: str = ""
    attributes: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PolicyDecision:
    decision: str
    allowed: bool
    reason: str = ""
    code: str = ""
    needs_approval: bool = False
    policy_mode: str = "shadow"
    shadow_decision: str = ""
    resource_key: str = ""
    action: str = ""

    @classmethod
    def allow(cls, **kwargs: Any) -> "PolicyDecision":
        return cls(decision=ALLOW, allowed=True, **kwargs)

    @classmethod
    def deny(cls, *, reason: str, code: str, **kwargs: Any) -> "PolicyDecision":
        return cls(decision=DENY, allowed=False, reason=reason, code=code, **kwargs)

    @classmethod
    def approval(cls, *, reason: str, code: str = "approval_required", **kwargs: Any) -> "PolicyDecision":
        return cls(
            decision=NEEDS_APPROVAL,
            allowed=False,
            needs_approval=True,
            reason=reason,
            code=code,
            **kwargs,
        )


def _text(value: Any) -> str:
    return str(value or "").strip()
