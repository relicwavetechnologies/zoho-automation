"""Hermes-native Lark/Feishu tools on per-company (or env) app credentials.

Full Divo-level Lark surface ported natively onto the runtime credential vault:
messaging, doc, base (bitable), calendar, contacts, task, approval. Credentials
resolve per company (see ``tools/lark_runtime.py``); ``company_id`` is injected
at dispatch (T3.1). All families share the tenant-token ``LarkClient``.

People resolution (name → open_id) is handled from Hermes company identity for
the high-traffic operations where Divo users naturally mention teammates by
name: tasks, DMs/mentions, and calendar attendees/free-busy.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from tools.registry import registry, tool_error, tool_result


def _check() -> bool:
    """Available when company-mode Lark runtime credentials can be resolved."""
    try:
        from tools.lark_runtime import lark_tools_available

        return lark_tools_available()
    except Exception:  # noqa: BLE001
        return False


def _client(kwargs: dict):
    """Resolve the LarkClient for a handler (raises on no creds)."""
    from tools.lark_runtime import resolve_tool_client

    return resolve_tool_client(kwargs)


def _iso_to_epoch(value: str) -> int:
    s = (value or "").strip()
    if not s:
        raise ValueError("empty datetime")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _epoch_to_iso(ts: Any) -> str:
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
    except Exception:  # noqa: BLE001
        return ""


def _members(ids: Any, role: str) -> list[dict[str, str]]:
    return [{"id": str(i), "type": "user", "role": role} for i in (ids or []) if str(i).strip()]


# ── Messaging ───────────────────────────────────────────────────────────────

LARK_MESSAGING_OPS = {"send", "list", "get", "reply", "send_dm", "list_chats", "search", "mention"}
_RECEIVE_ID_TYPES = {"open_id", "user_id", "union_id", "email", "chat_id"}

LARK_MESSAGING_SCHEMA = {
    "name": "lark_messaging",
    "description": "Send, reply, DM, mention, list/search messages, and list chats in Lark/Feishu.",
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_MESSAGING_OPS)},
            "chatId": {"type": "string", "description": "Target chat ID for send/list/search/mention."},
            "messageId": {"type": "string", "description": "Message ID for get/reply."},
            "receiveId": {"type": "string", "description": "open_id / chat_id / email of the recipient."},
            "receiveIdType": {"type": "string", "enum": sorted(_RECEIVE_ID_TYPES)},
            "text": {"type": "string"},
            "recipientName": {"type": "string", "description": "Human-readable Lark user name for send_dm."},
            "query": {"type": "string", "description": "Search query for message search."},
            "mentionNames": {"type": "array", "items": {"type": "string"}},
            "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            "maxResults": {"type": "integer", "minimum": 1, "maximum": 100},
        },
        "required": ["op"],
    },
}


def _message_id(data: dict[str, Any]) -> str | None:
    message = data.get("message") if isinstance(data.get("message"), dict) else {}
    return data.get("message_id") or message.get("message_id")


def _text_message_content(text: str) -> str:
    return json.dumps({"text": text})


def _parse_message_text(message: dict[str, Any]) -> str:
    body = message.get("body")
    if isinstance(body, dict):
        raw = body.get("content")
    else:
        raw = body
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return str(parsed.get("text") or parsed.get("content") or "")
        except json.JSONDecodeError:
            return raw
    return ""


def _norm_message(message: dict[str, Any]) -> dict[str, Any]:
    sender = message.get("sender") if isinstance(message.get("sender"), dict) else {}
    return {
        "messageId": message.get("message_id") or message.get("messageId") or message.get("id"),
        "text": _parse_message_text(message),
        "senderId": sender.get("id") or sender.get("sender_id") or message.get("sender_id"),
        "timestamp": message.get("create_time") or message.get("update_time") or message.get("timestamp"),
    }


def _limit_arg(args: dict[str, Any], *, default: int, maximum: int) -> int:
    try:
        return max(1, min(maximum, int(args.get("limit") or args.get("maxResults") or default)))
    except (TypeError, ValueError):
        return default


async def _handle_lark_messaging(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in LARK_MESSAGING_OPS:
        return tool_error(f"Unknown lark_messaging operation: {op}", success=False)
    try:
        client = _client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)
    try:
        if op == "send":
            receive_id = str(args.get("chatId") or args.get("receiveId") or "").strip()
            if not receive_id:
                return tool_error("chatId or receiveId is required for send", success=False, operation=op)
            receive_id_type = str(args.get("receiveIdType") or "chat_id").strip()
            if receive_id_type not in _RECEIVE_ID_TYPES:
                receive_id_type = "chat_id"
            data = await client.request(
                "POST",
                "/open-apis/im/v1/messages",
                params={"receive_id_type": receive_id_type},
                json_body={
                    "receive_id": receive_id,
                    "msg_type": "text",
                    "content": _text_message_content(str(args.get("text") or "")),
                },
            )
            return tool_result({"success": True, "message": "Message sent.", "messageId": _message_id(data or {})})
        if op == "reply":
            message_id = str(args.get("messageId") or "").strip()
            text = str(args.get("text") or "")
            if not message_id or not text:
                return tool_error("messageId and text are required for reply", success=False, operation=op)
            data = await client.request(
                "POST",
                f"/open-apis/im/v1/messages/{message_id}/reply",
                json_body={"msg_type": "text", "content": _text_message_content(text)},
            )
            return tool_result({"success": True, "message": "Reply sent.", "messageId": _message_id(data or {})})
        if op == "send_dm":
            text = str(args.get("text") or "")
            if not text:
                return tool_error("text is required for send_dm", success=False, operation=op)
            open_id = str(args.get("receiveId") or args.get("chatId") or "").strip()
            if not open_id and args.get("recipientName"):
                resolved = _resolve_lark_people(
                    company_id=_company_id(kwargs),
                    queries=[str(args["recipientName"])],
                    requester_open_id=_session_lark_user_id(kwargs),
                )
                if resolved["ambiguous"]:
                    detail = "; ".join(
                        f"\"{item['query']}\" -> "
                        + " / ".join(str(match.get("displayName") or match.get("openId")) for match in item["matches"])
                        for item in resolved["ambiguous"]
                    )
                    return tool_error(f"Ambiguous recipient - please clarify: {detail}", success=False, operation=op)
                if resolved["notFound"] or not resolved["resolved"]:
                    return tool_error(f"Could not find Lark user: {args['recipientName']}", success=False, operation=op)
                open_id = str(resolved["resolved"][0]["openId"])
            if not open_id:
                return tool_error("recipientName or receiveId/open_id is required for send_dm", success=False, operation=op)
            data = await client.request(
                "POST",
                "/open-apis/im/v1/messages",
                params={"receive_id_type": "open_id"},
                json_body={"receive_id": open_id, "msg_type": "text", "content": _text_message_content(text)},
            )
            return tool_result({"success": True, "message": "DM sent.", "messageId": _message_id(data or {})})
        if op == "mention":
            chat_id = str(args.get("chatId") or args.get("receiveId") or "").strip()
            text = str(args.get("text") or "")
            names = [str(item).strip() for item in (args.get("mentionNames") or []) if str(item).strip()]
            if not chat_id or not text or not names:
                return tool_error("chatId, text, and mentionNames are required for mention", success=False, operation=op)
            resolved = _resolve_lark_people(
                company_id=_company_id(kwargs),
                queries=names,
                requester_open_id=_session_lark_user_id(kwargs),
            )
            if resolved["notFound"]:
                return tool_error(f"Could not find: {', '.join(resolved['notFound'])}", success=False, operation=op)
            if resolved["ambiguous"]:
                detail = "; ".join(
                    f"\"{item['query']}\" -> "
                    + " / ".join(str(match.get("displayName") or match.get("openId")) for match in item["matches"])
                    for item in resolved["ambiguous"]
                )
                return tool_error(f"Ambiguous names: {detail}", success=False, operation=op)
            elements: list[dict[str, Any]] = []
            for person in resolved["resolved"]:
                elements.append({"tag": "at", "user_id": person["openId"]})
                elements.append({"tag": "text", "text": " "})
            elements.append({"tag": "text", "text": text})
            data = await client.request(
                "POST",
                "/open-apis/im/v1/messages",
                params={"receive_id_type": "chat_id"},
                json_body={
                    "receive_id": chat_id,
                    "msg_type": "post",
                    "content": json.dumps({"zh_cn": {"title": "", "content": [elements]}}),
                },
            )
            return tool_result({"success": True, "message": f"Message sent with {len(resolved['resolved'])} mention(s).", "messageId": _message_id(data or {})})
        if op == "list":
            chat_id = str(args.get("chatId") or "").strip()
            if not chat_id:
                return tool_error("chatId is required for list", success=False, operation=op)
            limit = _limit_arg(args, default=20, maximum=50)
            data = await client.request(
                "GET",
                "/open-apis/im/v1/messages",
                params={"container_id_type": "chat", "container_id": chat_id, "page_size": limit},
            )
            messages = [_norm_message(item) for item in (data or {}).get("items", [])]
            return tool_result({"success": True, "message": f"Found {len(messages)} messages.", "data": messages})
        if op == "get":
            message_id = str(args.get("messageId") or "").strip()
            if not message_id:
                return tool_error("messageId is required for get", success=False, operation=op)
            data = await client.request("GET", f"/open-apis/im/v1/messages/{message_id}")
            items = (data or {}).get("items", [])
            message = items[0] if items else (data or {}).get("message", data)
            return tool_result({"success": True, "data": _norm_message(message if isinstance(message, dict) else {})})
        if op == "search":
            chat_id = str(args.get("chatId") or "").strip()
            query = str(args.get("query") or "").strip()
            if not chat_id or not query:
                return tool_error("chatId and query are required for search", success=False, operation=op)
            limit = _limit_arg(args, default=20, maximum=50)
            data = await client.request(
                "GET",
                "/open-apis/im/v1/messages",
                params={"container_id_type": "chat", "container_id": chat_id, "query": query, "page_size": limit},
            )
            messages = [_norm_message(item) for item in (data or {}).get("items", [])]
            return tool_result({"success": True, "message": f"Found {len(messages)} messages.", "data": messages})
        if op == "list_chats":
            page_size = _limit_arg(args, default=20, maximum=100)
            data = await client.request("GET", "/open-apis/im/v1/chats", params={"page_size": page_size})
            chats = (data or {}).get("items", [])
            return tool_result({
                "success": True,
                "message": f"Found {len(chats)} chat(s).",
                "data": [{"chat_id": c.get("chat_id"), "name": c.get("name"), "type": c.get("chat_type"), "memberCount": c.get("member_count"), "description": c.get("description")} for c in chats],
            })
        return tool_error(f"Unhandled lark_messaging operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# ── Doc (Docx v1) ────────────────────────────────────────────────────────────

LARK_DOC_OPS = {"get", "create", "list_blocks", "append_block", "update_block", "delete_block", "insert_table", "share"}
_BLOCK_TYPES = {"text": 2, "heading1": 3, "heading2": 4, "heading3": 5, "bullet": 12, "code": 14}
_SHARE_VISIBILITY = {
    "anyone": ("open", "anyone_readable"),
    "tenant": ("close", "tenant_readable"),
    "specified": ("close", "specified_external_accessible"),
}

LARK_DOC_SCHEMA = {
    "name": "lark_doc",
    "description": (
        "Lark/Feishu Docx documents. Operations: get (metadata + plain text), create, list_blocks, "
        "append_block, update_block, delete_block, insert_table, share."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_DOC_OPS)},
            "docToken": {"type": "string"},
            "title": {"type": "string"},
            "blockId": {"type": "string"},
            "content": {"type": "string"},
            "blockType": {"type": "string", "enum": sorted(_BLOCK_TYPES)},
            "rows": {"type": "integer", "minimum": 1},
            "cols": {"type": "integer", "minimum": 1},
            "visibility": {"type": "string", "enum": sorted(_SHARE_VISIBILITY)},
        },
        "required": ["op"],
    },
}


def _text_children(content: str, block_type: int) -> dict[str, Any]:
    return {"block_type": block_type, "text": {"elements": [{"text_run": {"content": content}}], "style": {}}}


async def _handle_lark_doc(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in LARK_DOC_OPS:
        return tool_error(f"Unknown lark_doc operation: {op}", success=False)
    try:
        client = _client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)
    try:
        if op == "create":
            title = str(args.get("title") or "").strip()
            if not title:
                return tool_error("title is required for create", success=False, operation=op)
            data = await client.request("POST", "/open-apis/docx/v1/documents", json_body={"title": title})
            doc = (data or {}).get("document", {})
            return tool_result({"success": True, "docToken": doc.get("document_id"), "data": doc})

        doc_token = str(args.get("docToken") or "").strip()
        if not doc_token:
            return tool_error("docToken is required", success=False, operation=op)

        if op == "get":
            meta = await client.request("GET", f"/open-apis/docx/v1/documents/{doc_token}")
            raw = await client.request("GET", f"/open-apis/docx/v1/documents/{doc_token}/raw_content")
            return tool_result({
                "success": True,
                "data": {"document": (meta or {}).get("document", meta), "content": (raw or {}).get("content", "")},
            })
        if op == "list_blocks":
            data = await client.request("GET", f"/open-apis/docx/v1/documents/{doc_token}/blocks")
            return tool_result({"success": True, "data": (data or {}).get("items", [])})
        if op == "append_block":
            content = str(args.get("content") or "")
            block_type = _BLOCK_TYPES.get(str(args.get("blockType") or "text"), 2)
            await client.request(
                "POST",
                f"/open-apis/docx/v1/documents/{doc_token}/blocks/{doc_token}/children",
                json_body={"children": [_text_children(content, block_type)], "document_revision_id": -1},
            )
            return tool_result({"success": True, "message": "Block appended."})
        if op == "update_block":
            block_id = str(args.get("blockId") or "").strip()
            if not block_id:
                return tool_error("blockId is required for update_block", success=False, operation=op)
            block_type = _BLOCK_TYPES.get(str(args.get("blockType") or "text"), 2)
            await client.request(
                "PATCH",
                f"/open-apis/docx/v1/documents/{doc_token}/blocks/{block_id}",
                json_body={
                    "block_type": block_type,
                    "update_text_elements": {"elements": [{"text_run": {"content": str(args.get("content") or "")}}]},
                    "document_revision_id": -1,
                },
            )
            return tool_result({"success": True, "message": "Block updated."})
        if op == "delete_block":
            block_id = str(args.get("blockId") or "").strip()
            if not block_id:
                return tool_error("blockId is required for delete_block", success=False, operation=op)
            await client.request(
                "DELETE",
                f"/open-apis/docx/v1/documents/{doc_token}/blocks/{block_id}/children/batch_delete",
                json_body={"document_revision_id": -1},
            )
            return tool_result({"success": True, "message": "Block deleted."})
        if op == "insert_table":
            rows = int(args.get("rows") or 0)
            cols = int(args.get("cols") or 0)
            if rows < 1 or cols < 1:
                return tool_error("rows and cols are required for insert_table", success=False, operation=op)
            parent = str(args.get("blockId") or "").strip() or doc_token
            await client.request(
                "POST",
                f"/open-apis/docx/v1/documents/{doc_token}/blocks/{parent}/children",
                json_body={
                    "children": [{"block_type": 31, "table": {"property": {"row_size": rows, "column_size": cols}, "cells": rows * cols}}],
                    "document_revision_id": -1,
                },
            )
            return tool_result({"success": True, "message": "Table inserted."})
        if op == "share":
            vis = str(args.get("visibility") or "").strip()
            if vis not in _SHARE_VISIBILITY:
                return tool_error("visibility must be anyone|tenant|specified", success=False, operation=op)
            ext, sec = _SHARE_VISIBILITY[vis]
            await client.request(
                "PATCH",
                f"/open-apis/drive/v2/permissions/{doc_token}/public",
                params={"type": "docx"},
                json_body={"external_access_entity": ext, "security_entity": sec},
            )
            return tool_result({"success": True, "message": f"Document shared ({vis})."})
        return tool_error(f"Unhandled lark_doc operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# ── Base (Bitable v1) ────────────────────────────────────────────────────────

LARK_BASE_OPS = {"list_records", "get_record", "create_record", "update_record", "delete_record", "search_records"}

LARK_BASE_SCHEMA = {
    "name": "lark_base",
    "description": "Lark/Feishu Base (Bitable) records. Operations: list_records, get_record, create_record, update_record, delete_record, search_records.",
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_BASE_OPS)},
            "appToken": {"type": "string"},
            "tableId": {"type": "string"},
            "recordId": {"type": "string"},
            "fields": {"type": "object", "additionalProperties": True},
            "fieldName": {"type": "string"},
            "filterValue": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        },
        "required": ["op", "appToken", "tableId"],
    },
}


async def _handle_lark_base(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in LARK_BASE_OPS:
        return tool_error(f"Unknown lark_base operation: {op}", success=False)
    app_token = str(args.get("appToken") or "").strip()
    table_id = str(args.get("tableId") or "").strip()
    if not app_token or not table_id:
        return tool_error("appToken and tableId are required", success=False, operation=op)
    try:
        client = _client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)
    base = f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records"
    try:
        if op == "list_records":
            limit = max(1, min(100, int(args.get("limit") or 20)))
            data = await client.request("GET", base, params={"page_size": limit})
            return tool_result({"success": True, "data": (data or {}).get("items", [])})
        if op == "get_record":
            rid = str(args.get("recordId") or "").strip()
            if not rid:
                return tool_error("recordId is required", success=False, operation=op)
            data = await client.request("GET", f"{base}/{rid}")
            return tool_result({"success": True, "data": (data or {}).get("record", data)})
        if op == "create_record":
            fields = args.get("fields")
            if not isinstance(fields, dict) or not fields:
                return tool_error("fields are required for create_record", success=False, operation=op)
            data = await client.request("POST", base, json_body={"fields": fields})
            rec = (data or {}).get("record", {})
            return tool_result({"success": True, "recordId": rec.get("record_id"), "data": rec})
        if op == "update_record":
            rid = str(args.get("recordId") or "").strip()
            fields = args.get("fields")
            if not rid or not isinstance(fields, dict) or not fields:
                return tool_error("recordId and fields are required", success=False, operation=op)
            data = await client.request("PUT", f"{base}/{rid}", json_body={"fields": fields})
            return tool_result({"success": True, "data": (data or {}).get("record", data)})
        if op == "delete_record":
            rid = str(args.get("recordId") or "").strip()
            if not rid:
                return tool_error("recordId is required", success=False, operation=op)
            await client.request("DELETE", f"{base}/{rid}")
            return tool_result({"success": True, "message": "Record deleted."})
        if op == "search_records":
            field_name = str(args.get("fieldName") or "").strip()
            value = str(args.get("filterValue") or "").strip()
            if not field_name or not value:
                return tool_error("fieldName and filterValue are required for search_records", success=False, operation=op)
            limit = max(1, min(100, int(args.get("limit") or 20)))
            data = await client.request(
                "POST",
                f"{base}/search",
                params={"page_size": limit},
                json_body={"filter": {"conjunction": "and", "conditions": [{"field_name": field_name, "operator": "contains", "value": [value]}]}},
            )
            return tool_result({"success": True, "data": (data or {}).get("items", [])})
        return tool_error(f"Unhandled lark_base operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# ── Calendar (Calendar v4) ───────────────────────────────────────────────────

LARK_CALENDAR_OPS = {
    "list",
    "get",
    "create",
    "create_recurring",
    "update",
    "delete",
    "free_busy",
    "list_attendees",
    "update_attendees",
}

LARK_CALENDAR_SCHEMA = {
    "name": "lark_calendar",
    "description": (
        "Lark/Feishu Calendar. Operations: list, get, create, create_recurring, update, delete, "
        "free_busy, list_attendees, update_attendees. Times are ISO 8601. Use attendeeNames/names "
        "for teammate lookup, or raw open_id arrays when already known."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_CALENDAR_OPS)},
            "calendarId": {"type": "string", "description": "Defaults to 'primary'."},
            "eventId": {"type": "string"},
            "title": {"type": "string"},
            "description": {"type": "string"},
            "startTime": {"type": "string", "description": "ISO 8601."},
            "endTime": {"type": "string", "description": "ISO 8601."},
            "attendeeIds": {"type": "array", "items": {"type": "string"}},
            "attendeeNames": {"type": "array", "items": {"type": "string"}},
            "removeAttendeeIds": {"type": "array", "items": {"type": "string"}},
            "addNames": {"type": "array", "items": {"type": "string"}},
            "removeNames": {"type": "array", "items": {"type": "string"}},
            "userIds": {"type": "array", "items": {"type": "string"}},
            "names": {"type": "array", "items": {"type": "string"}},
            "dateFrom": {"type": "string"},
            "dateTo": {"type": "string"},
            "recurrence": {"type": "object", "additionalProperties": True},
            "limit": {"type": "integer", "minimum": 1, "maximum": 50},
        },
        "required": ["op"],
    },
}


def _cal_time(iso: str) -> dict[str, str]:
    return {"timestamp": str(_iso_to_epoch(iso)), "timezone": "UTC"}


def _norm_event(ev: dict[str, Any]) -> dict[str, Any]:
    return {
        "eventId": ev.get("event_id") or ev.get("id"),
        "summary": ev.get("summary") or ev.get("title"),
        "startTime": _epoch_to_iso((ev.get("start_time") or {}).get("timestamp")),
        "endTime": _epoch_to_iso((ev.get("end_time") or {}).get("timestamp")),
    }


def _build_rrule(recurrence: Any) -> str:
    if not isinstance(recurrence, dict):
        raise ValueError("recurrence is required for create_recurring")
    freq = str(recurrence.get("frequency") or "").strip().upper()
    if freq not in {"DAILY", "WEEKLY", "MONTHLY", "YEARLY"}:
        raise ValueError("recurrence.frequency must be DAILY, WEEKLY, MONTHLY, or YEARLY")
    rule = f"RRULE:FREQ={freq}"
    days = [str(day).strip().upper() for day in (recurrence.get("daysOfWeek") or recurrence.get("byDay") or []) if str(day).strip()]
    if days:
        allowed = {"MO", "TU", "WE", "TH", "FR", "SA", "SU"}
        invalid = [day for day in days if day not in allowed]
        if invalid:
            raise ValueError(f"Invalid recurrence weekday(s): {', '.join(invalid)}")
        rule += f";BYDAY={','.join(days)}"
    if recurrence.get("count"):
        rule += f";COUNT={int(recurrence['count'])}"
    elif recurrence.get("until"):
        until = str(recurrence["until"]).strip()
        if until.endswith("Z"):
            until_dt = datetime.fromisoformat(until[:-1] + "+00:00")
        else:
            until_dt = datetime.fromisoformat(until)
            if until_dt.tzinfo is None:
                until_dt = until_dt.replace(tzinfo=timezone.utc)
        rule += f";UNTIL={until_dt.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    return rule


def _calendar_user_ids(args: dict[str, Any], kwargs: dict[str, Any], *, id_key: str, names_key: str) -> list[str]:
    ids = [str(item).strip() for item in (args.get(id_key) or []) if str(item).strip()]
    if ids:
        return ids
    names = [str(item).strip() for item in (args.get(names_key) or []) if str(item).strip()]
    if not names:
        return []
    resolved = _resolve_lark_people(
        company_id=_company_id(kwargs),
        queries=names,
        requester_open_id=_session_lark_user_id(kwargs),
    )
    if resolved["notFound"]:
        raise ValueError(f"Could not find Lark users: {', '.join(resolved['notFound'])}")
    if resolved["ambiguous"]:
        detail = "; ".join(
            f"\"{item['query']}\" -> "
            + " / ".join(str(match.get("displayName") or match.get("openId")) for match in item["matches"])
            for item in resolved["ambiguous"]
        )
        raise ValueError(f"Ambiguous names - please clarify: {detail}")
    return [str(person["openId"]) for person in resolved["resolved"]]


def _calendar_attendee_ids(
    args: dict[str, Any],
    kwargs: dict[str, Any],
    *,
    default_include_requester: bool = False,
) -> list[str]:
    ids = _calendar_user_ids(args, kwargs, id_key="attendeeIds", names_key="attendeeNames")
    requester = _session_lark_user_id(kwargs)
    if default_include_requester and requester and requester not in ids:
        ids.append(requester)
    return ids


async def _handle_lark_calendar(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in LARK_CALENDAR_OPS:
        return tool_error(f"Unknown lark_calendar operation: {op}", success=False)
    try:
        client = _client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)
    cal = str(args.get("calendarId") or "primary").strip() or "primary"
    base = f"/open-apis/calendar/v4/calendars/{cal}"
    try:
        if op == "list":
            limit = max(1, min(50, int(args.get("limit") or 50)))
            # Lark's events endpoint requires a start_time/end_time window
            # (Unix seconds) AND page_size >= 50. Request the API minimum and
            # slice client-side to the caller's limit.
            now = int(datetime.now(timezone.utc).timestamp())
            start = _iso_to_epoch(str(args["dateFrom"])) if args.get("dateFrom") else now
            end = _iso_to_epoch(str(args["dateTo"])) if args.get("dateTo") else now + 30 * 24 * 3600
            data = await client.request(
                "GET",
                f"{base}/events",
                params={"page_size": 50, "start_time": str(start), "end_time": str(end)},
            )
            events = [_norm_event(e) for e in (data or {}).get("items", [])]
            return tool_result({"success": True, "data": events[:limit]})
        if op == "get":
            eid = str(args.get("eventId") or "").strip()
            if not eid:
                return tool_error("eventId is required", success=False, operation=op)
            data = await client.request("GET", f"{base}/events/{eid}")
            return tool_result({"success": True, "data": _norm_event((data or {}).get("event", {}))})
        if op == "create":
            title = str(args.get("title") or "").strip()
            start, end = str(args.get("startTime") or ""), str(args.get("endTime") or "")
            if not title or not start or not end:
                return tool_error("title, startTime, endTime are required for create", success=False, operation=op)
            body: dict[str, Any] = {"summary": title, "start_time": _cal_time(start), "end_time": _cal_time(end)}
            if args.get("description"):
                body["description"] = str(args["description"])
            attendee_ids = _calendar_attendee_ids(args, kwargs, default_include_requester=True)
            if attendee_ids:
                body["attendees"] = [{"type": "user", "user_id": str(a)} for a in attendee_ids]
            data = await client.request("POST", f"{base}/events", json_body=body)
            return tool_result({"success": True, "eventId": (data or {}).get("event", {}).get("event_id")})
        if op == "create_recurring":
            title = str(args.get("title") or "").strip()
            start, end = str(args.get("startTime") or ""), str(args.get("endTime") or "")
            if not title or not start or not end:
                return tool_error("title, startTime, endTime are required for create_recurring", success=False, operation=op)
            body = {
                "summary": title,
                "start_time": _cal_time(start),
                "end_time": _cal_time(end),
                "recurrence": [_build_rrule(args.get("recurrence"))],
            }
            if args.get("description"):
                body["description"] = str(args["description"])
            attendee_ids = _calendar_attendee_ids(args, kwargs, default_include_requester=True)
            if attendee_ids:
                body["attendees"] = [{"type": "user", "user_id": str(a)} for a in attendee_ids]
            data = await client.request("POST", f"{base}/events", json_body=body)
            return tool_result({"success": True, "eventId": (data or {}).get("event", {}).get("event_id")})
        if op == "update":
            eid = str(args.get("eventId") or "").strip()
            if not eid:
                return tool_error("eventId is required", success=False, operation=op)
            body = {}
            if args.get("title"):
                body["summary"] = str(args["title"])
            if args.get("startTime"):
                body["start_time"] = _cal_time(str(args["startTime"]))
            if args.get("endTime"):
                body["end_time"] = _cal_time(str(args["endTime"]))
            await client.request("PATCH", f"{base}/events/{eid}", json_body=body)
            return tool_result({"success": True, "message": "Event updated."})
        if op == "delete":
            eid = str(args.get("eventId") or "").strip()
            if not eid:
                return tool_error("eventId is required", success=False, operation=op)
            await client.request("DELETE", f"{base}/events/{eid}")
            return tool_result({"success": True, "message": "Event deleted."})
        if op == "free_busy":
            user_ids = _calendar_user_ids(args, kwargs, id_key="userIds", names_key="names")
            d_from, d_to = str(args.get("dateFrom") or ""), str(args.get("dateTo") or "")
            if not user_ids or not d_from or not d_to:
                return tool_error("userIds or names, dateFrom, dateTo are required for free_busy", success=False, operation=op)
            out: dict[str, Any] = {}
            for uid in user_ids:
                data = await client.request(
                    "POST",
                    "/open-apis/calendar/v4/freebusy/list",
                    json_body={"time_min": d_from, "time_max": d_to, "user_id": str(uid), "user_id_type": "open_id", "only_busy": True},
                )
                out[str(uid)] = {"busy": [{"start": b.get("start_time"), "end": b.get("end_time")} for b in (data or {}).get("freebusy_list", [])]}
            return tool_result({"success": True, "data": out})
        if op == "list_attendees":
            eid = str(args.get("eventId") or "").strip()
            if not eid:
                return tool_error("eventId is required", success=False, operation=op)
            data = await client.request("GET", f"{base}/events/{eid}/attendees")
            return tool_result({
                "success": True,
                "data": [
                    {"attendeeId": a.get("attendee_id"), "userId": a.get("user_id"), "displayName": a.get("display_name"), "rsvpStatus": a.get("rsvp_status")}
                    for a in (data or {}).get("items", [])
                ],
            })
        if op == "update_attendees":
            eid = str(args.get("eventId") or "").strip()
            if not eid:
                return tool_error("eventId is required", success=False, operation=op)
            add_ids = _calendar_user_ids(args, kwargs, id_key="attendeeIds", names_key="addNames")
            remove_ids = set(_calendar_user_ids(args, kwargs, id_key="removeAttendeeIds", names_key="removeNames"))
            if add_ids:
                await client.request("POST", f"{base}/events/{eid}/attendees", json_body={"attendees": [{"type": "user", "user_id": str(a)} for a in add_ids]})
            if remove_ids:
                existing = await client.request("GET", f"{base}/events/{eid}/attendees")
                to_delete = [a.get("attendee_id") for a in (existing or {}).get("items", []) if str(a.get("user_id")) in remove_ids and a.get("attendee_id")]
                if to_delete:
                    await client.request("POST", f"{base}/events/{eid}/attendees/batch_delete", json_body={"attendee_ids": to_delete})
            return tool_result({"success": True, "message": "Attendees updated."})
        return tool_error(f"Unhandled lark_calendar operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# ── Contacts (Contact v3) ────────────────────────────────────────────────────

LARK_CONTACTS_OPS = {"lookup", "list_department"}

LARK_CONTACTS_SCHEMA = {
    "name": "lark_contacts",
    "description": (
        "Lark/Feishu directory. Operations: lookup (resolve people by email/mobile → open_id), "
        "list_department (members of a department by name)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_CONTACTS_OPS)},
            "emails": {"type": "array", "items": {"type": "string"}},
            "mobiles": {"type": "array", "items": {"type": "string"}},
            "department": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        },
        "required": ["op"],
    },
}


async def _handle_lark_contacts(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in LARK_CONTACTS_OPS:
        return tool_error(f"Unknown lark_contacts operation: {op}", success=False)
    try:
        client = _client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)
    try:
        if op == "lookup":
            emails = [str(e) for e in (args.get("emails") or []) if str(e).strip()]
            mobiles = [str(m) for m in (args.get("mobiles") or []) if str(m).strip()]
            if not emails and not mobiles:
                return tool_error("emails or mobiles are required for lookup", success=False, operation=op)
            data = await client.request(
                "POST",
                "/open-apis/contact/v3/users/batch_get_id",
                params={"user_id_type": "open_id"},
                json_body={"emails": emails, "mobiles": mobiles},
            )
            users = (data or {}).get("user_list", [])
            found = [{"openId": u.get("user_id"), "email": u.get("email"), "mobile": u.get("mobile")} for u in users if u.get("user_id")]
            not_found = [u.get("email") or u.get("mobile") for u in users if not u.get("user_id")]
            return tool_result({"success": True, "data": {"found": found, "notFound": not_found}})
        if op == "list_department":
            dept = str(args.get("department") or "").strip()
            if not dept:
                return tool_error("department is required for list_department", success=False, operation=op)
            search = await client.request("POST", "/open-apis/contact/v3/departments/search", params={"page_size": 10}, json_body={"query": dept})
            depts = (search or {}).get("items", []) or (search or {}).get("department_list", [])
            if not depts:
                return tool_result({"success": True, "message": f"No department matched '{dept}'.", "data": {"department": dept, "members": []}})
            dept_id = depts[0].get("open_department_id") or depts[0].get("department_id")
            limit = max(1, min(100, int(args.get("limit") or 50)))
            members: list[dict[str, Any]] = []
            page_token = None
            while len(members) < limit:
                params = {"department_id": dept_id, "department_id_type": "open_department_id", "page_size": min(limit, 50)}
                if page_token:
                    params["page_token"] = page_token
                page = await client.request("GET", "/open-apis/contact/v3/users", params=params)
                for u in (page or {}).get("items", []):
                    members.append({"openId": u.get("open_id"), "displayName": u.get("name"), "email": u.get("email")})
                page_token = (page or {}).get("page_token")
                if not (page or {}).get("has_more") or not page_token:
                    break
            return tool_result({"success": True, "data": {"department": depts[0].get("name", dept), "memberCount": len(members), "members": members[:limit]}})
        return tool_error(f"Unhandled lark_contacts operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# ── Task (Task v2) ───────────────────────────────────────────────────────────

LARK_TASK_OPS = {
    "create", "get", "list", "listMine", "listOpenMine", "update", "delete", "complete",
    "create_subtask", "list_subtasks", "create_tasklist", "list_tasklists",
    "add_to_tasklist", "remove_from_tasklist",
}

LARK_TASK_SCHEMA = {
    "name": "lark_task",
    "description": (
        "Lark/Feishu Tasks. Operations: create, get, list, listMine, listOpenMine, update, delete, "
        "complete, create_subtask, list_subtasks, create_tasklist, list_tasklists, add_to_tasklist, "
        "remove_from_tasklist. dueDate is ISO 8601. assigneeIds take raw Lark ids; assigneeNames "
        "resolve people from Hermes company identity."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_TASK_OPS)},
            "taskId": {"type": "string"},
            "parentTaskId": {"type": "string"},
            "tasklistId": {"type": "string"},
            "tasklist": {"type": "string", "description": "Tasklist GUID alias used by Divo; same as tasklistId for list/create."},
            "title": {"type": "string"},
            "notes": {"type": "string"},
            "dueDate": {"type": "string", "description": "ISO 8601."},
            "assigneeIds": {"type": "array", "items": {"type": "string"}},
            "assigneeNames": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Human-readable names such as Anish or Shivam sir; resolved to Lark ids.",
            },
            "followerIds": {"type": "array", "items": {"type": "string"}},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        },
        "required": ["op"],
    },
}


def _task_due(iso: str) -> dict[str, Any]:
    return {"timestamp": str(_iso_to_epoch(iso) * 1000), "is_all_day": False}


def _task_body(
    args: dict[str, Any],
    *,
    assignee_ids: list[str] | None = None,
    include_followers: bool = False,
) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if args.get("title"):
        body["summary"] = str(args["title"])
    if args.get("notes"):
        body["description"] = str(args["notes"])
    if args.get("dueDate"):
        body["due"] = _task_due(str(args["dueDate"]))
    members = _members(assignee_ids if assignee_ids is not None else args.get("assigneeIds"), "assignee")
    if include_followers:
        members.extend(_members(args.get("followerIds"), "follower"))
    if members:
        body["members"] = members
    return body


def _task_id(t: dict[str, Any]) -> str | None:
    return t.get("guid") or t.get("task_id") or t.get("id")


def _is_task_completed(t: dict[str, Any]) -> bool:
    completed_at = str(t.get("completed_at") or "0")
    if completed_at not in {"0", "", "undefined", "None"}:
        return True
    if str(t.get("status") or "").lower() == "completed":
        return True
    return bool(t.get("completed") or t.get("done"))


def _task_has_member(task: dict[str, Any], lark_user_id: str) -> bool:
    normalized = str(lark_user_id or "").strip().lower()
    if not normalized:
        return False
    for member in task.get("members") or []:
        if not isinstance(member, dict):
            continue
        if str(member.get("id") or "").strip().lower() == normalized:
            return True
    creator = task.get("creator") if isinstance(task.get("creator"), dict) else {}
    return str(creator.get("id") or "").strip().lower() == normalized


def _norm_task(t: dict[str, Any]) -> dict[str, Any]:
    completed = _is_task_completed(t)
    due = (t.get("due") or {}).get("timestamp")
    return {
        "taskId": _task_id(t),
        "title": t.get("summary") or t.get("title"),
        "completed": completed,
        "dueDate": _epoch_to_iso(int(due) // 1000) if due else None,
    }


_STRIP_TITLES_RE = re.compile(r"\b(mr|mrs|ms|miss|dr|prof|sir|ma'am|shri|smt)\b\.?", re.IGNORECASE)


def _normalize_person_name(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s@._-]", "", _STRIP_TITLES_RE.sub("", name.lower()))).strip()


def _tokens(value: str) -> set[str]:
    return {part for part in value.split() if part}


def _overlap_score(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / max(len(a), len(b))


def _session_lark_user_id(kwargs: dict[str, Any]) -> str:
    value = str(kwargs.get("lark_open_id") or kwargs.get("lark_user_id") or "").strip()
    if value:
        return value
    try:
        from gateway.session_context import get_session_env

        return str(get_session_env("HERMES_SESSION_USER_ID", "") or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def _company_id(kwargs: dict[str, Any]) -> str:
    value = str(kwargs.get("company_id") or "").strip()
    if value:
        return value
    try:
        from gateway.session_context import get_session_env

        return str(get_session_env("HERMES_COMPANY_ID", "") or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def _identity_rows_for_company(company_id: str) -> list[dict[str, Any]]:
    try:
        from gateway.company_identity import list_channel_identities_for_company_user, list_company_users
    except Exception:  # noqa: BLE001
        return []
    rows: list[dict[str, Any]] = []
    for user in list_company_users(company_id=company_id):
        company_user_id = str(
            user.get("id")
            or user.get("company_user_id")
            or user.get("companyUserId")
            or ""
        ).strip()
        if not company_user_id:
            continue
        for identity in list_channel_identities_for_company_user(company_user_id):
            platform = str(identity.get("platform") or identity.get("channel") or "").strip().lower()
            if platform not in {"lark", "feishu"}:
                continue
            rows.append({"user": user, "identity": identity})
    return rows


def _raw_identity_json(identity: dict[str, Any]) -> dict[str, Any]:
    raw = identity.get("raw_json") or identity.get("rawJson")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _lark_people_directory(company_id: str) -> list[dict[str, Any]]:
    directory: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in _identity_rows_for_company(company_id):
        user = row["user"]
        identity = row["identity"]
        raw = _raw_identity_json(identity)
        open_id = str(
            identity.get("platform_user_id")
            or identity.get("externalUserId")
            or raw.get("open_id")
            or raw.get("user_id")
            or ""
        ).strip()
        if not open_id or open_id in seen:
            continue
        display_name = str(
            identity.get("display_name")
            or identity.get("displayName")
            or user.get("display_name")
            or user.get("displayName")
            or user.get("email")
            or open_id
        ).strip()
        email = str(user.get("email") or raw.get("email") or "").strip()
        norm_name = _normalize_person_name(display_name)
        directory.append(
            {
                "openId": open_id,
                "displayName": display_name,
                "email": email,
                "normName": norm_name,
                "tokens": _tokens(norm_name),
            }
        )
        seen.add(open_id)
    return directory


def _resolve_lark_people(
    *,
    company_id: str,
    queries: list[str],
    requester_open_id: str,
) -> dict[str, Any]:
    directory = _lark_people_directory(company_id)
    self_aliases = {"me", "myself", "i", "self"}
    resolved: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []
    not_found: list[str] = []
    seen: set[str] = set()

    def add_person(person: dict[str, Any]) -> None:
        open_id = str(person.get("openId") or "").strip()
        if open_id and open_id not in seen:
            seen.add(open_id)
            resolved.append(
                {
                    "openId": open_id,
                    "displayName": person.get("displayName") or open_id,
                    **({"email": person["email"]} if person.get("email") else {}),
                }
            )

    for raw_query in queries:
        query = str(raw_query or "").strip()
        if not query:
            continue
        normalized = _normalize_person_name(query)
        if normalized in self_aliases:
            if requester_open_id:
                self_entry = next((item for item in directory if item["openId"] == requester_open_id), None)
                add_person(self_entry or {"openId": requester_open_id, "displayName": "You"})
            else:
                not_found.append(query)
            continue

        exact = [
            item
            for item in directory
            if item["normName"] == normalized or str(item.get("email") or "").lower() == normalized
        ]
        if len(exact) == 1:
            add_person(exact[0])
            continue
        if len(exact) > 1:
            ambiguous.append({"query": query, "matches": exact})
            continue

        query_tokens = _tokens(normalized)
        contained = [
            item
            for item in directory
            if query_tokens
            and (
                query_tokens.issubset(item["tokens"])
                or item["tokens"].issubset(query_tokens)
            )
        ]
        if len(contained) == 1:
            add_person(contained[0])
            continue
        if len(contained) > 1:
            ambiguous.append({"query": query, "matches": contained})
            continue

        scored = [
            (item, _overlap_score(query_tokens, item["tokens"]))
            for item in directory
        ]
        scored = [(item, score) for item, score in scored if score >= 0.5]
        scored.sort(key=lambda item: item[1], reverse=True)
        if not scored:
            not_found.append(query)
            continue
        top_score = scored[0][1]
        best = [item for item, score in scored if score == top_score]
        if len(best) == 1:
            add_person(best[0])
        else:
            ambiguous.append({"query": query, "matches": best})
    return {"resolved": resolved, "ambiguous": ambiguous, "notFound": not_found}


def _assignee_name_queries(args: dict[str, Any]) -> list[str]:
    return [str(item).strip() for item in (args.get("assigneeNames") or []) if str(item).strip()]


def _explicit_assignee_ids(args: dict[str, Any]) -> list[str] | None:
    ids = [str(item).strip() for item in (args.get("assigneeIds") or []) if str(item).strip()]
    return ids or None


def _resolve_assignee_ids(
    args: dict[str, Any],
    kwargs: dict[str, Any],
    *,
    default_to_requester: bool = False,
) -> list[str] | None:
    explicit = _explicit_assignee_ids(args)
    if explicit:
        return explicit
    names = _assignee_name_queries(args)
    requester = _session_lark_user_id(kwargs)
    if names:
        resolved = _resolve_lark_people(
            company_id=_company_id(kwargs),
            queries=names,
            requester_open_id=requester,
        )
        if resolved["notFound"]:
            raise ValueError(f"Could not find Lark users: {', '.join(resolved['notFound'])}")
        if resolved["ambiguous"]:
            detail = "; ".join(
                f"\"{item['query']}\" -> "
                + " / ".join(str(match.get("displayName") or match.get("openId")) for match in item["matches"])
                for item in resolved["ambiguous"]
            )
            raise ValueError(f"Ambiguous assignee names - please clarify: {detail}")
        return [item["openId"] for item in resolved["resolved"]]
    if default_to_requester and requester:
        return [requester]
    return None


def _tasklist_id(args: dict[str, Any]) -> str:
    return str(args.get("tasklistId") or args.get("tasklist") or "").strip()


async def _list_lark_tasks(
    client: Any,
    *,
    limit: int,
    tasklist_id: str = "",
) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}

    async def collect(target_tasklist_id: str = "", page_size: int = 100) -> None:
        params: dict[str, Any] = {"page_size": max(1, min(100, page_size))}
        if target_tasklist_id:
            params["tasklist_id"] = target_tasklist_id
        data = await client.request("GET", "/open-apis/task/v2/tasks", params=params)
        for item in (data or {}).get("items", []):
            if not isinstance(item, dict):
                continue
            item_id = str(_task_id(item) or "")
            if item_id:
                seen[item_id] = item

    if tasklist_id:
        await collect(tasklist_id, limit)
    else:
        await collect("", limit)
        if not seen:
            lists = await client.request("GET", "/open-apis/task/v2/tasklists", params={"page_size": 50})
            for tasklist in (lists or {}).get("items", []):
                if not isinstance(tasklist, dict):
                    continue
                tlid = str(tasklist.get("guid") or "").strip()
                if tlid:
                    await collect(tlid, 100)
    return list(seen.values())[:limit]


async def _handle_lark_task(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in LARK_TASK_OPS:
        return tool_error(f"Unknown lark_task operation: {op}", success=False)
    try:
        client = _client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)
    try:
        if op == "create":
            if not str(args.get("title") or "").strip():
                return tool_error("title is required for create", success=False, operation=op)
            assignee_ids = _resolve_assignee_ids(args, kwargs, default_to_requester=True)
            data = await client.request(
                "POST",
                "/open-apis/task/v2/tasks",
                json_body=_task_body(args, assignee_ids=assignee_ids, include_followers=True),
            )
            task = _norm_task((data or {}).get("task", {}))
            return tool_result({"success": True, "taskId": task.get("taskId"), "data": task, "message": f"Task \"{task.get('title') or args.get('title')}\" created"})
        if op == "get":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            data = await client.request("GET", f"/open-apis/task/v2/tasks/{tid}")
            return tool_result({"success": True, "data": _norm_task((data or {}).get("task", {}))})
        if op == "list":
            limit = max(1, min(100, int(args.get("limit") or 50)))
            tasks = await _list_lark_tasks(client, limit=limit, tasklist_id=_tasklist_id(args))
            return tool_result({"success": True, "data": [_norm_task(t) for t in tasks], "message": f"Found {len(tasks)} tasks"})
        if op in {"listMine", "listOpenMine"}:
            requester = _session_lark_user_id(kwargs)
            if not requester:
                return tool_result({"success": False, "data": [], "message": "Cannot determine current user identity"})
            limit = max(1, min(100, int(args.get("limit") or 50)))
            tasks = await _list_lark_tasks(client, limit=limit, tasklist_id=_tasklist_id(args))
            tasks = [task for task in tasks if _task_has_member(task, requester)]
            if op == "listOpenMine":
                tasks = [task for task in tasks if not _is_task_completed(task)]
            return tool_result({"success": True, "data": [_norm_task(t) for t in tasks], "message": f"Found {len(tasks)} {'open ' if op == 'listOpenMine' else ''}tasks assigned to you"})
        if op == "update":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            body = _task_body(args, assignee_ids=_resolve_assignee_ids(args, kwargs))
            fields = ",".join(k for k in body)
            if not fields:
                return tool_error("No task fields supplied for update", success=False, operation=op)
            await client.request("PATCH", f"/open-apis/task/v2/tasks/{tid}", params={"update_fields": fields}, json_body=body)
            return tool_result({"success": True, "taskId": tid, "message": "Task updated."})
        if op == "complete":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            await client.request("POST", f"/open-apis/task/v2/tasks/{tid}/complete")
            return tool_result({"success": True, "taskId": tid, "message": "Task marked complete"})
        if op == "delete":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            await client.request("DELETE", f"/open-apis/task/v2/tasks/{tid}")
            return tool_result({"success": True, "taskId": tid, "message": "Task deleted."})
        if op == "create_subtask":
            parent = str(args.get("parentTaskId") or "").strip()
            if not parent or not str(args.get("title") or "").strip():
                return tool_error("parentTaskId and title are required for create_subtask", success=False, operation=op)
            data = await client.request(
                "POST",
                f"/open-apis/task/v2/tasks/{parent}/subtasks",
                json_body=_task_body(args, assignee_ids=_resolve_assignee_ids(args, kwargs)),
            )
            task = _norm_task((data or {}).get("task", {}))
            return tool_result({"success": True, "taskId": task.get("taskId"), "data": task, "message": f"Subtask \"{task.get('title') or args.get('title')}\" created"})
        if op == "list_subtasks":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            data = await client.request("GET", f"/open-apis/task/v2/tasks/{tid}/subtasks")
            return tool_result({"success": True, "data": [_norm_task(t) for t in (data or {}).get("items", [])]})
        if op == "list_tasklists":
            data = await client.request("GET", "/open-apis/task/v2/tasklists", params={"page_size": 50})
            return tool_result({"success": True, "data": [{"guid": t.get("guid"), "name": t.get("name")} for t in (data or {}).get("items", [])]})
        if op == "create_tasklist":
            if not str(args.get("title") or "").strip():
                return tool_error("title is required for create_tasklist", success=False, operation=op)
            body = {"name": str(args["title"])}
            members = _members(_resolve_assignee_ids(args, kwargs), "editor")
            if members:
                body["members"] = members
            data = await client.request("POST", "/open-apis/task/v2/tasklists", json_body=body)
            tl = (data or {}).get("tasklist", {})
            return tool_result({"success": True, "data": {"guid": tl.get("guid"), "name": tl.get("name")}, "message": f"Tasklist \"{tl.get('name') or args['title']}\" created"})
        if op in ("add_to_tasklist", "remove_from_tasklist"):
            tid = str(args.get("taskId") or "").strip()
            tlid = _tasklist_id(args)
            if not tid or not tlid:
                return tool_error("taskId and tasklistId are required", success=False, operation=op)
            action = "add" if op == "add_to_tasklist" else "remove"
            await client.request("POST", f"/open-apis/task/v2/tasklists/{tlid}/tasks/{action}", json_body={"tasks": [{"guid": tid}]})
            return tool_result({"success": True, "taskId": tid, "message": "Task added to tasklist" if action == "add" else "Task removed from tasklist"})
        return tool_error(f"Unhandled lark_task operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# ── Approval (Approval v4) ───────────────────────────────────────────────────

LARK_APPROVAL_OPS = {"create", "get", "list"}

LARK_APPROVAL_SCHEMA = {
    "name": "lark_approval",
    "description": "Lark/Feishu Approval instances. Operations: create, get, list.",
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_APPROVAL_OPS)},
            "approvalCode": {"type": "string"},
            "instanceCode": {"type": "string"},
            "formValues": {"type": "object", "additionalProperties": True, "description": "{ field_id: value } pairs."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 50},
        },
        "required": ["op", "approvalCode"],
    },
}


def _norm_instance(i: dict[str, Any]) -> dict[str, Any]:
    return {
        "instanceCode": i.get("instance_code"),
        "approvalCode": i.get("approval_code"),
        "status": i.get("status"),
        "title": i.get("title") or i.get("reason") or i.get("name"),
    }


async def _handle_lark_approval(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in LARK_APPROVAL_OPS:
        return tool_error(f"Unknown lark_approval operation: {op}", success=False)
    approval_code = str(args.get("approvalCode") or "").strip()
    if not approval_code:
        return tool_error("approvalCode is required", success=False, operation=op)
    try:
        client = _client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)
    try:
        if op == "list":
            limit = max(1, min(50, int(args.get("limit") or 20)))
            data = await client.request("GET", "/open-apis/approval/v4/instances", params={"approval_code": approval_code, "page_size": limit})
            return tool_result({"success": True, "data": [_norm_instance(i) for i in (data or {}).get("items", [])]})
        if op == "get":
            inst = str(args.get("instanceCode") or "").strip()
            if not inst:
                return tool_error("instanceCode is required for get", success=False, operation=op)
            data = await client.request("GET", f"/open-apis/approval/v4/instances/{inst}")
            return tool_result({"success": True, "data": _norm_instance((data or {}).get("instance", data))})
        if op == "create":
            form_values = args.get("formValues")
            if not isinstance(form_values, dict) or not form_values:
                return tool_error("formValues are required for create", success=False, operation=op)
            form = json.dumps([{"id": k, "value": v} for k, v in form_values.items()])
            data = await client.request("POST", "/open-apis/approval/v4/instances", json_body={"approval_code": approval_code, "form": form})
            return tool_result({"success": True, "instanceCode": (data or {}).get("instance_code")})
        return tool_error(f"Unhandled lark_approval operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# ── Registration ─────────────────────────────────────────────────────────────
# NOTE: these MUST be explicit top-level ``registry.register(...)`` calls — the
# built-in autoloader (registry.discover_builtin_tools → _module_registers_tools)
# only imports a tool module when an AST scan finds a top-level register call.
# A for-loop over registrations is invisible to that scan, so the tools would
# never load in a real agent session (only when something imports this module
# directly, e.g. tests). Do not refactor these into a loop.

registry.register(name="lark_messaging", toolset="lark", schema=LARK_MESSAGING_SCHEMA,
                  handler=_handle_lark_messaging, check_fn=_check, is_async=True,
                  emoji="💬", max_result_size_chars=100_000)
registry.register(name="lark_doc", toolset="lark", schema=LARK_DOC_SCHEMA,
                  handler=_handle_lark_doc, check_fn=_check, is_async=True,
                  emoji="📄", max_result_size_chars=100_000)
registry.register(name="lark_base", toolset="lark", schema=LARK_BASE_SCHEMA,
                  handler=_handle_lark_base, check_fn=_check, is_async=True,
                  emoji="🗃️", max_result_size_chars=100_000)
registry.register(name="lark_calendar", toolset="lark", schema=LARK_CALENDAR_SCHEMA,
                  handler=_handle_lark_calendar, check_fn=_check, is_async=True,
                  emoji="📅", max_result_size_chars=100_000)
registry.register(name="lark_contacts", toolset="lark", schema=LARK_CONTACTS_SCHEMA,
                  handler=_handle_lark_contacts, check_fn=_check, is_async=True,
                  emoji="👥", max_result_size_chars=100_000)
registry.register(name="lark_task", toolset="lark", schema=LARK_TASK_SCHEMA,
                  handler=_handle_lark_task, check_fn=_check, is_async=True,
                  emoji="✅", max_result_size_chars=100_000)
registry.register(name="lark_approval", toolset="lark", schema=LARK_APPROVAL_SCHEMA,
                  handler=_handle_lark_approval, check_fn=_check, is_async=True,
                  emoji="📝", max_result_size_chars=100_000)
