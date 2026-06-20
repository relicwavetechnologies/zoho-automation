#!/usr/bin/env python3
"""Inspect the real model tool schema for a Hermes platform/session.

This is a zero-write diagnostic for connector visibility issues. It uses the
same config resolver, session context, registry checks, and schema builder that
the gateway uses before calling the model.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_sessions(hermes_home: Path) -> dict[str, dict[str, Any]]:
    path = hermes_home / "sessions" / "sessions.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data.get("sessions"), dict):
        data = data["sessions"]
    return {str(key): value for key, value in data.items() if isinstance(value, dict)}


def _pick_session(
    sessions: dict[str, dict[str, Any]],
    *,
    platform: str,
    session_key: str,
) -> dict[str, Any] | None:
    if session_key:
        return sessions.get(session_key)
    platform_aliases = {platform}
    if platform == "feishu":
        platform_aliases.add("lark")
    if platform == "lark":
        platform_aliases.add("feishu")
    for session in sessions.values():
        if session.get("platform") in platform_aliases and session.get("company_id"):
            return session
    return None


def _session_origin(session: dict[str, Any]) -> dict[str, Any]:
    origin = session.get("origin")
    return origin if isinstance(origin, dict) else {}


def _tool_names(defs: list[dict[str, Any]]) -> list[str]:
    names = []
    for definition in defs:
        function = definition.get("function")
        if isinstance(function, dict) and function.get("name"):
            names.append(str(function["name"]))
    return sorted(names)


def _matches_family(name: str, family: str) -> bool:
    if family == "google":
        return name == "gmail" or name.startswith("google_")
    if family == "lark":
        return name.startswith("lark_")
    return name == family or name.startswith(f"{family}_")


def build_visibility_report(args: argparse.Namespace) -> dict[str, Any]:
    from gateway import session_context as sc
    from hermes_constants import get_hermes_home
    from hermes_cli.config import load_config
    from hermes_cli.tools_config import _get_platform_tools
    from model_tools import get_tool_definitions, invalidate_tool_defs_cache
    from tools.registry import invalidate_check_fn_cache, registry

    hermes_home = Path(args.hermes_home or get_hermes_home()).expanduser()
    sessions = _load_sessions(hermes_home)
    session = _pick_session(sessions, platform=args.platform, session_key=args.session_key)
    origin = _session_origin(session or {})
    config = load_config() or {}
    enabled_toolsets = sorted(_get_platform_tools(config, args.platform))

    tokens = None
    if session:
        tokens = sc.set_session_vars(
            platform=str(session.get("platform") or args.platform),
            session_key=str(session.get("session_key") or ""),
            company_id=str(session.get("company_id") or ""),
            company_user_id=str(session.get("company_user_id") or ""),
            channel_identity_id=str(session.get("channel_identity_id") or ""),
            company_role=str(session.get("company_role") or ""),
            department_id=str(session.get("department_id") or ""),
            user_id=str(origin.get("user_id") or ""),
            user_name=str(origin.get("user_name") or ""),
            chat_id=str(origin.get("chat_id") or ""),
            chat_name=str(origin.get("chat_name") or ""),
        )
        sc.set_current_session_id(str(session.get("session_id") or ""))

    try:
        invalidate_check_fn_cache()
        invalidate_tool_defs_cache()
        definitions = get_tool_definitions(
            enabled_toolsets=enabled_toolsets,
            quiet_mode=True,
            skip_tool_search_assembly=args.skip_tool_search,
        )
        schema_names = _tool_names(definitions)
        registered_by_toolset = {
            toolset: registry.get_tool_names_for_toolset(toolset)
            for toolset in sorted(set(args.families) | {"google", "lark", "zoho"})
        }
        return {
            "hermesHome": str(hermes_home),
            "platform": args.platform,
            "sessionFound": session is not None,
            "session": {
                "sessionKey": (session or {}).get("session_key"),
                "sessionId": (session or {}).get("session_id"),
                "companyId": (session or {}).get("company_id"),
                "companyUserId": (session or {}).get("company_user_id"),
                "channelIdentityId": (session or {}).get("channel_identity_id"),
                "companyRole": (session or {}).get("company_role"),
                "userName": origin.get("user_name"),
                "chatId": origin.get("chat_id"),
            },
            "enabledToolsets": enabled_toolsets,
            "registeredByToolset": registered_by_toolset,
            "schemaCount": len(schema_names),
            "schemaByFamily": {
                family: [name for name in schema_names if _matches_family(name, family)]
                for family in args.families
            },
        }
    finally:
        if tokens is not None:
            sc.clear_session_vars(tokens)
            sc.set_current_session_id("")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspect Hermes tool schema visibility.")
    parser.add_argument("--platform", default="feishu")
    parser.add_argument("--session-key", default="")
    parser.add_argument("--hermes-home", default="")
    parser.add_argument(
        "--family",
        dest="families",
        action="append",
        default=None,
        help="Tool family to summarize. Repeatable. Defaults to lark and google.",
    )
    parser.add_argument(
        "--with-tool-search",
        dest="skip_tool_search",
        action="store_false",
        default=True,
        help="Inspect final schema after tool_search assembly.",
    )
    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    args.families = args.families or ["lark", "google"]
    report = build_visibility_report(args)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
