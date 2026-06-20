"""T3.1 — enterprise identity injection at ToolRegistry.dispatch.

Connector handlers that declare ``**kwargs`` receive the resolved company/user/
session context from the session ContextVars; fixed-signature engine handlers
are left untouched.
"""

import json

import pytest

from gateway import session_context as sc
from tools.registry import ToolRegistry


@pytest.fixture
def reg():
    return ToolRegistry()


def _schema(name):
    return {"name": name, "parameters": {"type": "object", "properties": {}}}


@pytest.fixture(autouse=True)
def _clear_ctx(monkeypatch):
    # Each test starts with empty identity context.
    monkeypatch.delenv("HERMES_TOOL_PERMISSION_POLICY_JSON", raising=False)
    monkeypatch.delenv("HERMES_TOOL_ADMIN_TOOLS", raising=False)
    monkeypatch.delenv("HERMES_TOOL_ADMIN_TOOLSETS", raising=False)
    tokens = sc.set_session_vars()
    sc.set_current_session_id("")
    yield
    sc.clear_session_vars(tokens)


def test_connector_handler_receives_identity(reg):
    captured = {}

    def handler(args, **kwargs):
        captured.update(kwargs)
        return json.dumps({"ok": True})

    reg.register(name="conn", toolset="t", schema=_schema("conn"), handler=handler)

    sc.set_session_vars(
        company_id="comp_1",
        company_user_id="cu_1",
        company_role="ADMIN",
        channel_identity_id="ci_1",
        session_key="session-key-1",
    )
    sc.set_current_session_id("sess_9")

    reg.dispatch("conn", {})

    assert captured["company_id"] == "comp_1"
    assert captured["company_role"] == "ADMIN"
    assert captured["channel_identity_id"] == "ci_1"
    assert captured["session_key"] == "session-key-1"
    assert captured["session_id"] == "sess_9"


def test_engine_handler_without_kwargs_is_untouched(reg):
    # A fixed-signature handler must NOT receive identity kwargs (would raise
    # TypeError: unexpected keyword argument), even when context is set.
    def handler(args):
        return json.dumps({"ok": True})

    reg.register(name="engine", toolset="t", schema=_schema("engine"), handler=handler)
    sc.set_session_vars(
        company_id="comp_1",
        company_user_id="cu_1",
        channel_identity_id="ci_1",
    )

    result = reg.dispatch("engine", {})
    assert json.loads(result) == {"ok": True}


def test_empty_context_injects_nothing(reg):
    captured = {}

    def handler(args, **kwargs):
        captured.update(kwargs)
        return json.dumps({"ok": True})

    reg.register(name="conn", toolset="t", schema=_schema("conn"), handler=handler)
    reg.dispatch("conn", {})

    assert "company_id" not in captured
    assert captured == {}


def test_explicit_kwarg_overrides_injected_identity(reg):
    captured = {}

    def handler(args, **kwargs):
        captured.update(kwargs)
        return json.dumps({"ok": True})

    reg.register(name="conn", toolset="t", schema=_schema("conn"), handler=handler)
    sc.set_session_vars(
        company_id="from_context",
        company_user_id="cu_1",
        channel_identity_id="ci_1",
    )

    reg.dispatch("conn", {}, company_id="explicit")
    assert captured["company_id"] == "explicit"


def test_company_mode_incomplete_identity_denies_dispatch(reg):
    called = False

    def handler(args, **kwargs):
        nonlocal called
        called = True
        return json.dumps({"ok": True})

    reg.register(name="conn", toolset="google", schema=_schema("conn"), handler=handler)
    sc.set_session_vars(company_id="comp_1")

    result = json.loads(reg.dispatch("conn", {}))

    assert called is False
    assert result["code"] == "company_identity_required"


def test_member_cannot_dispatch_default_admin_tool(reg, monkeypatch):
    monkeypatch.delenv("HERMES_TOOL_ADMIN_TOOLS", raising=False)
    called = False

    def handler(args, **kwargs):
        nonlocal called
        called = True
        return json.dumps({"ok": True})

    reg.register(
        name="skill_manage",
        toolset="skills",
        schema=_schema("skill_manage"),
        handler=handler,
    )
    sc.set_session_vars(
        company_id="comp_1",
        company_user_id="cu_1",
        channel_identity_id="ci_1",
        company_role="MEMBER",
    )

    result = json.loads(reg.dispatch("skill_manage", {}))

    assert called is False
    assert result["code"] == "admin_required"


def test_admin_dispatches_default_admin_tool(reg, monkeypatch):
    monkeypatch.delenv("HERMES_TOOL_ADMIN_TOOLS", raising=False)
    called = False

    def handler(args, **kwargs):
        nonlocal called
        called = True
        return json.dumps({"ok": True})

    reg.register(
        name="skill_manage",
        toolset="skills",
        schema=_schema("skill_manage"),
        handler=handler,
    )
    sc.set_session_vars(
        company_id="comp_1",
        company_user_id="cu_1",
        channel_identity_id="ci_1",
        company_role="ADMIN",
    )

    result = json.loads(reg.dispatch("skill_manage", {}))

    assert called is True
    assert result == {"ok": True}


def test_super_admin_dispatches_sensitive_tool(reg):
    called = False

    def handler(args, **kwargs):
        nonlocal called
        called = True
        return json.dumps({"ok": True})

    reg.register(name="zoho_books", toolset="zoho", schema=_schema("zoho_books"), handler=handler)
    sc.set_session_vars(
        company_id="comp_1",
        company_user_id="cu_1",
        channel_identity_id="ci_1",
        company_role="SUPER_ADMIN",
    )

    result = json.loads(reg.dispatch("zoho_books", {}))

    assert called is True
    assert result == {"ok": True}


def test_get_definitions_hides_unauthorized_admin_tool(reg, monkeypatch):
    monkeypatch.delenv("HERMES_TOOL_ADMIN_TOOLS", raising=False)
    monkeypatch.setattr("tools.google_runtime.enterprise_enabled", lambda: True)
    monkeypatch.setattr("tools.google_runtime._get_repository", lambda: None)

    def handler(args, **kwargs):
        return json.dumps({"ok": True})

    reg.register(
        name="skill_manage",
        toolset="skills",
        schema=_schema("skill_manage"),
        handler=handler,
    )
    reg.register(
        name="gmail",
        toolset="google",
        schema=_schema("gmail"),
        handler=handler,
        check_fn=lambda: True,
    )
    sc.set_session_vars(
        company_id="comp_1",
        company_user_id="cu_1",
        channel_identity_id="ci_1",
        company_role="MEMBER",
    )

    definitions = reg.get_definitions({"skill_manage", "gmail"})
    names = {definition["function"]["name"] for definition in definitions}

    assert "skill_manage" not in names
    assert "gmail" in names
