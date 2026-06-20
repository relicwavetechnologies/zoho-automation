"""Policy guard for connector credential use.

Tool dispatch already checks tool visibility/execution.  This guard sits at
the credential boundary so cached connector clients and direct runtime calls
cannot use decrypted company credentials in enforce mode without policy allow.
"""

from __future__ import annotations

from typing import Any, Mapping


def connector_identity_from_kwargs(kwargs: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "company_id": str(kwargs.get("company_id") or "").strip(),
        "company_user_id": str(kwargs.get("company_user_id") or "").strip(),
        "company_role": str(kwargs.get("company_role") or kwargs.get("role") or "").strip(),
        "department_id": str(kwargs.get("department_id") or "").strip(),
        "channel_identity_id": str(kwargs.get("channel_identity_id") or "").strip(),
        "status": str(kwargs.get("status") or "active").strip() or "active",
        "email": str(kwargs.get("email") or "").strip(),
    }


def require_connector_access(
    *,
    provider: str,
    company_id: str | None,
    identity: Mapping[str, Any] | None,
) -> None:
    company_id = str(company_id or "").strip()
    if not company_id:
        return
    try:
        from enterprise.policy import authorize, decision_allows_effectively
        from enterprise.policy.models import PolicyContext, PolicyResource
    except Exception:
        return

    source = dict(identity or {})
    source.setdefault("company_id", company_id)
    decision = authorize(
        principal=source,
        action="read",
        resource=PolicyResource(
            type="Connector",
            id=str(provider or "").strip().lower(),
            company_id=company_id,
            risk_class="sensitive",
        ),
        context=PolicyContext(phase="connector_credentials"),
    )
    if not decision_allows_effectively(decision):
        raise PermissionError(decision.reason or "Connector credential access denied")
