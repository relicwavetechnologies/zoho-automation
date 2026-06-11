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
def _clear_ctx():
    # Each test starts with empty identity context.
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

    sc.set_session_vars(company_id="comp_1", company_role="ADMIN", channel_identity_id="ci_1")
    sc.set_current_session_id("sess_9")

    reg.dispatch("conn", {})

    assert captured["company_id"] == "comp_1"
    assert captured["company_role"] == "ADMIN"
    assert captured["channel_identity_id"] == "ci_1"
    assert captured["session_id"] == "sess_9"


def test_engine_handler_without_kwargs_is_untouched(reg):
    # A fixed-signature handler must NOT receive identity kwargs (would raise
    # TypeError: unexpected keyword argument), even when context is set.
    def handler(args):
        return json.dumps({"ok": True})

    reg.register(name="engine", toolset="t", schema=_schema("engine"), handler=handler)
    sc.set_session_vars(company_id="comp_1")

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
    sc.set_session_vars(company_id="from_context")

    reg.dispatch("conn", {}, company_id="explicit")
    assert captured["company_id"] == "explicit"
