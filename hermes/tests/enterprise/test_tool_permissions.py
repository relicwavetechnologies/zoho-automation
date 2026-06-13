"""Tests for company-mode tool permission policy."""

from __future__ import annotations

import json

from enterprise.tool_permissions import check_tool_permission


def _identity(**overrides):
    base = {
        "company_id": "comp_1",
        "company_user_id": "user_1",
        "channel_identity_id": "ci_1",
        "company_role": "MEMBER",
        "department_id": "finance",
    }
    base.update(overrides)
    return base


def test_legacy_mode_without_company_identity_allows_tools():
    decision = check_tool_permission(
        tool_name="terminal",
        toolset="terminal",
        identity={},
    )

    assert decision.allowed is True


def test_company_mode_requires_complete_identity():
    decision = check_tool_permission(
        tool_name="gmail",
        toolset="google",
        identity={"company_id": "comp_1"},
    )

    assert decision.allowed is False
    assert decision.code == "company_identity_required"
    assert "company_user_id" in decision.reason
    assert "channel_identity_id" in decision.reason


def test_default_admin_tool_requires_admin_role(monkeypatch):
    monkeypatch.delenv("HERMES_TOOL_ADMIN_TOOLS", raising=False)
    decision = check_tool_permission(
        tool_name="skill_manage",
        toolset="skills",
        identity=_identity(company_role="MEMBER"),
    )

    assert decision.allowed is False
    assert decision.code == "admin_required"


def test_default_admin_tool_allows_admin(monkeypatch):
    monkeypatch.delenv("HERMES_TOOL_ADMIN_TOOLS", raising=False)
    decision = check_tool_permission(
        tool_name="skill_manage",
        toolset="skills",
        identity=_identity(company_role="ADMIN"),
    )

    assert decision.allowed is True


def test_policy_json_restricts_department(monkeypatch):
    monkeypatch.setenv(
        "HERMES_TOOL_PERMISSION_POLICY_JSON",
        json.dumps({
            "toolsets": {
                "zoho": {
                    "roles": ["ADMIN", "MEMBER"],
                    "departments": ["finance"],
                }
            }
        }),
    )

    allowed = check_tool_permission(
        tool_name="zoho_books",
        toolset="zoho",
        identity=_identity(company_role="MEMBER", department_id="finance"),
    )
    denied = check_tool_permission(
        tool_name="zoho_books",
        toolset="zoho",
        identity=_identity(company_role="MEMBER", department_id="sales"),
    )

    assert allowed.allowed is True
    assert denied.allowed is False
    assert denied.code == "department_not_allowed"
