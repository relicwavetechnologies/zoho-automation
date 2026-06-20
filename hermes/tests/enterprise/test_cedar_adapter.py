from __future__ import annotations

import os

from enterprise.policy.cedar_adapter import build_cedar_payload, evaluate_with_local_cedar
from enterprise.policy.models import PolicyContext, PolicyPrincipal, PolicyResource


def test_build_cedar_payload_uses_company_user_id_not_email():
    payload = build_cedar_payload(
        principal=PolicyPrincipal(
            company_id="comp_1",
            company_user_id="cu_1",
            role="SUPER_ADMIN",
            email="abhishek@emiactech.com",
        ),
        action="manage",
        resource=PolicyResource(
            type="AdminRoute",
            id="config",
            company_id="comp_1",
            risk_class="admin",
            attributes={"capability": "config.manage"},
        ),
        context=PolicyContext(phase="admin_route"),
        policy_source='permit(principal, action, resource);',
    )

    assert payload["request"]["principal"] == {"type": "CompanyUser", "id": "cu_1"}
    assert payload["entities"][0]["attrs"]["email"] == "abhishek@emiactech.com"


def test_evaluate_with_local_cedar_uses_json_subprocess_protocol(tmp_path, monkeypatch):
    script = tmp_path / "cedar_fake.py"
    script.write_text(
        "\n".join(
            [
                "#!/usr/bin/env python3",
                "import json, sys",
                "payload = json.load(sys.stdin)",
                "assert payload['protocol_version'] == 1",
                "assert payload['request']['principal']['id'] == 'cu_1'",
                "print(json.dumps({'protocol_version': 1, 'ok': True, 'decision': 'allow', 'allowed': True}))",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | 0o111)
    monkeypatch.setenv("HERMES_CEDAR_EVALUATOR_BIN", str(script))
    monkeypatch.setenv("HERMES_CEDAR_EVALUATOR_TIMEOUT_MS", "2000")
    monkeypatch.setenv("HERMES_CEDAR_POLICY_TEXT", 'permit(principal, action, resource);')

    decision = evaluate_with_local_cedar(
        principal=PolicyPrincipal(company_id="comp_1", company_user_id="cu_1", role="MEMBER"),
        action="read",
        resource=PolicyResource(type="Tool", id="safe_tool", company_id="comp_1"),
        context=PolicyContext(phase="test"),
    )

    assert decision is not None
    assert decision.allowed is True
    assert decision.code == "cedar_allow"


def test_evaluate_with_local_cedar_is_disabled_without_policy(monkeypatch):
    monkeypatch.delenv("HERMES_CEDAR_POLICY_TEXT", raising=False)
    monkeypatch.delenv("HERMES_CEDAR_POLICY_FILE", raising=False)
    monkeypatch.setenv("HERMES_CEDAR_EVALUATOR_BIN", os.devnull)

    decision = evaluate_with_local_cedar(
        principal=PolicyPrincipal(company_id="comp_1", company_user_id="cu_1", role="MEMBER"),
        action="read",
        resource=PolicyResource(type="Tool", id="safe_tool", company_id="comp_1"),
        context=PolicyContext(phase="test"),
    )

    assert decision is None
