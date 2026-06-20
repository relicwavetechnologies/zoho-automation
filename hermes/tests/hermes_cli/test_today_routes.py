"""Route coverage for the Lark today panel aggregator."""

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


class _FakeFollowUpRow:
    company_id = "company_test"
    id = "fu-1"
    lark_task_guid = "task_guid_1"
    delegator_company_user_id = "user_delegator"
    assignee_company_user_id = "user_assignee"
    status = "active"
    tracking_doc_token = "doc_token_1"
    tracking_doc_url = "https://larksuite.example/doc/doc_token_1"
    follow_up_policy_json = {"completion_summary_required": True}


class _FakeFollowUpRepository:
    def __init__(self, row):
        self.row = row

    def list_for_user(self, company_id: str, company_user_id: str):
        return [self.row]

    def list_events(self, company_id: str, follow_up_id: str):
        return []


def _patch_actor(monkeypatch):
    actor = {
        "id": "user_assignee",
        "companyId": "company_test",
        "displayName": "Abhishek Verma",
        "role": "MEMBER",
    }

    monkeypatch.setattr(
        "hermes_cli.web_server._policy_actor_for_request",
        lambda request, store: ("company_test", actor),
    )
    monkeypatch.setattr(
        "hermes_cli.web_server._actor_lark_channel_context",
        lambda company_user_id, *, store: ("ou_test_user", "ci_test_user"),
    )
    return actor


def test_today_route_merges_tasks_and_slices(monkeypatch):
    app, client, prev_required = _policy_client()
    row = _FakeFollowUpRow()
    repo = _FakeFollowUpRepository(row)
    monkeypatch.setattr("hermes_cli.web_server._get_follow_up_repository", lambda: repo)
    _patch_actor(monkeypatch)

    def fake_dispatch(tool_name, args, **kwargs):
        import json

        if tool_name == "lark_task":
            return json.dumps(
                {
                    "success": True,
                    "data": [
                        {
                            "taskId": "task_guid_1",
                            "title": "Merged follow-up task",
                            "dueDate": "2026-06-17T17:00:00Z",
                        },
                        {
                            "taskId": "plain_task",
                            "title": "Plain Lark task",
                            "dueDate": "2026-06-18T17:00:00Z",
                        },
                    ],
                }
            )
        if tool_name == "lark_calendar":
            return json.dumps(
                {
                    "success": True,
                    "data": [
                        {
                            "eventId": "evt_1",
                            "summary": "Product sync",
                            "startTime": "2026-06-17T10:00:00Z",
                            "endTime": "2026-06-17T10:30:00Z",
                            "attendeeCount": 4,
                            "vcUrl": "https://vc.larksuite.com/meet/1",
                            "durationMin": 30,
                        }
                    ],
                }
            )
        if tool_name == "lark_approval":
            return json.dumps(
                {
                    "success": True,
                    "data": [
                        {
                            "instanceCode": "inst_1",
                            "approvalCode": "appr_1",
                            "title": "Zoho renewal",
                            "status": "PENDING",
                        }
                    ],
                }
            )
        if tool_name == "lark_messaging":
            return json.dumps(
                {
                    "success": True,
                    "data": [
                        {
                            "messageId": "msg_1",
                            "chatId": "chat_1",
                            "chatName": "#eng-platform",
                            "senderName": "Aaron",
                            "text": "Can you share Q2 numbers?",
                        }
                    ],
                }
            )
        return json.dumps({"success": True, "data": []})

    monkeypatch.setattr("tools.registry.registry.dispatch", fake_dispatch)

    try:
        response = client.get("/api/company/today")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    payload = response.json()
    assert payload["company_id"] == "company_test"
    assert payload["dateLabel"]
    assert len(payload["tasks"]) == 2
    assert payload["tasks"][0]["id"] == "fu-1"
    assert payload["tasks"][1]["id"] == "lark:plain_task"
    assert len(payload["meetings"]) == 1
    assert payload["meetings"][0]["eventId"] == "evt_1"
    assert len(payload["activeFollowUps"]) == 1
    assert payload["activeFollowUps"][0]["id"] == "fu-1"
    assert len(payload["needsYou"]) == 2
    assert payload["needsYou"][0]["kind"] == "approval"
    assert payload["needsYou"][1]["kind"] == "mention"
    assert len(payload["docs"]) == 1
    assert payload["docs"][0]["docToken"] == "doc_token_1"


def test_today_route_keeps_untitled_meetings(monkeypatch):
    app, client, prev_required = _policy_client()
    row = _FakeFollowUpRow()
    repo = _FakeFollowUpRepository(row)
    monkeypatch.setattr("hermes_cli.web_server._get_follow_up_repository", lambda: repo)
    _patch_actor(monkeypatch)

    def fake_dispatch(tool_name, args, **kwargs):
        import json

        if tool_name == "lark_calendar":
            return json.dumps(
                {
                    "success": True,
                    "data": [
                        {
                            "eventId": "evt_untitled",
                            "summary": "",
                            "startTime": "2026-06-17T20:30:00Z",
                            "endTime": "2026-06-17T21:00:00Z",
                        }
                    ],
                }
            )
        return json.dumps({"success": True, "data": []})

    monkeypatch.setattr("tools.registry.registry.dispatch", fake_dispatch)

    try:
        response = client.get("/api/company/today")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    meetings = response.json()["meetings"]
    assert len(meetings) == 1
    assert meetings[0]["title"] == "(No title)"
    assert meetings[0]["eventId"] == "evt_untitled"


def test_today_route_degrades_when_follow_ups_store_unavailable(monkeypatch):
    import json

    from fastapi import HTTPException

    app, client, prev_required = _policy_client()
    _patch_actor(monkeypatch)

    def unavailable_repo():
        raise HTTPException(status_code=503, detail="Divo Follow Ups store is unavailable")

    monkeypatch.setattr("hermes_cli.web_server._get_follow_up_repository", unavailable_repo)

    def fake_dispatch(tool_name, args, **kwargs):
        if tool_name == "lark_task":
            return json.dumps(
                {
                    "success": True,
                    "data": [
                        {
                            "taskId": "plain_task",
                            "title": "Plain Lark task",
                            "dueDate": "2026-06-18T17:00:00Z",
                        }
                    ],
                }
            )
        return json.dumps({"success": True, "data": []})

    monkeypatch.setattr("tools.registry.registry.dispatch", fake_dispatch)

    try:
        response = client.get("/api/company/today")
    finally:
        app.state.auth_required = prev_required

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["tasks"]) == 1
    assert payload["tasks"][0]["id"] == "lark:plain_task"
