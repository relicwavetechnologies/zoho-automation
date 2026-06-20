"""Shared helpers for native Google Workspace tool handlers."""

from __future__ import annotations

import base64
import json
from email.message import EmailMessage
from typing import Any

import httpx

from tools.google_scope import (
    GoogleConnectionContext,
    map_google_api_error,
    reconnect_required_error,
    require_google_scopes,
    required_scopes_for_tool,
)
from tools.registry import tool_error, tool_result


def header(headers: list[dict[str, Any]], name: str) -> str:
    for item in headers or []:
        if str(item.get("name", "")).lower() == name.lower():
            return str(item.get("value", ""))
    return ""


def decode_part(data: str) -> str:
    try:
        return base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return ""


def extract_plain_body(payload: dict[str, Any]) -> str:
    if not isinstance(payload, dict):
        return ""
    mime = payload.get("mimeType", "")
    body = payload.get("body", {}) or {}
    if mime == "text/plain" and body.get("data"):
        return decode_part(body["data"])
    for part in payload.get("parts", []) or []:
        text = extract_plain_body(part)
        if text:
            return text
    if body.get("data"):
        return decode_part(body["data"])
    return ""


def build_email_message(
    *,
    to: str,
    subject: str = "",
    body: str = "",
    cc: str = "",
    in_reply_to: str = "",
    references: str = "",
) -> str:
    mail = EmailMessage()
    mail["To"] = to
    if cc:
        mail["Cc"] = cc
    mail["Subject"] = subject
    if in_reply_to:
        mail["In-Reply-To"] = in_reply_to
    if references:
        mail["References"] = references
    mail.set_content(body or "")
    return base64.urlsafe_b64encode(mail.as_bytes()).decode("utf-8")


async def resolve_client_and_scopes(kwargs: dict[str, Any], tool_name: str, op: str):
    explicit = kwargs.get("client")
    if explicit is not None:
        return explicit, None

    try:
        from tools.google_runtime import get_google_connection, resolve_tool_client

        company_id = str(kwargs.get("company_id") or "").strip()
        company_user_id = str(kwargs.get("company_user_id") or "").strip()
        connection = get_google_connection(company_id, company_user_id)
        if connection is None:
            return None, reconnect_required_error(tool_name=tool_name, operation=op)
        scope_err = require_google_scopes(
            connection.granted_scopes,
            required_scopes_for_tool(tool_name),
            tool_name=tool_name,
            operation=op,
        )
        if scope_err:
            return None, scope_err
        client = resolve_tool_client(kwargs)
        return client, None
    except Exception as exc:  # noqa: BLE001
        return None, map_google_api_error(exc, tool_name=tool_name, operation=op)


async def drive_multipart_upload(
    client,
    *,
    name: str,
    content: bytes,
    mime_type: str,
    parent_id: str | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {"name": name}
    if parent_id:
        metadata["parents"] = [parent_id]
    token = await client.token_provider.get_access_token()
    boundary = "hermes_google_boundary"
    meta_json = json.dumps(metadata)
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{meta_json}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {mime_type}\r\n\r\n"
    ).encode("utf-8") + content + f"\r\n--{boundary}--\r\n".encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": f"multipart/related; boundary={boundary}",
    }
    url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink"
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as http:
        resp = await http.post(url, content=body, headers=headers)
    if resp.status_code >= 400:
        raise RuntimeError(f"Drive upload failed ({resp.status_code}): {resp.text[:300]}")
    return resp.json()


async def drive_download_bytes(client, file_id: str, *, export_mime: str | None = None) -> tuple[bytes, str, str]:
    meta = await client.request(
        "GET",
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        params={"fields": "id,name,mimeType"},
    )
    mime = str((meta or {}).get("mimeType") or "")
    name = str((meta or {}).get("name") or file_id)
    token = await client.token_provider.get_access_token()
    headers = {"Authorization": f"Bearer {token}"}
    if mime.startswith("application/vnd.google-apps.") and export_mime:
        url = f"https://www.googleapis.com/drive/v3/files/{file_id}/export"
        params = {"mimeType": export_mime}
    else:
        url = f"https://www.googleapis.com/drive/v3/files/{file_id}"
        params = {"alt": "media"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as http:
        resp = await http.get(url, params=params, headers=headers)
    if resp.status_code >= 400:
        raise RuntimeError(f"Drive download failed ({resp.status_code}): {resp.text[:300]}")
    return resp.content, name, mime


def extract_doc_text(doc: dict[str, Any]) -> str:
    parts: list[str] = []
    for element in (doc.get("body", {}) or {}).get("content", []) or []:
        for pe in (element.get("paragraph", {}) or {}).get("elements", []) or []:
            text_run = pe.get("textRun", {}) or {}
            if text_run.get("content"):
                parts.append(str(text_run["content"]))
    return "".join(parts)


def google_doc_url(document_id: str) -> str:
    return f"https://docs.google.com/document/d/{document_id}/edit"


def google_sheet_url(spreadsheet_id: str) -> str:
    return f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit"


def google_slide_url(presentation_id: str) -> str:
    return f"https://docs.google.com/presentation/d/{presentation_id}/edit"


def ok(data: Any = None, **kwargs: Any) -> str:
    payload: dict[str, Any] = {"success": True}
    if data is not None:
        payload["data"] = data
    payload.update(kwargs)
    return tool_result(payload)
