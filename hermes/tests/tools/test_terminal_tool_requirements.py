"""Tests for terminal/file tool availability in local dev environments."""

import importlib

import pytest

from gateway import session_context as sc
from model_tools import get_tool_definitions

terminal_tool_module = importlib.import_module("tools.terminal_tool")


@pytest.fixture(autouse=True)
def _clear_caches():
    """Invalidate check_fn and tool-definitions caches before each test
    so that monkeypatched env vars / config take effect."""
    from tools.registry import invalidate_check_fn_cache
    from model_tools import _clear_tool_defs_cache
    invalidate_check_fn_cache()
    _clear_tool_defs_cache()
    yield
    invalidate_check_fn_cache()
    _clear_tool_defs_cache()


class TestTerminalRequirements:
    def test_local_backend_requirements(self, monkeypatch):
        monkeypatch.setattr(
            terminal_tool_module,
            "_get_env_config",
            lambda: {"env_type": "local"},
        )
        assert terminal_tool_module.check_terminal_requirements() is True

    def test_terminal_and_file_tools_resolve_for_local_backend(self, monkeypatch):
        monkeypatch.setattr(
            terminal_tool_module,
            "_get_env_config",
            lambda: {"env_type": "local"},
        )
        tools = get_tool_definitions(enabled_toolsets=["terminal", "file"], quiet_mode=True)
        names = {tool["function"]["name"] for tool in tools}
        assert "terminal" in names
        assert {"read_file", "write_file", "patch", "search_files"}.issubset(names)

    def test_terminal_and_execute_code_tools_resolve_for_managed_modal(self, monkeypatch, tmp_path):
        monkeypatch.setattr("tools.tool_backend_helpers.managed_nous_tools_enabled", lambda: True)
        monkeypatch.setattr(terminal_tool_module, "managed_nous_tools_enabled", lambda: True)
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))
        monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
        monkeypatch.delenv("MODAL_TOKEN_SECRET", raising=False)
        monkeypatch.setattr(
            terminal_tool_module,
            "_get_env_config",
            lambda: {"env_type": "modal", "modal_mode": "managed"},
        )
        monkeypatch.setattr(
            terminal_tool_module,
            "is_managed_tool_gateway_ready",
            lambda _vendor: True,
        )
        tools = get_tool_definitions(enabled_toolsets=["terminal", "code_execution"], quiet_mode=True)
        names = {tool["function"]["name"] for tool in tools}

        assert "terminal" in names
        assert "execute_code" in names

    def test_remote_lark_session_filters_server_local_execution_tools(self, monkeypatch):
        monkeypatch.setattr(
            terminal_tool_module,
            "_get_env_config",
            lambda: {"env_type": "local"},
        )
        tokens = sc.set_session_vars(platform="feishu")
        try:
            tools = get_tool_definitions(
                enabled_toolsets=["terminal", "file", "code_execution", "browser", "computer_use"],
                quiet_mode=True,
                skip_tool_search_assembly=True,
            )
            names = {tool["function"]["name"] for tool in tools}

            assert names.isdisjoint({
                "terminal",
                "process",
                "execute_code",
                "read_file",
                "write_file",
                "patch",
                "search_files",
                "browser_navigate",
                "browser_snapshot",
                "browser_click",
                "browser_type",
                "browser_scroll",
                "browser_back",
                "browser_press",
                "browser_get_images",
                "browser_vision",
                "browser_console",
                "browser_cdp",
                "browser_dialog",
                "computer_use",
            })
        finally:
            sc.clear_session_vars(tokens)

    def test_desktop_session_keeps_server_local_execution_tools(self, monkeypatch):
        monkeypatch.setattr(
            terminal_tool_module,
            "_get_env_config",
            lambda: {"env_type": "local"},
        )
        tokens = sc.set_session_vars(platform="desktop")
        try:
            tools = get_tool_definitions(
                enabled_toolsets=["terminal", "file"],
                quiet_mode=True,
                skip_tool_search_assembly=True,
            )
            names = {tool["function"]["name"] for tool in tools}

            assert "terminal" in names
            assert {"read_file", "write_file", "patch", "search_files"}.issubset(names)
        finally:
            sc.clear_session_vars(tokens)

    def test_tool_definition_cache_is_platform_scoped(self, monkeypatch):
        monkeypatch.setattr(
            terminal_tool_module,
            "_get_env_config",
            lambda: {"env_type": "local"},
        )
        desktop_tokens = sc.set_session_vars(platform="desktop")
        try:
            desktop_tools = get_tool_definitions(
                enabled_toolsets=["terminal"],
                quiet_mode=True,
                skip_tool_search_assembly=True,
            )
            desktop_names = {tool["function"]["name"] for tool in desktop_tools}
            assert "terminal" in desktop_names
        finally:
            sc.clear_session_vars(desktop_tokens)

        feishu_tokens = sc.set_session_vars(platform="feishu")
        try:
            feishu_tools = get_tool_definitions(
                enabled_toolsets=["terminal"],
                quiet_mode=True,
                skip_tool_search_assembly=True,
            )
            feishu_names = {tool["function"]["name"] for tool in feishu_tools}
            assert "terminal" not in feishu_names
            assert "process" not in feishu_names
        finally:
            sc.clear_session_vars(feishu_tokens)
