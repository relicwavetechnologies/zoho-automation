"""Normalize agent message dicts for enterprise session persistence."""

from __future__ import annotations

import json
from typing import Any, Mapping


def flatten_message_content(content: Any) -> str | None:
    """Return text suitable for RuntimeConversationMessage.contentText."""
    if content is None:
        return None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text", "")))
            elif isinstance(part, dict) and part.get("type") in {
                "image",
                "image_url",
                "input_image",
            }:
                parts.append("[screenshot]")
        return "\n".join(parts) if parts else None
    return str(content)


def extract_tool_calls(msg: Mapping[str, Any]) -> list[dict[str, Any]] | None:
    tool_calls = msg.get("tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        return None
    normalized: list[dict[str, Any]] = []
    for item in tool_calls:
        if isinstance(item, dict):
            if "function" in item and isinstance(item["function"], dict):
                normalized.append(
                    {
                        "name": item["function"].get("name"),
                        "arguments": item["function"].get("arguments"),
                    }
                )
            else:
                normalized.append(dict(item))
        else:
            fn = getattr(item, "function", None)
            if fn is not None:
                normalized.append(
                    {
                        "name": getattr(fn, "name", None),
                        "arguments": getattr(fn, "arguments", None),
                    }
                )
    return normalized or None


def message_row_to_api_dict(row: Mapping[str, Any], *, session_id: str) -> dict[str, Any]:
    """Map a RuntimeConversationMessage row to SessionDB-compatible API shape."""
    tool_calls = None
    raw_tool = row.get("toolCallJson")
    if raw_tool:
        if isinstance(raw_tool, str):
            try:
                raw_tool = json.loads(raw_tool)
            except (json.JSONDecodeError, TypeError):
                raw_tool = None
        if isinstance(raw_tool, dict) and raw_tool.get("calls"):
            tool_calls = raw_tool.get("calls")
        elif isinstance(raw_tool, list):
            tool_calls = raw_tool

    created_at = row.get("createdAt")
    timestamp = created_at.timestamp() if hasattr(created_at, "timestamp") else created_at

    return {
        "id": row.get("sequence"),
        "session_id": session_id,
        "role": row.get("role") or "unknown",
        "content": row.get("contentText"),
        "timestamp": timestamp,
        "tool_name": None,
        "tool_calls": tool_calls,
        "tool_call_id": row.get("toolCallId"),
        "finish_reason": row.get("finishReason"),
        "active": 1 if row.get("active", True) else 0,
    }


def prepare_message_for_insert(
    msg: Mapping[str, Any],
    *,
    role: str,
) -> tuple[str | None, dict[str, Any], dict[str, Any] | None, str | None]:
    content = flatten_message_content(msg.get("content"))
    tool_calls = extract_tool_calls(msg)
    tool_json = {"calls": tool_calls} if tool_calls else {}
    content_json = dict(msg)
    tool_call_id = str(msg.get("tool_call_id") or "") or None
    return content, content_json, tool_json or None, tool_call_id
