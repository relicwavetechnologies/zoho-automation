"""Tests for google_scope helpers and runtime connection lookup."""

from __future__ import annotations

import json

import pytest

from tools.google_scope import (
    missing_scopes,
    parse_granted_scopes,
    reconnect_required_error,
    require_google_scopes,
    scope_upgrade_error,
    scopes_satisfied,
)


def test_parse_granted_scopes_string():
    assert parse_granted_scopes("a b,c") == {"a", "b", "c"}


def test_scopes_satisfied():
    assert scopes_satisfied(["a", "b"], ["a"]) is True
    assert scopes_satisfied(["a"], ["a", "b"]) is False


def test_missing_scopes():
    assert missing_scopes(["a"], ["a", "b"]) == ["b"]


def test_scope_upgrade_error_json():
    payload = json.loads(scope_upgrade_error(tool_name="gmail", missing=["scope-a"]))
    assert payload["success"] is False
    assert payload["code"] == "scope_upgrade_required"
    assert payload["missing_scopes"] == ["scope-a"]


def test_reconnect_required_error_json():
    payload = json.loads(reconnect_required_error(tool_name="gmail"))
    assert payload["code"] == "reconnect_required"


def test_require_google_scopes_none_when_ok():
    assert require_google_scopes(["a", "b"], ["a"], tool_name="gmail") is None


def test_require_google_scopes_returns_error_when_missing():
    err = require_google_scopes(["a"], ["a", "b"], tool_name="gmail", operation="send")
    payload = json.loads(err)
    assert payload["code"] == "scope_upgrade_required"


def test_get_google_connection(monkeypatch):
    from dataclasses import dataclass

    @dataclass
    class Creds:
        refresh_token: str = "rt"
        scope: str = "https://www.googleapis.com/auth/gmail.readonly"
        google_email: str = "me@x.com"

    class Repo:
        def get_google_credentials(self, company_id, user_id=None):
            return Creds()

    monkeypatch.setattr("tools.google_runtime.enterprise_enabled", lambda: True)
    monkeypatch.setattr("tools.google_runtime._get_repository", lambda: Repo())

    from tools.google_runtime import get_google_connection

    ctx = get_google_connection("comp_1", "cu_1")
    assert ctx is not None
    assert ctx.account_email == "me@x.com"
    assert "gmail.readonly" in next(iter(ctx.granted_scopes))
