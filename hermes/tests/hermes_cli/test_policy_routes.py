from __future__ import annotations

import pytest


def _policy_client():
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    prev_required = getattr(app.state, "auth_required", None)
    app.state.auth_required = False
    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return app, client, prev_required


def test_policy_me_returns_local_super_admin(_isolate_hermes_home, monkeypatch):
    app, client, prev_required = _policy_client()

    try:
        response = client.get("/api/policy/me")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    body = response.json()
    assert body["actor"]["role"] == "SUPER_ADMIN"
    assert body["actor"]["is_super_admin"] is True
    assert body["capabilities"]["policy.manage"] is True
    assert body["nav"]["/policy"] is True


def test_policy_binding_crud_for_local_super_admin(_isolate_hermes_home, monkeypatch):
    app, client, prev_required = _policy_client()

    try:
        created = client.post(
            "/api/policy/bindings",
            json={
                "principal_type": "role",
                "principal_id": "MEMBER",
                "resource_type": "Tool",
                "resource_id": "safe_tool",
                "action": "read",
                "effect": "permit",
            },
        )
        listed = client.get("/api/policy/bindings")
    finally:
        app.state.auth_required = prev_required

    assert created.status_code == 200
    binding = created.json()["binding"]
    assert binding["principal_id"] == "MEMBER"
    assert listed.status_code == 200
    assert [row["id"] for row in listed.json()["bindings"]] == [binding["id"]]

    app, client, prev_required = _policy_client()
    try:
        deleted = client.delete(f"/api/policy/bindings/{binding['id']}")
        listed_again = client.get("/api/policy/bindings")
    finally:
        app.state.auth_required = prev_required

    assert deleted.status_code == 200
    assert listed_again.json()["bindings"] == []
