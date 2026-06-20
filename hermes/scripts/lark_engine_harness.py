#!/usr/bin/env python3
"""Run Hermes' native agent loop against real Lark tools, then deliver to Lark.

This is the Hermes-side equivalent of Divo's old advance-backend engine
harness: it bypasses webhooks, but uses the real agent, real tool registry,
real company credential vault, and real Lark APIs.

Examples:
  python scripts/lark_engine_harness.py "Find Abhishek in Lark contacts"
  python scripts/lark_engine_harness.py --no-deliver "Create a Lark doc ..."
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


DEFAULT_ABHISHEK_OPEN_ID = "ou_48b958c283635491b756c0ef23f47159"
DEFAULT_P2P_CHAT_ID = "oc_4da3c8e6a6a2b9eb29a2aea24fd17e50"


def _env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return default


def _json_loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _identity_open_id(identity: dict[str, Any]) -> str:
    raw = _json_loads(identity.get("raw_json") or identity.get("rawJson"))
    return str(
        identity.get("platform_user_id")
        or identity.get("externalUserId")
        or raw.get("open_id")
        or raw.get("user_id")
        or ""
    ).strip()


def _resolve_identity(
    *,
    company_id: str,
    lark_open_id: str,
    company_user_id: str = "",
    channel_identity_id: str = "",
    company_role: str = "",
    department_id: str = "",
) -> dict[str, str]:
    if company_user_id and channel_identity_id:
        return {
            "company_id": company_id,
            "company_user_id": company_user_id,
            "channel_identity_id": channel_identity_id,
            "company_role": company_role or "ADMIN",
            "department_id": department_id,
            "lark_open_id": lark_open_id,
            "display_name": "",
        }

    try:
        from gateway.company_identity import (
            list_channel_identities_for_company_user,
            list_company_users,
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Could not import Hermes company identity helpers: {exc}") from exc

    for user in list_company_users(company_id=company_id):
        candidate_user_id = str(
            user.get("id") or user.get("company_user_id") or user.get("companyUserId") or ""
        ).strip()
        if not candidate_user_id:
            continue
        for identity in list_channel_identities_for_company_user(candidate_user_id):
            platform = str(identity.get("platform") or identity.get("channel") or "").lower()
            if platform not in {"lark", "feishu"}:
                continue
            if _identity_open_id(identity) != lark_open_id:
                continue
            return {
                "company_id": company_id,
                "company_user_id": candidate_user_id,
                "channel_identity_id": str(identity.get("id") or ""),
                "company_role": str(user.get("role") or user.get("company_role") or company_role or "ADMIN"),
                "department_id": str(user.get("department_id") or user.get("departmentId") or department_id or ""),
                "lark_open_id": lark_open_id,
                "display_name": str(user.get("display_name") or user.get("displayName") or user.get("email") or ""),
            }

    raise RuntimeError(
        "Could not resolve Hermes company identity for "
        f"company_id={company_id!r}, lark_open_id={lark_open_id!r}. "
        "Pass --company-user-id and --channel-identity-id, or make sure the Lark user is synced."
    )


def _deliver_to_lark(chat_id: str, text: str) -> dict[str, Any]:
    import tools.lark_tools  # noqa: F401 - registers native Lark tools
    from tools.registry import registry

    payload = registry.dispatch(
        "lark_messaging",
        {
            "op": "send",
            "chatId": chat_id,
            "receiveIdType": "chat_id",
            "text": text,
        },
    )
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {"success": False, "raw": payload}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run Hermes native Lark harness.")
    parser.add_argument("prompt", nargs="*", help="Prompt to send to the Hermes agent.")
    parser.add_argument("--company-id", default=_env("HERMES_COMPANY_ID", "COMPANY_ID", "HERMES_DEFAULT_COMPANY_ID"))
    parser.add_argument("--company-user-id", default=_env("HERMES_COMPANY_USER_ID"))
    parser.add_argument("--channel-identity-id", default=_env("HERMES_CHANNEL_IDENTITY_ID"))
    parser.add_argument("--company-role", default=_env("HERMES_COMPANY_ROLE", default="ADMIN"))
    parser.add_argument("--department-id", default=_env("HERMES_DEPARTMENT_ID"))
    parser.add_argument("--lark-open-id", default=_env("HERMES_LARK_OPEN_ID", "LARK_OPEN_ID", "HERMES_SESSION_USER_ID", default=DEFAULT_ABHISHEK_OPEN_ID))
    parser.add_argument("--chat-id", default=_env("HERMES_LARK_HARNESS_CHAT_ID", "LARK_HARNESS_CHAT_ID", "HERMES_SESSION_CHAT_ID", default=DEFAULT_P2P_CHAT_ID))
    parser.add_argument("--chat-name", default=_env("HERMES_SESSION_CHAT_NAME", default="Hermes Lark Harness"))
    parser.add_argument("--model", default=_env("HERMES_HARNESS_MODEL", "MODEL_ID", "DEEPSEEK_MODEL", default="deepseek-v4-flash"))
    parser.add_argument("--provider", default=_env("HERMES_HARNESS_PROVIDER", "MODEL_PROVIDER"))
    parser.add_argument("--base-url", default=_env("HERMES_HARNESS_BASE_URL", "OPENAI_BASE_URL"))
    parser.add_argument("--api-key", default=_env("HERMES_HARNESS_API_KEY", "OPENAI_API_KEY"))
    parser.add_argument("--max-iterations", type=int, default=int(_env("HERMES_HARNESS_MAX_ITERATIONS", default="30")))
    parser.add_argument("--no-deliver", action="store_true", help="Do not send the final response to Lark.")
    return parser


def main() -> int:
    from hermes_cli.env_loader import load_hermes_dotenv
    from hermes_constants import get_hermes_home

    load_hermes_dotenv(hermes_home=get_hermes_home(), project_env=ROOT / ".env")
    parser = _build_parser()
    args = parser.parse_args()
    prompt = " ".join(args.prompt).strip() or "Find Abhishek Verma in Lark contacts and return the matched name and email."
    if not args.company_id:
        parser.error("--company-id or HERMES_COMPANY_ID is required")
    if not args.lark_open_id:
        parser.error("--lark-open-id is required")

    identity = _resolve_identity(
        company_id=args.company_id,
        lark_open_id=args.lark_open_id,
        company_user_id=args.company_user_id,
        channel_identity_id=args.channel_identity_id,
        company_role=args.company_role,
        department_id=args.department_id,
    )

    from gateway.session_context import clear_session_vars, set_current_session_id, set_session_vars
    from run_agent import AIAgent

    session_id = f"lark-harness-{uuid.uuid4()}"
    session_key = f"lark:{args.chat_id}:{args.lark_open_id}"

    print("=== hermes lark engine harness ===")
    print(f"company: {identity['company_id']}")
    print(f"user:    {identity.get('display_name') or identity['lark_open_id']} ({identity['lark_open_id']})")
    print(f"chatId:  {args.chat_id}")
    print(f"model:   {args.provider or '<config>'}/{args.model or '<config>'}")
    print(f"prompt:  {prompt!r}")
    print()

    tokens = set_session_vars(
        platform="lark",
        chat_id=args.chat_id,
        chat_name=args.chat_name,
        user_id=args.lark_open_id,
        user_name=identity.get("display_name") or "",
        session_key=session_key,
        company_id=identity["company_id"],
        company_user_id=identity["company_user_id"],
        channel_identity_id=identity["channel_identity_id"],
        company_role=identity["company_role"],
        department_id=identity["department_id"],
        cwd=str(Path.cwd()),
    )
    set_current_session_id(session_id)
    try:
        agent = AIAgent(
            provider=args.provider or None,
            model=args.model or "",
            base_url=args.base_url or None,
            api_key=args.api_key or None,
            enabled_toolsets=["lark"],
            max_iterations=args.max_iterations,
            quiet_mode=False,
            skip_context_files=True,
            skip_memory=True,
            platform="lark",
            user_id=args.lark_open_id,
            user_name=identity.get("display_name") or "",
            chat_id=args.chat_id,
            chat_name=args.chat_name,
            session_id=session_id,
        )
        result = agent.run_conversation(
            prompt,
            system_message=(
                "You are running inside the Hermes Lark harness. Use native Lark tools for Lark "
                "workspace actions. Respond in English only unless the user explicitly requests another language; "
                "do not answer in Chinese unless the user explicitly asks for Chinese. "
                f"The current Lark chat id is {args.chat_id}; if the user says current chat, this chat, "
                "or here, use this chat id directly and do not search/list chats to infer it. "
                "Return concrete IDs and URLs from tool results. If the prompt is read-only, do not use write "
                "operations such as sending messages, creating tasks, creating calendar events, or editing documents."
            ),
        )
        final_response = str(result.get("final_response") or "")
        print("=== agent done ===")
        print(final_response)
        print()
        if not final_response.strip():
            print("No final response was produced; skipping Lark delivery.")
            return 1
        if not args.no_deliver:
            if not args.chat_id:
                raise RuntimeError("Cannot deliver without --chat-id")
            delivery = _deliver_to_lark(args.chat_id, final_response)
            print("=== lark delivery ===")
            print(json.dumps(delivery, ensure_ascii=False, indent=2))
            if delivery.get("success") is False or delivery.get("error"):
                return 2
        return 0
    finally:
        clear_session_vars(tokens)
        set_current_session_id("")


if __name__ == "__main__":
    raise SystemExit(main())
