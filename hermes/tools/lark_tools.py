"""Hermes-native Lark/Feishu tools on per-company (or env) app credentials.

Full Divo-level Lark surface ported natively onto the runtime credential vault:
messaging, doc, base (bitable), calendar, contacts, task, approval. Credentials
resolve per company (see ``tools/lark_runtime.py``); ``company_id`` is injected
at dispatch (T3.1). All families share the tenant-token ``LarkClient``.

People resolution (name → open_id) is a higher-level concern Divo handles with a
directory resolver; these tools take open_ids directly (use ``lark_contacts``
lookup to resolve first), matching the Lark Open API contract.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from tools.registry import registry, tool_error, tool_result


def _check() -> bool:
    """Available in enterprise mode (per-company config or LARK_APP_* env)."""
    try:
        import os

        from tools.lark_runtime import enterprise_enabled

        has_env = bool((os.getenv("LARK_APP_ID") or "").strip() and (os.getenv("LARK_APP_SECRET") or "").strip())
        return enterprise_enabled() and has_env
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

LARK_MESSAGING_OPS = {"send", "list_chats"}
_RECEIVE_ID_TYPES = {"open_id", "user_id", "union_id", "email", "chat_id"}

LARK_MESSAGING_SCHEMA = {
    "name": "lark_messaging",
    "description": "Send Lark/Feishu messages and list the bot's chats. Operations: send, list_chats.",
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
        client = _client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)
    try:
        if op == "send":
            receive_id = str(args.get("receiveId") or "").strip()
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
                    "content": json.dumps({"text": str(args.get("text") or "")}),
                },
            )
            return tool_result({"success": True, "message": "Message sent.", "messageId": (data or {}).get("message_id")})
        if op == "list_chats":
            page_size = max(1, min(100, int(args.get("maxResults") or 20)))
            data = await client.request("GET", "/open-apis/im/v1/chats", params={"page_size": page_size})
            chats = (data or {}).get("items", [])
            return tool_result({
                "success": True,
                "message": f"Found {len(chats)} chat(s).",
                "data": [{"chat_id": c.get("chat_id"), "name": c.get("name"), "description": c.get("description")} for c in chats],
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

LARK_CALENDAR_OPS = {"list", "get", "create", "update", "delete", "free_busy", "list_attendees", "update_attendees"}

LARK_CALENDAR_SCHEMA = {
    "name": "lark_calendar",
    "description": (
        "Lark/Feishu Calendar. Operations: list, get, create, update, delete, free_busy, list_attendees, "
        "update_attendees. Times are ISO 8601; attendee/user ids are open_ids."
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
            "removeAttendeeIds": {"type": "array", "items": {"type": "string"}},
            "userIds": {"type": "array", "items": {"type": "string"}},
            "dateFrom": {"type": "string"},
            "dateTo": {"type": "string"},
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
            if args.get("attendeeIds"):
                body["attendees"] = [{"type": "user", "user_id": str(a)} for a in args["attendeeIds"]]
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
            user_ids = args.get("userIds") or []
            d_from, d_to = str(args.get("dateFrom") or ""), str(args.get("dateTo") or "")
            if not user_ids or not d_from or not d_to:
                return tool_error("userIds, dateFrom, dateTo are required for free_busy", success=False, operation=op)
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
            add_ids = args.get("attendeeIds") or []
            remove_ids = set(str(r) for r in (args.get("removeAttendeeIds") or []))
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
    "create", "get", "list", "update", "delete", "complete",
    "create_subtask", "list_subtasks", "create_tasklist", "list_tasklists",
    "add_to_tasklist", "remove_from_tasklist",
}

LARK_TASK_SCHEMA = {
    "name": "lark_task",
    "description": (
        "Lark/Feishu Tasks. Operations: create, get, list, update, delete, complete, create_subtask, "
        "list_subtasks, create_tasklist, list_tasklists, add_to_tasklist, remove_from_tasklist. "
        "dueDate is ISO 8601; assignee ids are open_ids."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_TASK_OPS)},
            "taskId": {"type": "string"},
            "parentTaskId": {"type": "string"},
            "tasklistId": {"type": "string"},
            "title": {"type": "string"},
            "notes": {"type": "string"},
            "dueDate": {"type": "string", "description": "ISO 8601."},
            "assigneeIds": {"type": "array", "items": {"type": "string"}},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        },
        "required": ["op"],
    },
}


def _task_due(iso: str) -> dict[str, Any]:
    return {"timestamp": str(_iso_to_epoch(iso) * 1000), "is_all_day": False}


def _task_body(args: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if args.get("title"):
        body["summary"] = str(args["title"])
    if args.get("notes"):
        body["description"] = str(args["notes"])
    if args.get("dueDate"):
        body["due"] = _task_due(str(args["dueDate"]))
    members = _members(args.get("assigneeIds"), "assignee")
    if members:
        body["members"] = members
    return body


def _norm_task(t: dict[str, Any]) -> dict[str, Any]:
    completed = bool(t.get("completed")) or str(t.get("status", "")).lower() == "completed" or bool(t.get("completed_at") and str(t.get("completed_at")) not in ("0", ""))
    due = (t.get("due") or {}).get("timestamp")
    return {
        "taskId": t.get("guid") or t.get("task_id") or t.get("id"),
        "title": t.get("summary"),
        "completed": completed,
        "dueDate": _epoch_to_iso(int(due) // 1000) if due else None,
    }


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
            data = await client.request("POST", "/open-apis/task/v2/tasks", json_body=_task_body(args))
            return tool_result({"success": True, "data": _norm_task((data or {}).get("task", {}))})
        if op == "get":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            data = await client.request("GET", f"/open-apis/task/v2/tasks/{tid}")
            return tool_result({"success": True, "data": _norm_task((data or {}).get("task", {}))})
        if op == "list":
            limit = max(1, min(100, int(args.get("limit") or 50)))
            params = {"page_size": limit}
            if args.get("tasklistId"):
                params["tasklist_id"] = str(args["tasklistId"])
            data = await client.request("GET", "/open-apis/task/v2/tasks", params=params)
            return tool_result({"success": True, "data": [_norm_task(t) for t in (data or {}).get("items", [])]})
        if op == "update":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            body = _task_body(args)
            fields = ",".join(k for k in body)
            await client.request("PATCH", f"/open-apis/task/v2/tasks/{tid}", params={"update_fields": fields}, json_body=body)
            return tool_result({"success": True, "message": "Task updated."})
        if op == "complete":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            await client.request("POST", f"/open-apis/task/v2/tasks/{tid}/complete")
            return tool_result({"success": True, "message": "Task completed."})
        if op == "delete":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            await client.request("DELETE", f"/open-apis/task/v2/tasks/{tid}")
            return tool_result({"success": True, "message": "Task deleted."})
        if op == "create_subtask":
            parent = str(args.get("parentTaskId") or "").strip()
            if not parent or not str(args.get("title") or "").strip():
                return tool_error("parentTaskId and title are required for create_subtask", success=False, operation=op)
            data = await client.request("POST", f"/open-apis/task/v2/tasks/{parent}/subtasks", json_body=_task_body(args))
            return tool_result({"success": True, "data": _norm_task((data or {}).get("task", {}))})
        if op == "list_subtasks":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            data = await client.request("GET", f"/open-apis/task/v2/tasks/{tid}/subtasks")
            return tool_result({"success": True, "data": [_norm_task(t) for t in (data or {}).get("items", [])]})
        if op == "list_tasklists":
            data = await client.request("GET", "/open-apis/task/v2/tasklists")
            return tool_result({"success": True, "data": [{"guid": t.get("guid"), "name": t.get("name")} for t in (data or {}).get("items", [])]})
        if op == "create_tasklist":
            if not str(args.get("title") or "").strip():
                return tool_error("title is required for create_tasklist", success=False, operation=op)
            body = {"name": str(args["title"])}
            members = _members(args.get("assigneeIds"), "editor")
            if members:
                body["members"] = members
            data = await client.request("POST", "/open-apis/task/v2/tasklists", json_body=body)
            tl = (data or {}).get("tasklist", {})
            return tool_result({"success": True, "data": {"guid": tl.get("guid"), "name": tl.get("name")}})
        if op in ("add_to_tasklist", "remove_from_tasklist"):
            tid = str(args.get("taskId") or "").strip()
            tlid = str(args.get("tasklistId") or "").strip()
            if not tid or not tlid:
                return tool_error("taskId and tasklistId are required", success=False, operation=op)
            action = "add" if op == "add_to_tasklist" else "remove"
            await client.request("POST", f"/open-apis/task/v2/tasklists/{tlid}/tasks/{action}", json_body={"tasks": [{"guid": tid}]})
            return tool_result({"success": True, "message": f"Task {action}ed."})
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
