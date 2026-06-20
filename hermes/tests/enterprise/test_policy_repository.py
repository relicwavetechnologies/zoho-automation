from __future__ import annotations

from enterprise.policy.models import PolicyPrincipal, PolicyResource
from enterprise.policy.repository import PolicyRepository, matching_policy_bindings


def test_policy_repository_json_round_trip(tmp_path):
    repo = PolicyRepository(store_path=tmp_path / "policy_store.json")

    binding = repo.put_binding(
        company_id="comp_1",
        binding={
            "principal_type": "role",
            "principal_id": "company_admin",
            "resource_type": "Tool",
            "resource_id": "zoho_books",
            "action": "read",
            "effect": "forbid",
        },
    )

    rows = repo.list_bindings(company_id="comp_1")
    assert rows == [binding]
    assert rows[0].principal_id == "COMPANY_ADMIN"
    assert rows[0].effect == "forbid"

    assert repo.delete_binding(company_id="comp_1", binding_id=binding.id) is True
    assert repo.list_bindings(company_id="comp_1") == []


def test_matching_policy_bindings_respects_department_and_resource(tmp_path):
    repo = PolicyRepository(store_path=tmp_path / "policy_store.json")
    binding = repo.put_binding(
        company_id="comp_1",
        binding={
            "principal_type": "department",
            "principal_id": "Finance",
            "resource_type": "Tool",
            "resource_id": "safe_tool",
            "action": "*",
            "effect": "permit",
        },
    )
    principal = PolicyPrincipal(
        company_id="comp_1",
        company_user_id="cu_1",
        role="MEMBER",
        department_id="finance",
    )

    matches = matching_policy_bindings(
        principal=principal,
        action="read",
        resource=PolicyResource(type="Tool", id="safe_tool", company_id="comp_1"),
        bindings=[binding],
    )

    assert [match.id for match in matches] == [binding.id]


def test_matching_policy_bindings_rejects_cross_company(tmp_path):
    repo = PolicyRepository(store_path=tmp_path / "policy_store.json")
    binding = repo.put_binding(
        company_id="comp_2",
        binding={
            "principal_type": "role",
            "principal_id": "MEMBER",
            "resource_type": "Tool",
            "resource_id": "*",
            "action": "*",
            "effect": "permit",
        },
    )
    principal = PolicyPrincipal(
        company_id="comp_1",
        company_user_id="cu_1",
        role="MEMBER",
    )

    matches = matching_policy_bindings(
        principal=principal,
        action="read",
        resource=PolicyResource(type="Tool", id="safe_tool", company_id="comp_1"),
        bindings=[binding],
    )

    assert matches == []
