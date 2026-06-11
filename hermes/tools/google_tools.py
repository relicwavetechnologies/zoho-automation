"""Hermes-native Google tools (Gmail + Drive) on per-company credentials.

Credentials are resolved per company from the runtime Postgres vault (see
``tools/google_runtime.py``); ``company_id``/``company_user_id`` are injected at
dispatch (T3.1). Mirrors the Zoho tool pattern.
"""

from __future__ import annotations

import base64
from email.message import EmailMessage
from typing import Any

from enterprise.google_token import google_oauth_app_configured
from tools.registry import registry, tool_error, tool_result

GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1"
DRIVE_BASE = "https://www.googleapis.com/drive/v3"

GMAIL_OPS = {"profile", "list", "search", "get", "send"}
DRIVE_OPS = {"list", "search", "get"}


def _check() -> bool:
    """Available in enterprise mode with the shared Google OAuth app configured."""
    try:
        from tools.google_runtime import enterprise_enabled

        return enterprise_enabled() and google_oauth_app_configured()
    except Exception:  # noqa: BLE001
        return False


# --- Gmail ------------------------------------------------------------------

GMAIL_SCHEMA = {
    "name": "gmail",
    "description": (
        "Access the company's connected Gmail. Operations: profile, list, "
        "search (Gmail query syntax), get (full message), send."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(GMAIL_OPS)},
            "query": {"type": "string", "description": "Gmail search query (for list/search)."},
            "messageId": {"type": "string"},
            "maxResults": {"type": "integer", "minimum": 1, "maximum": 50},
            "to": {"type": "string"},
            "subject": {"type": "string"},
            "body": {"type": "string"},
        },
        "required": ["op"],
    },
}


def _header(headers: list[dict[str, Any]], name: str) -> str:
    for h in headers or []:
        if str(h.get("name", "")).lower() == name.lower():
            return str(h.get("value", ""))
    return ""


def _decode_part(data: str) -> str:
    try:
        return base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return ""


def _extract_plain_body(payload: dict[str, Any]) -> str:
    if not isinstance(payload, dict):
        return ""
    mime = payload.get("mimeType", "")
    body = payload.get("body", {}) or {}
    if mime == "text/plain" and body.get("data"):
        return _decode_part(body["data"])
    for part in payload.get("parts", []) or []:
        text = _extract_plain_body(part)
        if text:
            return text
    if body.get("data"):
        return _decode_part(body["data"])
    return ""


async def _handle_gmail(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in GMAIL_OPS:
        return tool_error(f"Unknown gmail operation: {op}", success=False)
    try:
        from tools.google_runtime import resolve_tool_client

        client = resolve_tool_client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)

    try:
        if op == "profile":
            data = await client.request("GET", f"{GMAIL_BASE}/users/me/profile")
            return tool_result({"success": True, "data": data})

        if op in ("list", "search"):
            max_results = max(1, min(50, int(args.get("maxResults") or 10)))
            params = {"maxResults": max_results}
            if args.get("query"):
                params["q"] = str(args["query"])
            listing = await client.request("GET", f"{GMAIL_BASE}/users/me/messages", params=params)
            ids = [m["id"] for m in (listing or {}).get("messages", [])]
            items = []
            for mid in ids:
                msg = await client.request(
                    "GET",
                    f"{GMAIL_BASE}/users/me/messages/{mid}",
                    params={"format": "metadata", "metadataHeaders": ["From", "Subject", "Date"]},
                )
                headers = (msg.get("payload", {}) or {}).get("headers", [])
                items.append(
                    {
                        "id": mid,
                        "from": _header(headers, "From"),
                        "subject": _header(headers, "Subject"),
                        "date": _header(headers, "Date"),
                        "snippet": msg.get("snippet", ""),
                    }
                )
            return tool_result(
                {"success": True, "message": f"Found {len(items)} message(s).", "data": items}
            )

        if op == "get":
            mid = str(args.get("messageId") or "").strip()
            if not mid:
                return tool_error("messageId is required for get", success=False, operation=op)
            msg = await client.request(
                "GET", f"{GMAIL_BASE}/users/me/messages/{mid}", params={"format": "full"}
            )
            payload = msg.get("payload", {}) or {}
            headers = payload.get("headers", [])
            return tool_result(
                {
                    "success": True,
                    "data": {
                        "id": mid,
                        "from": _header(headers, "From"),
                        "to": _header(headers, "To"),
                        "subject": _header(headers, "Subject"),
                        "date": _header(headers, "Date"),
                        "body": _extract_plain_body(payload),
                    },
                }
            )

        if op == "send":
            to = str(args.get("to") or "").strip()
            if not to:
                return tool_error("to is required for send", success=False, operation=op)
            mail = EmailMessage()
            mail["To"] = to
            mail["Subject"] = str(args.get("subject") or "")
            mail.set_content(str(args.get("body") or ""))
            raw = base64.urlsafe_b64encode(mail.as_bytes()).decode("utf-8")
            sent = await client.request(
                "POST", f"{GMAIL_BASE}/users/me/messages/send", json_body={"raw": raw}
            )
            return tool_result({"success": True, "id": sent.get("id"), "message": "Email sent."})

        return tool_error(f"Unhandled gmail operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# --- Drive ------------------------------------------------------------------

DRIVE_SCHEMA = {
    "name": "google_drive",
    "description": (
        "Access the company's connected Google Drive. Operations: list, search "
        "(name/content query), get (file metadata)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(DRIVE_OPS)},
            "query": {"type": "string", "description": "Drive query, e.g. name contains 'report'."},
            "fileId": {"type": "string"},
            "maxResults": {"type": "integer", "minimum": 1, "maximum": 100},
        },
        "required": ["op"],
    },
}

_DRIVE_FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName,emailAddress)"


async def _handle_drive(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in DRIVE_OPS:
        return tool_error(f"Unknown google_drive operation: {op}", success=False)
    try:
        from tools.google_runtime import resolve_tool_client

        client = resolve_tool_client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)

    try:
        if op in ("list", "search"):
            page_size = max(1, min(100, int(args.get("maxResults") or 20)))
            params = {"pageSize": page_size, "fields": f"files({_DRIVE_FILE_FIELDS})"}
            if args.get("query"):
                params["q"] = str(args["query"])
            data = await client.request("GET", f"{DRIVE_BASE}/files", params=params)
            files = (data or {}).get("files", [])
            return tool_result(
                {"success": True, "message": f"Found {len(files)} file(s).", "data": files}
            )

        if op == "get":
            fid = str(args.get("fileId") or "").strip()
            if not fid:
                return tool_error("fileId is required for get", success=False, operation=op)
            data = await client.request(
                "GET", f"{DRIVE_BASE}/files/{fid}", params={"fields": _DRIVE_FILE_FIELDS}
            )
            return tool_result({"success": True, "data": data})

        return tool_error(f"Unhandled google_drive operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


registry.register(
    name="gmail",
    toolset="google",
    schema=GMAIL_SCHEMA,
    handler=_handle_gmail,
    check_fn=_check,
    is_async=True,
    emoji="📧",
    max_result_size_chars=100_000,
)

registry.register(
    name="google_drive",
    toolset="google",
    schema=DRIVE_SCHEMA,
    handler=_handle_drive,
    check_fn=_check,
    is_async=True,
    emoji="📁",
    max_result_size_chars=100_000,
)
