"""Tests for the Divo Follow Ups live create harness guardrails."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace


def _load_script_module():
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "follow_up_create_smoke.py"
    spec = importlib.util.spec_from_file_location("follow_up_create_smoke", script_path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_plan_mode_prints_request_without_live_side_effects(monkeypatch, capsys):
    script = _load_script_module()
    monkeypatch.setattr(
        script,
        "get_enterprise_connection",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not connect")),
    )

    exit_code = script.main(
        [
            "--mode",
            "plan",
            "--company-id",
            "company_relicwave",
            "--manager-company-user-id",
            "cu_abhishek",
            "--assignee-query",
            "Anish Suman",
            "--title",
            "Smoke create",
            "--due-date",
            "2026-06-18T12:00:00Z",
            "--policy-preset",
            "only-done",
        ]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["plan"]["mode"] == "plan"
    assert payload["plan"]["company_id"] == "company_relicwave"
    assert payload["plan"]["delegator_company_user_id"] == "cu_abhishek"
    assert payload["plan"]["assignee_query"] == "Anish Suman"
    assert payload["plan"]["follow_up_policy_json"] == {
        "notify_on_done": True,
        "notify_on_pause": False,
        "notify_on_start": False,
    }


def test_full_plan_mode_includes_lifecycle_without_live_side_effects(monkeypatch, capsys):
    script = _load_script_module()
    monkeypatch.setattr(
        script,
        "get_enterprise_connection",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not connect")),
    )

    exit_code = script.main(
        [
            "--mode",
            "plan",
            "--flow",
            "full",
            "--company-id",
            "company_relicwave",
            "--manager-company-user-id",
            "cu_abhishek",
            "--assignee-query",
            "Anish Suman",
            "--title",
            "Smoke full lifecycle",
            "--checkpoint-note",
            "Checkpoint",
            "--completion-summary",
            "Completed",
        ]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["plan"]["flow"] == "full"
    assert payload["plan"]["lifecycle"]["checkpoint_note"] == "Checkpoint"
    assert payload["plan"]["lifecycle"]["completion_summary"] == "Completed"


def test_live_mode_requires_explicit_yes_before_connecting(monkeypatch, capsys):
    script = _load_script_module()
    monkeypatch.setattr(
        script,
        "get_enterprise_connection",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not connect")),
    )

    exit_code = script.main(
        [
            "--mode",
            "live",
            "--company-id",
            "company_relicwave",
            "--manager-company-user-id",
            "cu_abhishek",
            "--assignee-query",
            "Anish Suman",
            "--title",
            "Smoke create",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "Refusing to run live smoke without --yes-live" in captured.err
    assert captured.out == ""


def test_full_live_mode_sequences_service_with_fake_dependencies(monkeypatch, capsys):
    script = _load_script_module()

    class FakeService:
        def __init__(self, **kwargs):
            self.calls = []
            FakeService.instance = self

        def create_follow_up(self, request):
            self.calls.append(("create", request.title))
            follow_up = _follow_up(status="assigned")
            return SimpleNamespace(
                follow_up=follow_up,
                lark_task=SimpleNamespace(task_guid="task_1", title=request.title, url="https://task"),
                delegator=SimpleNamespace(
                    company_user_id="cu_manager",
                    display_name="Manager",
                    email="manager@example.com",
                    lark_open_id="ou_manager",
                ),
                assignee=SimpleNamespace(
                    company_user_id="cu_assignee",
                    display_name="Assignee",
                    email="assignee@example.com",
                    lark_open_id="ou_assignee",
                ),
            )

        def start_follow_up(self, request):
            self.calls.append(("start", request.active_session_id))
            return SimpleNamespace(
                follow_up=_follow_up(status="active", active_session_id=request.active_session_id),
                tracking_doc=SimpleNamespace(doc_token="doc_1", title="Doc", url="https://doc"),
                manager_message_id="msg_start",
            )

        def update_tracking_doc_checkpoint(self, request):
            self.calls.append(("checkpoint", request.note))
            return SimpleNamespace(follow_up=_follow_up(status="active"))

        def pause_follow_up(self, request):
            self.calls.append(("pause", request.reason))
            return SimpleNamespace(follow_up=_follow_up(status="paused"), manager_message_id="msg_pause")

        def complete_follow_up(self, request):
            self.calls.append(("complete", request.summary))
            return SimpleNamespace(
                follow_up=_follow_up(status="done", summary=request.summary),
                manager_message_id="msg_done",
            )

    monkeypatch.setattr(script, "get_enterprise_connection", lambda *args, **kwargs: object())
    monkeypatch.setattr(script, "DivoFollowUpsService", FakeService)
    monkeypatch.setattr(script, "FollowUpRepository", lambda connection: object())
    monkeypatch.setattr(script, "CompanyIdentityFollowUpResolver", lambda: object())
    monkeypatch.setattr(script, "NativeToolFollowUpLarkGateway", lambda: object())

    exit_code = script.main(
        [
            "--mode",
            "live",
            "--yes-live",
            "--flow",
            "full",
            "--company-id",
            "company_relicwave",
            "--manager-company-user-id",
            "cu_abhishek",
            "--assignee-company-user-id",
            "cu_assignee",
            "--title",
            "Smoke full lifecycle",
            "--active-session-id",
            "session_1",
            "--resume-session-id",
            "session_2",
            "--checkpoint-note",
            "Checkpoint",
            "--pause-reason",
            "Paused",
            "--completion-summary",
            "Completed",
        ]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["flow"] == "full"
    assert payload["lifecycle"]["completed"]["follow_up"]["status"] == "done"
    assert FakeService.instance.calls == [
        ("create", "Smoke full lifecycle"),
        ("start", "session_1"),
        ("checkpoint", "Checkpoint"),
        ("pause", "Paused"),
        ("start", "session_2"),
        ("complete", "Completed"),
    ]


def _follow_up(*, status: str, active_session_id: str | None = None, summary: str | None = None):
    return SimpleNamespace(
        id="fu_1",
        company_id="company_relicwave",
        status=status,
        lark_task_guid="task_1",
        delegator_company_user_id="cu_manager",
        assignee_company_user_id="cu_assignee",
        active_session_id=active_session_id,
        tracking_doc_token="doc_1",
        tracking_doc_url="https://doc",
        summary=summary,
    )
