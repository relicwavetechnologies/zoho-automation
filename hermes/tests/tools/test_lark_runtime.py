"""Tests for enterprise Lark runtime credential resolution."""

from __future__ import annotations

from tools import lark_runtime


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


def test_lark_tools_available_fails_closed_without_enterprise(monkeypatch):
    lark_runtime.reset_cache()
    monkeypatch.setattr(lark_runtime, "enterprise_enabled", lambda: False)
    monkeypatch.setenv("LARK_APP_ID", "app")
    monkeypatch.setenv("LARK_APP_SECRET", "secret")

    assert lark_runtime.lark_tools_available() is False
