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
