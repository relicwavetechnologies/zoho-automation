"""Tests for agent/system_prompt.py — context-file cwd wiring."""

from types import SimpleNamespace
from unittest.mock import patch

from agent.system_prompt import (
    build_active_follow_ups_prompt,
    build_current_divo_user_identity_prompt,
    build_system_prompt_parts,
)


def _make_agent(**overrides):
    base = dict(
        load_soul_identity=False,
        skip_context_files=False,
        valid_tool_names=[],
        _task_completion_guidance=False,
        _tool_use_enforcement=False,
        _environment_probe=False,
        _kanban_worker_guidance="",
        _memory_store=None,
        _memory_manager=None,
        model="",
        provider="",
        platform="",
        pass_session_id=False,
        session_id="",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _captured_context_cwd(agent):
    """The cwd build_system_prompt_parts hands to build_context_files_prompt."""
    captured = {}

    def fake_context_files(cwd=None, skip_soul=False):
        captured["cwd"] = cwd
        return ""

    with (
        patch("run_agent.load_soul_md", return_value=""),
        patch("run_agent.build_nous_subscription_prompt", return_value=""),
        patch("run_agent.build_environment_hints", return_value=""),
        patch("run_agent.build_context_files_prompt", side_effect=fake_context_files),
    ):
        build_system_prompt_parts(agent)
    return captured["cwd"]


class TestContextFileCwd:
    def test_none_when_terminal_cwd_unset(self, monkeypatch):
        # Unset → None, so discovery falls back to the launch dir inside
        # build_context_files_prompt (the local-CLI #19242 contract).
        monkeypatch.delenv("TERMINAL_CWD", raising=False)
        assert _captured_context_cwd(_make_agent()) is None

    def test_configured_dir_when_terminal_cwd_set(self, monkeypatch, tmp_path):
        monkeypatch.setenv("TERMINAL_CWD", str(tmp_path))
        assert _captured_context_cwd(_make_agent()) == tmp_path


class TestActiveCapabilityBoundary:
    def test_system_prompt_lists_active_tools_and_warns_against_overclaiming(self):
        agent = _make_agent(valid_tool_names={"web_search", "feishu_doc_read"})

        def fake_toolset(tool_name):
            return {
                "web_search": "web",
                "feishu_doc_read": "feishu_doc",
            }.get(tool_name, "")

        with (
            patch("run_agent.load_soul_md", return_value=""),
            patch("run_agent.build_nous_subscription_prompt", return_value=""),
            patch("run_agent.build_environment_hints", return_value=""),
            patch("run_agent.build_context_files_prompt", return_value=""),
            patch("run_agent.get_toolset_for_tool", side_effect=fake_toolset),
        ):
            parts = build_system_prompt_parts(agent)

        stable = parts["stable"]
        assert "Current capability boundary" in stable
        assert "active tool schema is the source of truth" in stable
        assert "web_search" in stable
        assert "feishu_doc_read" in stable
        assert "not currently available" in stable


class TestCurrentDivoUserIdentityPrompt:
    def test_empty_without_company_identity(self, monkeypatch):
        monkeypatch.setattr(
            "gateway.session_context.get_session_env",
            lambda name, default="": "",
        )

        assert build_current_divo_user_identity_prompt() == ""

    def test_builds_identity_from_session_and_identity_store(self, monkeypatch):
        def fake_session_env(name, default=""):
            return {
                "HERMES_COMPANY_ID": "company_1",
                "HERMES_COMPANY_USER_ID": "cu_1",
                "HERMES_CHANNEL_IDENTITY_ID": "ci_lark",
                "HERMES_COMPANY_ROLE": "SUPER_ADMIN",
                "HERMES_DEPARTMENT_ID": "dept_ops",
                "HERMES_SESSION_PLATFORM": "lark",
                "HERMES_SESSION_USER_ID": "ou_fallback",
                "HERMES_SESSION_USER_NAME": "Fallback User",
            }.get(name, default)

        monkeypatch.setattr("gateway.session_context.get_session_env", fake_session_env)
        monkeypatch.setattr(
            "gateway.company_identity.get_company_user",
            lambda company_user_id, company_id=None: {
                "id": company_user_id,
                "company_id": company_id,
                "display_name": "Abhishek Verma",
                "email": "abhishek@example.com",
                "role": "SUPER_ADMIN",
                "department_id": "dept_ops",
            },
        )
        monkeypatch.setattr(
            "gateway.company_identity.list_channel_identities_for_company_user",
            lambda company_user_id: [
                {
                    "id": "ci_lark",
                    "platform": "lark",
                    "platform_user_id": "ou_real_lark",
                    "platform_user_id_alt": "user_real_lark",
                }
            ],
        )

        block = build_current_divo_user_identity_prompt()

        assert "Current Divo user identity" in block
        assert "- Name: Abhishek Verma" in block
        assert "- Email: abhishek@example.com" in block
        assert "- Company user ID: cu_1" in block
        assert "- Company role: SUPER_ADMIN" in block
        assert "- Is super admin: true" in block
        assert "- Department ID: dept_ops" in block
        assert "- Channel identity ID: ci_lark" in block
        assert "- Lark open ID: ou_real_lark" in block
        assert "oauth" not in block.lower()
        assert "token" not in block.lower()

    def test_system_prompt_injects_identity_block_into_stable_tier(self, monkeypatch):
        monkeypatch.setattr(
            "agent.system_prompt.build_current_divo_user_identity_prompt",
            lambda: "Current Divo user identity:\n- Name: Abhishek Verma",
        )
        agent = _make_agent(skip_context_files=True)

        with (
            patch("run_agent.load_soul_md", return_value=""),
            patch("run_agent.build_nous_subscription_prompt", return_value=""),
            patch("run_agent.build_environment_hints", return_value=""),
            patch("run_agent.build_context_files_prompt", return_value=""),
        ):
            parts = build_system_prompt_parts(agent)

        assert "Current Divo user identity" in parts["stable"]
        assert "- Name: Abhishek Verma" in parts["stable"]
        assert "Current Divo user identity" not in parts["volatile"]


class TestActiveFollowUpsPrompt:
    def test_empty_without_enterprise_identity(self, monkeypatch):
        monkeypatch.setattr(
            "gateway.session_context.get_session_env",
            lambda name, default="": "",
        )

        assert build_active_follow_ups_prompt() == ""

    def test_builds_active_follow_ups_prompt_and_injects_volatile_block(self, monkeypatch):
        class FakeRepo:
            def __init__(self, connection):
                self.connection = connection

            def list_active(self, company_id, *, assignee_company_user_id=None):
                assert company_id == "company_1"
                assert assignee_company_user_id == "user_ag"
                return [
                    SimpleNamespace(
                        id="fu_1",
                        status="active",
                        lark_task_guid="task_1",
                        active_session_id="session_active",
                        tracking_doc_url="https://tenant.larksuite.com/docx/doc_1",
                        tracking_doc_token="doc_1",
                    )
                ]

            def list_events(self, company_id, follow_up_id):
                assert company_id == "company_1"
                assert follow_up_id == "fu_1"
                return [
                    SimpleNamespace(
                        event_type="created",
                        payload_json={
                            "title": "Prepare renewal notes",
                            "due_date": "2026-06-20T12:00:00Z",
                        },
                    )
                ]

        def fake_session_env(name, default=""):
            return {
                "HERMES_COMPANY_ID": "company_1",
                "HERMES_COMPANY_USER_ID": "user_ag",
            }.get(name, default)

        monkeypatch.setattr("gateway.session_context.get_session_env", fake_session_env)
        monkeypatch.setattr("enterprise.db.get_enterprise_connection", lambda: object())
        monkeypatch.setattr("enterprise.follow_up_repository.FollowUpRepository", FakeRepo)

        block = build_active_follow_ups_prompt()
        assert "Active Divo Follow Ups" in block
        assert "Prepare renewal notes" in block
        assert "tracking_doc=https://tenant.larksuite.com/docx/doc_1" in block

        agent = _make_agent()
        with (
            patch("run_agent.load_soul_md", return_value=""),
            patch("run_agent.build_nous_subscription_prompt", return_value=""),
            patch("run_agent.build_environment_hints", return_value=""),
            patch("run_agent.build_context_files_prompt", return_value=""),
        ):
            parts = build_system_prompt_parts(agent)

        assert "Active Divo Follow Ups" in parts["volatile"]
        assert "Prepare renewal notes" in parts["volatile"]
