"""Python bridge for the local Cedar evaluator sidecar.

This adapter is local-only.  It never calls AWS Verified Permissions or any
network service.  The sidecar is optional unless a deployment sets both
``HERMES_CEDAR_EVALUATOR_BIN`` and a Cedar policy source.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from typing import Any, Mapping

from .models import PolicyContext, PolicyDecision, PolicyPrincipal, PolicyResource


CEDAR_EVALUATOR_BIN_ENV = "HERMES_CEDAR_EVALUATOR_BIN"
CEDAR_POLICY_TEXT_ENV = "HERMES_CEDAR_POLICY_TEXT"
CEDAR_POLICY_FILE_ENV = "HERMES_CEDAR_POLICY_FILE"
CEDAR_SCHEMA_TEXT_ENV = "HERMES_CEDAR_SCHEMA_TEXT"
CEDAR_SCHEMA_FILE_ENV = "HERMES_CEDAR_SCHEMA_FILE"
CEDAR_TIMEOUT_MS_ENV = "HERMES_CEDAR_EVALUATOR_TIMEOUT_MS"


def local_cedar_configured() -> bool:
    return bool(_evaluator_bin() and _policy_source())


def evaluate_with_local_cedar(
    *,
    principal: PolicyPrincipal,
    action: str,
    resource: PolicyResource,
    context: PolicyContext,
) -> PolicyDecision | None:
    binary = _evaluator_bin()
    policy_source = _policy_source()
    if not binary or not policy_source:
        return None
    payload = build_cedar_payload(
        principal=principal,
        action=action,
        resource=resource,
        context=context,
        policy_source=policy_source,
        schema_source=_schema_source(),
    )
    timeout = max(0.05, _timeout_ms() / 1000.0)
    try:
        completed = subprocess.run(
            [binary],
            input=json.dumps(payload, sort_keys=True, separators=(",", ":")),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return PolicyDecision.deny(
            reason="Local Cedar evaluator timed out",
            code="cedar_evaluator_timeout",
        )
    except OSError as exc:
        return PolicyDecision.deny(
            reason=f"Local Cedar evaluator unavailable: {exc}",
            code="cedar_evaluator_unavailable",
        )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        return PolicyDecision.deny(
            reason=f"Local Cedar evaluator failed: {detail or completed.returncode}",
            code="cedar_evaluator_failed",
        )
    try:
        body = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return PolicyDecision.deny(
            reason="Local Cedar evaluator returned invalid JSON",
            code="cedar_evaluator_bad_json",
        )
    if not isinstance(body, Mapping):
        return PolicyDecision.deny(
            reason="Local Cedar evaluator returned a non-object response",
            code="cedar_evaluator_bad_json",
        )
    if body.get("ok") is False:
        error = body.get("error") if isinstance(body.get("error"), Mapping) else {}
        message = str(error.get("message") or body.get("errors") or "Local Cedar evaluator denied")
        return PolicyDecision.deny(
            reason=message,
            code=str(error.get("code") or "cedar_evaluator_error"),
        )
    if str(body.get("decision") or "").lower() == "allow" and body.get("allowed") is True:
        return PolicyDecision.allow(reason="local cedar allow", code="cedar_allow")
    return PolicyDecision.deny(
        reason="Local Cedar policy denied this request",
        code="cedar_deny",
    )


def build_cedar_payload(
    *,
    principal: PolicyPrincipal,
    action: str,
    resource: PolicyResource,
    context: PolicyContext,
    policy_source: str,
    schema_source: str = "",
) -> dict[str, Any]:
    principal_id = principal.company_user_id or "unknown"
    resource_id = resource.id or "unknown"
    context_attrs = {
        "channel": context.channel,
        "session_id": context.session_id,
        "phase": context.phase,
        "request_id": context.request_id,
        "approval_grant_id": context.approval_grant_id,
        **dict(context.attributes),
    }
    payload: dict[str, Any] = {
        "protocol_version": 1,
        "op": "authorize",
        "request_id": context.request_id,
        "policy_set": {
            "format": "cedar",
            "source": policy_source,
        },
        "request": {
            "principal": {"type": "CompanyUser", "id": principal_id},
            "action": {"type": "Action", "id": str(action or "read")},
            "resource": {"type": resource.type or "Resource", "id": resource_id},
            "context": _drop_empty(context_attrs),
        },
        "entities": [
            {
                "uid": {"type": "CompanyUser", "id": principal_id},
                "attrs": _drop_empty({
                    "company_id": principal.company_id,
                    "company_user_id": principal.company_user_id,
                    "role": principal.role,
                    "department_id": principal.department_id,
                    "status": principal.status,
                    "email": principal.email,
                }),
                "parents": [],
            },
            {
                "uid": {"type": resource.type or "Resource", "id": resource_id},
                "attrs": _drop_empty({
                    "company_id": resource.company_id,
                    "department_id": resource.department_id,
                    "risk_class": resource.risk_class,
                    **dict(resource.attributes),
                }),
                "parents": [],
            },
        ],
    }
    if schema_source.strip():
        payload["schema"] = {"format": "cedar", "source": schema_source}
    return payload


def _evaluator_bin() -> str:
    return str(os.getenv(CEDAR_EVALUATOR_BIN_ENV, "") or "").strip()


def _policy_source() -> str:
    return _source_from_env(CEDAR_POLICY_TEXT_ENV, CEDAR_POLICY_FILE_ENV)


def _schema_source() -> str:
    return _source_from_env(CEDAR_SCHEMA_TEXT_ENV, CEDAR_SCHEMA_FILE_ENV)


def _source_from_env(text_env: str, file_env: str) -> str:
    text = str(os.getenv(text_env, "") or "")
    if text.strip():
        return text
    path = str(os.getenv(file_env, "") or "").strip()
    if not path:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8")
    except Exception:
        return ""


def _timeout_ms() -> int:
    try:
        return int(os.getenv(CEDAR_TIMEOUT_MS_ENV, "250") or "250")
    except ValueError:
        return 250


def _drop_empty(values: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in values.items()
        if value is not None and value != ""
    }
