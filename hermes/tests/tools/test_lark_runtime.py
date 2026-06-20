"""Tests for enterprise Lark runtime credential resolution."""

from __future__ import annotations

import model_tools
from gateway import session_context as sc
from tools import lark_runtime
from tools.registry import invalidate_check_fn_cache


def test_resolve_lark_client_disables_env_fallback(monkeypatch):
    calls = []

    class _Repo:
        def get_lark_credentials(self, company_id, *, allow_env_fallback=True):
            calls.append((company_id, allow_env_fallback))
            return None

    lark_runtime.reset_cache()
    monkeypatch.setattr(lark_runtime, "enterprise_enabled", lambda: True)
    monkeypatch.setattr(lark_runtime, "_get_repository", lambda: _Repo())

    assert lark_runtime.resolve_lark_client("comp_1") is None
    assert calls == [("comp_1", False)]


def test_lark_tools_available_uses_native_company_credentials(monkeypatch):
    class _Repo:
        def get_lark_credentials(self, company_id, *, allow_env_fallback=True):
            assert company_id == "comp_1"
            assert allow_env_fallback is False
            return object()

    lark_runtime.reset_cache()
    monkeypatch.setattr(lark_runtime, "enterprise_enabled", lambda: True)
    monkeypatch.setattr(lark_runtime, "_get_repository", lambda: _Repo())
    monkeypatch.setenv("HERMES_COMPANY_ID", "comp_1")
    monkeypatch.delenv("LARK_APP_ID", raising=False)
    monkeypatch.delenv("LARK_APP_SECRET", raising=False)

    assert lark_runtime.lark_tools_available() is True


def test_lark_tools_available_uses_session_context_company_id(monkeypatch):
    class _Repo:
        def get_lark_credentials(self, company_id, *, allow_env_fallback=True):
            assert company_id == "comp_from_context"
            assert allow_env_fallback is False
            return object()

    lark_runtime.reset_cache()
    tokens = sc.set_session_vars(company_id="comp_from_context")
    try:
        monkeypatch.setattr(lark_runtime, "enterprise_enabled", lambda: True)
        monkeypatch.setattr(lark_runtime, "_get_repository", lambda: _Repo())
        monkeypatch.delenv("HERMES_COMPANY_ID", raising=False)
        monkeypatch.delenv("HERMES_DEFAULT_COMPANY_ID", raising=False)

        assert lark_runtime.lark_tools_available() is True
    finally:
        sc.clear_session_vars(tokens)


def test_lark_tools_available_does_not_expose_env_only_credentials(monkeypatch):
    lark_runtime.reset_cache()
    monkeypatch.setattr(lark_runtime, "enterprise_enabled", lambda: True)
    monkeypatch.setattr(lark_runtime, "_get_repository", lambda: None)
    monkeypatch.setenv("HERMES_COMPANY_ID", "comp_1")
    monkeypatch.setenv("LARK_APP_ID", "app")
    monkeypatch.setenv("LARK_APP_SECRET", "secret")

    assert lark_runtime.lark_tools_available() is False


def test_lark_toolset_reaches_model_schema_with_context_identity(monkeypatch):
    class _Repo:
        def get_lark_credentials(self, company_id, *, allow_env_fallback=True):
            assert company_id == "comp_from_context"
            assert allow_env_fallback is False
            return object()

    lark_runtime.reset_cache()
    invalidate_check_fn_cache()
    model_tools.invalidate_tool_defs_cache()
    tokens = sc.set_session_vars(
        company_id="comp_from_context",
        company_user_id="cu_admin",
        channel_identity_id="ci_lark",
        company_role="ADMIN",
    )
    try:
        monkeypatch.setattr(lark_runtime, "enterprise_enabled", lambda: True)
        monkeypatch.setattr(lark_runtime, "_get_repository", lambda: _Repo())
        definitions = model_tools.get_tool_definitions(
            enabled_toolsets=["lark"],
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
        names = {definition["function"]["name"] for definition in definitions}

        assert {
            "lark_messaging",
            "lark_doc",
            "lark_base",
            "lark_calendar",
            "lark_contacts",
            "lark_task",
            "lark_approval",
        } <= names
    finally:
        sc.clear_session_vars(tokens)
        invalidate_check_fn_cache()
        model_tools.invalidate_tool_defs_cache()


def test_lark_tools_are_core_visible_not_deferred():
    from tools.tool_search import is_deferrable_tool_name

    for tool_name in (
        "lark_messaging",
        "lark_doc",
        "lark_base",
        "lark_calendar",
        "lark_contacts",
        "lark_task",
        "lark_approval",
    ):
        assert is_deferrable_tool_name(tool_name) is False


def test_lark_tools_available_fails_closed_without_enterprise(monkeypatch):
    lark_runtime.reset_cache()
    monkeypatch.setattr(lark_runtime, "enterprise_enabled", lambda: False)
    monkeypatch.setenv("LARK_APP_ID", "app")
    monkeypatch.setenv("LARK_APP_SECRET", "secret")

    assert lark_runtime.lark_tools_available() is False
