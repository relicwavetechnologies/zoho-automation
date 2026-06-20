"""Policy tests for member access to user-scoped Google tools."""

from __future__ import annotations

import pytest

from enterprise.policy import authorize, check_tool_policy
from enterprise.policy.catalog import FIRST_CLASS_USER_SCOPED_TOOLSETS, SENSITIVE_TOOLSETS
from enterprise.policy.models import PolicyContext, PolicyResource
from enterprise.policy.repository import get_policy_repository


def _principal(**overrides):
    base = {
        "company_id": "comp_1",
        "company_user_id": "cu_1",
        "channel_identity_id": "ci_1",
        "company_role": "MEMBER",
        "status": "active",
    }
    base.update(overrides)
    return base


@pytest.fixture
def _isolate_hermes_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")


def test_member_can_execute_gmail_tool(_isolate_hermes_home):
    decision = check_tool_policy(
        tool_name="gmail",
        toolset="google",
        identity=_principal(),
    )
    assert decision.allowed is True


def test_google_workspace_is_first_class_sensitive_user_scoped_toolset(_isolate_hermes_home):
    assert "google" in SENSITIVE_TOOLSETS
    assert "google" in FIRST_CLASS_USER_SCOPED_TOOLSETS


def test_super_admin_can_execute_all_google_workspace_tools(_isolate_hermes_home):
    for tool_name in (
        "gmail",
        "google_calendar",
        "google_drive",
        "google_docs",
        "google_sheets",
        "google_slides",
    ):
        decision = check_tool_policy(
            tool_name=tool_name,
            toolset="google",
            identity=_principal(company_role="SUPER_ADMIN"),
        )
        assert decision.allowed is True, tool_name


def test_member_can_read_google_connector(_isolate_hermes_home):
    decision = authorize(
        principal=_principal(),
        action="read",
        resource=PolicyResource(
            type="Connector",
            id="google",
            company_id="comp_1",
            risk_class="sensitive",
        ),
        context=PolicyContext(phase="connector_credentials"),
    )
    assert decision.allowed is True
