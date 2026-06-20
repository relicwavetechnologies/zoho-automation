"""Google Sheets grouped tool handler."""

from __future__ import annotations

import json
from typing import Any

from tools.google._helpers import google_sheet_url, ok, resolve_client_and_scopes
from tools.registry import tool_error

SHEETS_BASE = "https://sheets.googleapis.com/v4"
DRIVE_BASE = "https://www.googleapis.com/drive/v3"

SHEETS_OPS = frozenset({
    "create",
    "read_range",
    "append_rows",
    "update_range",
    "batch_update",
    "export",
    "share",
})

SHEETS_SCHEMA = {
    "name": "google_sheets",
    "description": (
        "Google Sheets for the connected account. Operations: create, read_range, append_rows, "
        "update_range, batch_update, export, share."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(SHEETS_OPS)},
            "spreadsheetId": {"type": "string"},
            "title": {"type": "string"},
            "range": {"type": "string"},
            "values": {"type": "array", "items": {"type": "array"}},
            "requests": {"type": "array", "items": {"type": "object"}},
            "exportMimeType": {"type": "string"},
            "email": {"type": "string"},
            "role": {"type": "string"},
        },
        "required": ["op"],
    },
}


def _parse_values(raw: Any) -> list[list[Any]]:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw.strip():
        return json.loads(raw)
    return []


async def handle_sheets(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or "").strip()
    if op not in SHEETS_OPS:
        return tool_error(f"Unknown google_sheets operation: {op}", success=False)

    client, err = await resolve_client_and_scopes(kwargs, "google_sheets", op)
    if err:
        return err

    try:
        if op == "create":
            title = str(args.get("title") or "Untitled Spreadsheet").strip()
            data = await client.request(
                "POST",
                f"{SHEETS_BASE}/spreadsheets",
                json_body={"properties": {"title": title}},
            )
            sheet_id = str((data or {}).get("spreadsheetId") or "")
            if sheet_id:
                data = {
                    **(data or {}),
                    "url": (data or {}).get("spreadsheetUrl") or google_sheet_url(sheet_id),
                    "spreadsheetUrl": (data or {}).get("spreadsheetUrl") or google_sheet_url(sheet_id),
                }
            return ok(data, message="Spreadsheet created.")

        sheet_id = str(args.get("spreadsheetId") or "").strip()
        if op != "create" and not sheet_id:
            return tool_error("spreadsheetId is required", success=False, operation=op)

        if op == "read_range":
            a_range = str(args.get("range") or "Sheet1!A1:Z1000")
            data = await client.request(
                "GET",
                f"{SHEETS_BASE}/spreadsheets/{sheet_id}/values/{a_range}",
            )
            return ok(data.get("values", []))

        if op == "append_rows":
            a_range = str(args.get("range") or "Sheet1!A1")
            values = _parse_values(args.get("values"))
            data = await client.request(
                "POST",
                f"{SHEETS_BASE}/spreadsheets/{sheet_id}/values/{a_range}:append",
                params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
                json_body={"values": values},
            )
            return ok(data, message="Rows appended.")

        if op == "update_range":
            a_range = str(args.get("range") or "Sheet1!A1")
            values = _parse_values(args.get("values"))
            data = await client.request(
                "PUT",
                f"{SHEETS_BASE}/spreadsheets/{sheet_id}/values/{a_range}",
                params={"valueInputOption": "USER_ENTERED"},
                json_body={"values": values},
            )
            return ok(data, message="Range updated.")

        if op == "batch_update":
            requests = args.get("requests")
            if not isinstance(requests, list) or not requests:
                return tool_error("requests array is required", success=False, operation=op)
            data = await client.request(
                "POST",
                f"{SHEETS_BASE}/spreadsheets/{sheet_id}:batchUpdate",
                json_body={"requests": requests},
            )
            return ok(data, message="Batch update applied.")

        if op == "export":
            export_mime = str(args.get("exportMimeType") or "text/csv")
            from tools.google._helpers import drive_download_bytes
            import base64

            content, name, mime = await drive_download_bytes(client, sheet_id, export_mime=export_mime)
            return ok({
                "spreadsheetId": sheet_id,
                "name": name,
                "mimeType": mime,
                "url": google_sheet_url(sheet_id),
                "spreadsheetUrl": google_sheet_url(sheet_id),
                "contentBase64": base64.b64encode(content).decode("ascii"),
            })

        if op == "share":
            permission = {
                "type": "user",
                "role": str(args.get("role") or "reader"),
                "emailAddress": str(args.get("email") or "").strip(),
            }
            data = await client.request(
                "POST",
                f"{DRIVE_BASE}/files/{sheet_id}/permissions",
                json_body=permission,
            )
            return ok(data, message="Spreadsheet shared.")

        return tool_error(f"Unhandled google_sheets operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        from tools.google_scope import map_google_api_error

        return map_google_api_error(exc, tool_name="google_sheets", operation=op)
