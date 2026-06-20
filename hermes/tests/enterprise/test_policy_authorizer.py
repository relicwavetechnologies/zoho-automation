from __future__ import annotations

from enterprise.policy import authorize, bootstrap_super_admin_actor, build_capabilities, check_tool_policy
from enterprise.policy.models import PolicyPrincipal, PolicyResource
from enterprise.policy.repository import get_policy_repository


def _principal(**overrides):
    base = {
        "company_id": "comp_1",
        "company_user_id": "cu_1",
        "company_role": "MEMBER",
        "department_id": "finance",
        "status": "active",
        "email": "user@example.com",
    }
    base.update(overrides)
    return base


def test_policy_requires_complete_company_identity(monkeypatch):
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")

    decision = authorize(
        principal={"company_id": "comp_1"},
        action="manage",
        resource=PolicyResource(type="AdminRoute", id="config", company_id="comp_1", risk_class="admin"),
    )

    assert decision.allowed is False
    assert decision.code == "company_identity_required"


def test_super_admin_can_manage_every_admin_route(monkeypatch):
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")

    caps = build_capabilities(_principal(company_role="SUPER_ADMIN"))

    assert caps["config.manage"] is True
    assert caps["policy.manage"] is True
    assert caps["sessions.read"] is True


def test_member_cannot_manage_admin_route(monkeypatch):
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")

    decision = authorize(
        principal=_principal(company_role="MEMBER"),
        action="manage",
        resource=PolicyResource(type="AdminRoute", id="config", company_id="comp_1", risk_class="admin"),
    )

    assert decision.allowed is False
    assert decision.code == "admin_required"


def test_company_admin_cannot_manage_policy(monkeypatch):
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")

    decision = authorize(
        principal=_principal(company_role="COMPANY_ADMIN"),
        action="manage",
        resource=PolicyResource(
            type="AdminRoute",
            id="policy",
            company_id="comp_1",
            risk_class="admin",
            attributes={"capability": "policy.manage"},
        ),
    )

    assert decision.allowed is False
    assert decision.code == "super_admin_required"


def test_policy_binding_forbid_overrides_default_session_read(_isolate_hermes_home, monkeypatch):
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")
    repo = get_policy_repository()
    repo.put_binding(
        company_id="comp_1",
        binding={
            "principal_type": "role",
            "principal_id": "MEMBER",
            "resource_type": "AdminRoute",
            "resource_id": "sessions",
            "action": "read",
            "effect": "forbid",
        },
    )

    decision = authorize(
        principal=_principal(company_role="MEMBER"),
        action="read",
        resource=PolicyResource(
            type="AdminRoute",
            id="sessions",
            company_id="comp_1",
            attributes={"capability": "sessions.read"},
        ),
    )

    assert decision.allowed is False
    assert decision.code == "policy_binding_forbid"


def test_cross_company_access_denied(monkeypatch):
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")

    decision = authorize(
        principal=_principal(company_id="comp_1", company_role="SUPER_ADMIN"),
        action="manage",
        resource=PolicyResource(type="Connector", id="zoho", company_id="comp_2", risk_class="admin"),
    )

    assert decision.allowed is False
    assert decision.code == "cross_company_denied"


def test_sensitive_tool_requires_admin_role(monkeypatch):
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")

    decision = check_tool_policy(
        tool_name="zoho_books",
        toolset="zoho",
        identity=_principal(company_role="MEMBER", channel_identity_id="ci_1"),
    )

    assert decision.allowed is False
    assert decision.code == "admin_required"


def test_department_binding_grants_sensitive_tool_to_member(_isolate_hermes_home, monkeypatch):
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")
    repo = get_policy_repository()
    repo.put_binding(
        company_id="comp_1",
        binding={
            "principal_type": "department",
            "principal_id": "finance",
            "resource_type": "Tool",
            "resource_id": "zoho_books",
            "action": "execute",
            "effect": "permit",
        },
    )

    decision = check_tool_policy(
        tool_name="zoho_books",
        toolset="zoho",
        identity=_principal(
            company_role="MEMBER",
            department_id="finance",
            channel_identity_id="ci_1",
        ),
    )

    assert decision.allowed is True
    assert decision.code == "policy_binding_permit"


def test_department_binding_grants_connector_read_to_member(_isolate_hermes_home, monkeypatch):
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")
    repo = get_policy_repository()
    repo.put_binding(
        company_id="comp_1",
        binding={
            "principal_type": "department",
            "principal_id": "finance",
            "resource_type": "Connector",
            "resource_id": "zoho",
            "action": "execute",
            "effect": "permit",
        },
    )

    decision = authorize(
        principal=_principal(company_role="MEMBER", department_id="finance"),
        action="read",
        resource=PolicyResource(
            type="Connector",
            id="zoho",
            company_id="comp_1",
            risk_class="sensitive",
        ),
    )

    assert decision.allowed is True
    assert decision.code == "policy_binding_permit"


def test_department_binding_cannot_grant_admin_route_to_member(_isolate_hermes_home, monkeypatch):
    monkeypatch.setenv("HERMES_POLICY_MODE", "enforce")
    repo = get_policy_repository()
    repo.put_binding(
        company_id="comp_1",
        binding={
            "principal_type": "department",
            "principal_id": "finance",
            "resource_type": "AdminRoute",
            "resource_id": "config",
            "action": "manage",
            "effect": "permit",
        },
    )

    decision = authorize(
        principal=_principal(company_role="MEMBER", department_id="finance"),
        action="manage",
        resource=PolicyResource(
            type="AdminRoute",
            id="config",
            company_id="comp_1",
            risk_class="admin",
            attributes={"capability": "config.manage"},
        ),
    )

    assert decision.allowed is False
    assert decision.code == "role_ceiling_denied"


def test_disabled_bootstrap_user_is_not_promoted(monkeypatch):
    monkeypatch.setenv("HERMES_BOOTSTRAP_SUPER_ADMIN_EMAILS", "abhishek@emiactech.com")

    class Store:
        called = False

        def update_company_user(self, **kwargs):
            self.called = True
            return kwargs

    store = Store()
    actor = bootstrap_super_admin_actor(
        {
            "id": "cu_1",
            "company_id": "comp_1",
            "email": "abhishek@emiactech.com",
            "role": "MEMBER",
            "status": "disabled",
        },
        store=store,
        company_id="comp_1",
        source="test",
    )

    assert actor["role"] == "MEMBER"
    assert store.called is False


def test_bootstrap_email_becomes_super_admin(monkeypatch):
    monkeypatch.setenv("HERMES_BOOTSTRAP_SUPER_ADMIN_EMAILS", "abhishek@emiactech.com")

    class Store:
        def update_company_user(self, **kwargs):
            return {
                "id": kwargs["company_user_id"],
                "company_id": kwargs["company_id"],
                "email": "abhishek@emiactech.com",
                "role": kwargs["role"],
                "status": "active",
            }

    actor = bootstrap_super_admin_actor(
        {
            "id": "cu_1",
            "company_id": "comp_1",
            "email": "abhishek@emiactech.com",
            "role": "MEMBER",
            "status": "active",
        },
        store=Store(),
        company_id="comp_1",
        source="test",
    )

    assert actor["role"] == "SUPER_ADMIN"
