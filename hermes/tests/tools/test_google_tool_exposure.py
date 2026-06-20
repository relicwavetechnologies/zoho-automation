"""Regression tests for Google tool schema exposure."""

from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

import tools.google_tools  # noqa: F401 — registers google tools
from gateway import session_context as sc
from model_tools import get_tool_definitions, invalidate_tool_defs_cache
from tools.registry import _module_registers_tools, discover_builtin_tools, registry


@dataclass
class _FakeGoogleCreds:
    refresh_token: str = "rtok"
    scope: str = (
        "https://www.googleapis.com/auth/gmail.readonly "
        "https://www.googleapis.com/auth/gmail.compose "
        "https://www.googleapis.com/auth/gmail.send "
        "https://www.googleapis.com/auth/gmail.modify "
        "https://www.googleapis.com/auth/drive.readonly "
        "https://www.googleapis.com/auth/drive.file "
        "https://www.googleapis.com/auth/calendar.readonly "
        "https://www.googleapis.com/auth/calendar.events"
    )
    google_email: str = "user@example.com"


class _FakeRepo:
    def __init__(self, creds: _FakeGoogleCreds | None):
        self._creds = creds

    def get_google_credentials(self, company_id, user_id=None):
        if self._creds is None:
            return None
        return self._creds


@pytest.fixture(autouse=True)
def _clear_ctx(monkeypatch):
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "secret")
    from tools.registry import invalidate_check_fn_cache

    invalidate_check_fn_cache()
    invalidate_tool_defs_cache()
    tokens = sc.set_session_vars()
    yield
    sc.clear_session_vars(tokens)
    invalidate_check_fn_cache()
    invalidate_tool_defs_cache()


def _member_identity():
    sc.set_session_vars(
        company_id="comp_1",
        company_user_id="cu_1",
        channel_identity_id="ci_1",
        company_role="MEMBER",
    )


def test_gmail_exposed_for_connected_member(monkeypatch):
    monkeypatch.setattr("tools.google_runtime.enterprise_enabled", lambda: True)
    monkeypatch.setattr("tools.google_runtime._get_repository", lambda: _FakeRepo(_FakeGoogleCreds()))
    _member_identity()

    defs = get_tool_definitions(enabled_toolsets=["google"], quiet_mode=True)
    names = {d["function"]["name"] for d in defs}

    assert "gmail" in names
    assert "google_calendar" in names
    assert "google_drive" in names


def test_google_tools_are_autodiscoverable():
    from pathlib import Path

    tools_dir = Path(__file__).resolve().parents[2] / "tools"

    assert _module_registers_tools(tools_dir / "google_tools.py") is True
    assert "tools.google_tools" in discover_builtin_tools(tools_dir)


def test_google_tools_are_core_visible_not_deferred():
    from tools.tool_search import is_deferrable_tool_name

    for tool_name in (
        "gmail",
        "google_calendar",
        "google_drive",
        "google_docs",
        "google_sheets",
        "google_slides",
    ):
        assert is_deferrable_tool_name(tool_name) is False


def test_gmail_hidden_without_credentials(monkeypatch):
    monkeypatch.setattr("tools.google_runtime.enterprise_enabled", lambda: True)
    monkeypatch.setattr("tools.google_runtime._get_repository", lambda: _FakeRepo(None))
    _member_identity()

    defs = get_tool_definitions(enabled_toolsets=["google"], quiet_mode=True)
    names = {d["function"]["name"] for d in defs}

    assert "gmail" not in names
    assert "google_drive" not in names


def test_gmail_hidden_without_identity(monkeypatch):
    monkeypatch.setattr("tools.google_runtime.enterprise_enabled", lambda: True)
    monkeypatch.setattr("tools.google_runtime._get_repository", lambda: _FakeRepo(_FakeGoogleCreds()))

    defs = get_tool_definitions(enabled_toolsets=["google"], quiet_mode=True)
    names = {d["function"]["name"] for d in defs}

    assert "gmail" not in names


def test_no_identity_google_check_cache_does_not_poison_bound_identity(monkeypatch):
    monkeypatch.setattr("tools.google_runtime.enterprise_enabled", lambda: True)
    monkeypatch.setattr("tools.google_runtime._get_repository", lambda: _FakeRepo(_FakeGoogleCreds()))

    first = registry.get_definitions({"gmail"}, quiet=True)
    assert {d["function"]["name"] for d in first} == set()

    _member_identity()
    second = registry.get_definitions({"gmail"}, quiet=True)
    assert {d["function"]["name"] for d in second} == {"gmail"}


def test_registry_get_definitions_respects_connected_member(monkeypatch):
    monkeypatch.setattr("tools.google_runtime.enterprise_enabled", lambda: True)
    monkeypatch.setattr("tools.google_runtime._get_repository", lambda: _FakeRepo(_FakeGoogleCreds()))
    _member_identity()

    names = {d["function"]["name"] for d in registry.get_definitions({"gmail", "skill_manage"}, quiet=True)}
    assert "gmail" in names
