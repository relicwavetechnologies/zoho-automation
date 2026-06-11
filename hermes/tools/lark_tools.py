"""Hermes-native Lark messaging tool on per-company (or env) app credentials.

Credentials resolved per company from the runtime vault (see
``tools/lark_runtime.py``); ``company_id`` injected at dispatch (T3.1).
A representative messaging tool — the other Lark families (doc/base/calendar/
contacts/task/approval) follow the identical client pattern.
"""

from __future__ import annotations

import json
from typing import Any

from tools.registry import registry, tool_error, tool_result

LARK_MESSAGING_OPS = {"send", "list_chats"}
_RECEIVE_ID_TYPES = {"open_id", "user_id", "union_id", "email", "chat_id"}


def _check() -> bool:
    """Available in enterprise mode (per-company config or LARK_APP_* env)."""
    try:
        import os

        from tools.lark_runtime import enterprise_enabled

        has_env = bool((os.getenv("LARK_APP_ID") or "").strip() and (os.getenv("LARK_APP_SECRET") or "").strip())
        return enterprise_enabled() and has_env
    except Exception:  # noqa: BLE001
        return False


LARK_MESSAGING_SCHEMA = {
    "name": "lark_messaging",
    "description": (
        "Send Lark/Feishu messages and list the bot's chats. Operations: send "
        "(text to a user or chat), list_chats."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_MESSAGING_OPS)},
            "receiveId": {"type": "string", "description": "open_id / chat_id / email of the recipient."},
            "receiveIdType": {"type": "string", "enum": sorted(_RECEIVE_ID_TYPES)},
            "text": {"type": "string"},
            "maxResults": {"type": "integer", "minimum": 1, "maximum": 100},
        },
        "required": ["op"],
    },
}


async def _handle_lark_messaging(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in LARK_MESSAGING_OPS:
        return tool_error(f"Unknown lark_messaging operation: {op}", success=False)
    try:
        from tools.lark_runtime import resolve_tool_client

        client = resolve_tool_client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)

    try:
        if op == "send":
            receive_id = str(args.get("receiveId") or "").strip()
            text = str(args.get("text") or "")
            if not receive_id:
                return tool_error("receiveId is required for send", success=False, operation=op)
            receive_id_type = str(args.get("receiveIdType") or "open_id").strip()
            if receive_id_type not in _RECEIVE_ID_TYPES:
                receive_id_type = "open_id"
            data = await client.request(
                "POST",
                "/open-apis/im/v1/messages",
                params={"receive_id_type": receive_id_type},
                json_body={
                    "receive_id": receive_id,
                    "msg_type": "text",
                    "content": json.dumps({"text": text}),
                },
            )
            return tool_result(
                {"success": True, "message": "Message sent.", "messageId": (data or {}).get("message_id")}
            )

        if op == "list_chats":
            page_size = max(1, min(100, int(args.get("maxResults") or 20)))
            data = await client.request(
                "GET", "/open-apis/im/v1/chats", params={"page_size": page_size}
            )
            chats = (data or {}).get("items", [])
            return tool_result(
                {
                    "success": True,
                    "message": f"Found {len(chats)} chat(s).",
                    "data": [
                        {"chat_id": c.get("chat_id"), "name": c.get("name"), "description": c.get("description")}
                        for c in chats
                    ],
                }
            )

        return tool_error(f"Unhandled lark_messaging operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


registry.register(
    name="lark_messaging",
    toolset="lark",
    schema=LARK_MESSAGING_SCHEMA,
    handler=_handle_lark_messaging,
    check_fn=_check,
    is_async=True,
    emoji="💬",
    max_result_size_chars=100_000,
)
