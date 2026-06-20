"""Route coverage for Divo Follow Ups desktop bridge APIs."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

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


class _FakeStore:
    def ensure_default_company(self) -> str:
        return "company_test"


class _FakeEvent:
    event_type = "created"
    payload_json = {
        "title": "Prepare Q2 renewal notes",
        "due_date": "2026-06-18",
        "notes": "Use CRM context",
        "lark_task_url": "https://larksuite.example/task/t1",
    }


class _FakeFollowUpRepository:
    def __init__(self, row):
        self.row = row
        self.list_for_user_calls: list[tuple[str, str]] = []

    def list_for_user(self, company_id: str, company_user_id: str):
        self.list_for_user_calls.append((company_id, company_user_id))
        return [self.row]

    def get_follow_up(self, company_id: str, follow_up_id: str):
        if company_id == self.row.company_id and follow_up_id == self.row.id:
            return self.row
        return None

    def list_events(self, company_id: str, follow_up_id: str):
        if company_id == self.row.company_id and follow_up_id == self.row.id:
            return [_FakeEvent()]
        return []


class _FakeFollowUpService:
    def __init__(self, repo):
        self._repository = repo
        self.create_request = None
        self.start_request = None
        self.pause_request = None
        self.update_doc_request = None
        self.complete_request = None

    def create_follow_up(self, request):
        from enterprise.follow_ups.service import (
            CreatedLarkTask,
            CreateFollowUpResult,
            ResolvedFollowUpUser,
        )

        self.create_request = request
        return CreateFollowUpResult(
            follow_up=self._repository.row,
            lark_task=CreatedLarkTask(
                task_guid=self._repository.row.lark_task_guid,
                title="Prepare Q2 renewal notes",
                url="https://larksuite.example/task/t1",
            ),
            delegator=ResolvedFollowUpUser(
                company_user_id="user_manager",
                lark_open_id="ou_manager",
                display_name="Vira",
            ),
            assignee=ResolvedFollowUpUser(
                company_user_id="user_assignee",
                lark_open_id="ou_assignee",
                display_name="Rahul",
            ),
        )

    def start_follow_up(self, request):
        from enterprise.follow_ups.service import CreatedTrackingDoc, StartFollowUpResult

        self.start_request = request
        self._repository.row = replace(
            self._repository.row,
            status="active",
            active_session_id=request.active_session_id,
            tracking_doc_token="doc_token_1",
            tracking_doc_url="https://larksuite.example/doc/doc_token_1",
        )
        return StartFollowUpResult(
            follow_up=self._repository.row,
            tracking_doc=CreatedTrackingDoc(
                doc_token="doc_token_1",
                title="Divo Follow Up - Prepare Q2 renewal notes",
                url="https://larksuite.example/doc/doc_token_1",
            ),
            manager_message_id="msg_start",
        )

    def pause_follow_up(self, request):
        from enterprise.follow_ups.service import LifecycleFollowUpResult

        self.pause_request = request
        self._repository.row = replace(self._repository.row, status="paused")
        return LifecycleFollowUpResult(follow_up=self._repository.row, manager_message_id="msg_pause")

    def update_tracking_doc_checkpoint(self, request):
        from enterprise.follow_ups.service import LifecycleFollowUpResult

        self.update_doc_request = request
        self._repository.row = replace(self._repository.row, last_doc_append_at="doc-appended")
        return LifecycleFollowUpResult(follow_up=self._repository.row)

    def complete_follow_up(self, request):
        from enterprise.follow_ups.service import LifecycleFollowUpResult

        self.complete_request = request
        self._repository.row = replace(self._repository.row, status="done", summary=request.summary)
        return LifecycleFollowUpResult(follow_up=self._repository.row, manager_message_id="msg_done")


def _follow_up_row(**overrides: Any):
    from enterprise.follow_ups.models import DEFAULT_FOLLOW_UP_POLICY, DivoFollowUp

    values = {
        "id": "fu_1",
        "company_id": "company_test",
        "lark_task_guid": "task_1",
        "delegator_company_user_id": "user_manager",
        "assignee_company_user_id": "user_assignee",
        "source_session_id": "session_source",
        "active_session_id": None,
        "tracking_doc_token": None,
        "tracking_doc_url": None,
        "status": "assigned",
        "follow_up_policy_json": DEFAULT_FOLLOW_UP_POLICY,
        "started_at": None,
        "paused_at": None,
        "completed_at": None,
        "summary": None,
        "last_doc_append_at": None,
        "created_at": "2026-06-17T10:00:00Z",
        "updated_at": "2026-06-17T10:00:00Z",
    }
    values.update(overrides)
    return DivoFollowUp(**values)


def _install_follow_up_route_fakes(monkeypatch, *, repo=None, service=None, actor_id="user_assignee"):
    monkeypatch.setattr("gateway.company_identity.get_identity_store", lambda: _FakeStore())

    def actor_for_request(request, store):
        return "company_test", {
            "id": request.headers.get("X-Test-Actor-Id", actor_id),
            "company_id": "company_test",
            "role": "MEMBER",
            "department_id": "",
            "status": "active",
            "email": "actor@example.com",
            "display_name": "Actor",
        }

    monkeypatch.setattr("hermes_cli.web_server._policy_actor_for_request", actor_for_request)
    monkeypatch.setattr(
        "hermes_cli.web_server._follow_up_user_name",
        lambda company_id, company_user_id, store: {
            "user_manager": "Vira",
            "user_assignee": "Rahul",
            "user_other": "Other",
        }.get(company_user_id, company_user_id),
    )
    if repo is not None:
        monkeypatch.setattr("hermes_cli.web_server._get_follow_up_repository", lambda: repo)
    if service is not None:
        monkeypatch.setattr("hermes_cli.web_server._get_follow_up_service", lambda: service)
    monkeypatch.setattr("hermes_cli.web_server._list_current_user_lark_open_tasks", lambda **kwargs: [])


def test_follow_ups_list_scopes_to_current_employee(_isolate_hermes_home, monkeypatch):
    row = _follow_up_row()
    repo = _FakeFollowUpRepository(row)
    _install_follow_up_route_fakes(monkeypatch, repo=repo)

    app, client, prev_required = _policy_client()
    try:
        response = client.get("/api/company/follow-ups")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    body = response.json()
    assert repo.list_for_user_calls == [("company_test", "user_assignee")]
    assert body["tasks"][0]["id"] == "fu_1"
    assert body["tasks"][0]["title"] == "Prepare Q2 renewal notes"
    assert body["tasks"][0]["assignedByName"] == "Vira"
    assert body["tasks"][0]["assigneeName"] == "Rahul"
    assert body["tasks"][0]["delegatedTag"] == "Divo Follow Up"
    assert body["tasks"][0]["lifecycleActions"] == {
        "isFollowUp": True,
        "canStart": True,
        "canPause": False,
        "canUpdateDoc": False,
        "canComplete": False,
        "canReassign": False,
        "canOpenTrackingDoc": False,
        "requiresCompletionSummary": True,
    }


def test_follow_ups_list_merges_lark_open_tasks_with_follow_up_metadata(_isolate_hermes_home, monkeypatch):
    row = _follow_up_row(lark_task_guid="task_follow_up")
    repo = _FakeFollowUpRepository(row)
    _install_follow_up_route_fakes(monkeypatch, repo=repo)

    monkeypatch.setattr(
        "hermes_cli.web_server._list_current_user_lark_open_tasks",
        lambda **kwargs: [
            {
                "taskId": "task_plain",
                "title": "Plain Lark task",
                "dueDate": "2026-06-19T00:00:00Z",
            },
            {
                "taskId": "task_follow_up",
                "title": "Raw Lark title should be replaced",
                "dueDate": "2026-06-18T00:00:00Z",
            },
        ],
    )

    app, client, prev_required = _policy_client()
    try:
        response = client.get("/api/company/follow-ups")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    tasks = response.json()["tasks"]
    assert [task["id"] for task in tasks] == ["lark:task_plain", "fu_1"]
    assert tasks[0]["title"] == "Plain Lark task"
    assert tasks[0]["delegatedTag"] is None
    assert tasks[0]["larkTaskGuid"] == "task_plain"
    assert tasks[0]["lifecycleActions"] == {
        "isFollowUp": False,
        "canStart": False,
        "canPause": False,
        "canUpdateDoc": False,
        "canComplete": False,
        "canReassign": False,
        "canOpenTrackingDoc": False,
        "requiresCompletionSummary": False,
    }
    assert tasks[1]["title"] == "Prepare Q2 renewal notes"
    assert tasks[1]["delegatedTag"] == "Divo Follow Up"


def test_follow_up_create_maps_desktop_payload_to_service(_isolate_hermes_home, monkeypatch):
    repo = _FakeFollowUpRepository(_follow_up_row())
    service = _FakeFollowUpService(repo)
    _install_follow_up_route_fakes(monkeypatch, service=service, actor_id="user_manager")

    app, client, prev_required = _policy_client()
    try:
        response = client.post(
            "/api/company/follow-ups",
            json={
                "title": "Prepare Q2 renewal notes",
                "assigneeId": "user_assignee",
                "dueDate": "2026-06-18",
                "notes": "Use CRM context",
                "policyPreset": "start_done",
                "sourceSessionId": "session_source",
            },
        )
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    assert response.json()["followUp"]["id"] == "fu_1"
    assert service.create_request.company_id == "company_test"
    assert service.create_request.delegator_company_user_id == "user_manager"
    assert service.create_request.assignee_company_user_id == "user_assignee"
    assert service.create_request.follow_up_policy_json["notify_on_start"] is True
    assert service.create_request.follow_up_policy_json["notify_on_pause"] is False
    assert service.create_request.follow_up_policy_json["notify_on_done"] is True


def test_follow_up_detail_hides_unrelated_follow_up(_isolate_hermes_home, monkeypatch):
    repo = _FakeFollowUpRepository(_follow_up_row())
    _install_follow_up_route_fakes(monkeypatch, repo=repo, actor_id="user_other")

    app, client, prev_required = _policy_client()
    try:
        response = client.get("/api/company/follow-ups/fu_1")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 404


def test_follow_up_detail_returns_lifecycle_action_affordances(_isolate_hermes_home, monkeypatch):
    active = _follow_up_row(
        status="active",
        tracking_doc_token="doc_token_1",
        tracking_doc_url="https://larksuite.example/doc/doc_token_1",
    )
    repo = _FakeFollowUpRepository(active)
    _install_follow_up_route_fakes(monkeypatch, repo=repo)

    app, client, prev_required = _policy_client()
    try:
        assignee_response = client.get("/api/company/follow-ups/fu_1")
        manager_response = client.get(
            "/api/company/follow-ups/fu_1",
            headers={"X-Test-Actor-Id": "user_manager"},
        )
    finally:
        app.state.auth_required = prev_required

    assert assignee_response.status_code == 200
    assert manager_response.status_code == 200
    assert assignee_response.json()["followUp"]["lifecycleActions"] == {
        "isFollowUp": True,
        "canStart": False,
        "canPause": True,
        "canUpdateDoc": True,
        "canComplete": True,
        "canReassign": False,
        "canOpenTrackingDoc": True,
        "requiresCompletionSummary": True,
    }
    assert manager_response.json()["followUp"]["lifecycleActions"] == {
        "isFollowUp": True,
        "canStart": False,
        "canPause": False,
        "canUpdateDoc": False,
        "canComplete": False,
        "canReassign": True,
        "canOpenTrackingDoc": True,
        "requiresCompletionSummary": True,
    }


def test_follow_up_detail_allows_paused_assignee_to_start_again(_isolate_hermes_home, monkeypatch):
    paused = _follow_up_row(
        status="paused",
        tracking_doc_token="doc_token_1",
        tracking_doc_url="https://larksuite.example/doc/doc_token_1",
    )
    repo = _FakeFollowUpRepository(paused)
    _install_follow_up_route_fakes(monkeypatch, repo=repo)

    app, client, prev_required = _policy_client()
    try:
        response = client.get("/api/company/follow-ups/fu_1")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    assert response.json()["followUp"]["lifecycleActions"] == {
        "isFollowUp": True,
        "canStart": True,
        "canPause": False,
        "canUpdateDoc": False,
        "canComplete": False,
        "canReassign": False,
        "canOpenTrackingDoc": True,
        "requiresCompletionSummary": True,
    }


def test_follow_up_lifecycle_routes_map_actor_and_payloads(_isolate_hermes_home, monkeypatch):
    repo = _FakeFollowUpRepository(_follow_up_row())
    service = _FakeFollowUpService(repo)
    _install_follow_up_route_fakes(monkeypatch, service=service)

    app, client, prev_required = _policy_client()
    try:
        started = client.post(
            "/api/company/follow-ups/fu_1/start-intent",
            json={"activeSessionId": "session_active"},
        )
        updated_doc = client.post(
            "/api/company/follow-ups/fu_1/update-doc",
            json={"note": "Drafted the first pass."},
        )
        paused = client.post(
            "/api/company/follow-ups/fu_1/pause",
            json={"reason": "Waiting on finance"},
        )
        done = client.post(
            "/api/company/follow-ups/fu_1/complete",
            json={"summary": "Finished the renewal notes and linked the doc."},
        )
    finally:
        app.state.auth_required = prev_required

    assert started.status_code == 200
    assert paused.status_code == 200
    assert updated_doc.status_code == 200
    assert done.status_code == 200

    assert started.json()["followUp"]["status"] == "active"
    assert updated_doc.json()["followUp"]["status"] == "active"
    assert paused.json()["followUp"]["status"] == "paused"
    assert done.json()["followUp"]["status"] == "done"

    assert service.start_request.actor_company_user_id == "user_assignee"
    assert service.start_request.active_session_id == "session_active"
    assert service.pause_request.reason == "Waiting on finance"
    assert service.update_doc_request.note == "Drafted the first pass."
    assert service.complete_request.summary == "Finished the renewal notes and linked the doc."
