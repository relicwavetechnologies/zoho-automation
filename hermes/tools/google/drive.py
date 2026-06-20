"""Google Drive grouped tool handler."""

from __future__ import annotations

import base64
from typing import Any

from tools.google._helpers import (
    drive_download_bytes,
    drive_multipart_upload,
    ok,
    resolve_client_and_scopes,
)
from tools.registry import tool_error

DRIVE_BASE = "https://www.googleapis.com/drive/v3"
DRIVE_OPS = frozenset({
    "list",
    "search",
    "get",
    "download",
    "export",
    "upload",
    "create",
    "share",
    "permissions_update",
})
_DRIVE_FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName,emailAddress)"

DRIVE_SCHEMA = {
    "name": "google_drive",
    "description": (
        "Google Drive for the connected account. Operations: list, search, get, download, "
        "export, upload, create, share, permissions_update."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(DRIVE_OPS)},
            "query": {"type": "string"},
            "fileId": {"type": "string"},
            "name": {"type": "string"},
            "mimeType": {"type": "string"},
            "parentId": {"type": "string"},
            "content": {"type": "string", "description": "Base64 or plain text content for upload."},
            "contentBase64": {"type": "boolean"},
            "exportMimeType": {"type": "string"},
            "maxResults": {"type": "integer", "minimum": 1, "maximum": 100},
            "email": {"type": "string"},
            "role": {"type": "string", "description": "reader, writer, commenter, owner"},
            "type": {"type": "string", "description": "user, group, domain, anyone"},
            "permissionId": {"type": "string"},
        },
        "required": ["op"],
    },
}


async def handle_drive(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or "").strip()
    if op not in DRIVE_OPS:
        return tool_error(f"Unknown google_drive operation: {op}", success=False)

    client, err = await resolve_client_and_scopes(kwargs, "google_drive", op)
    if err:
        return err

    try:
        if op in ("list", "search"):
            page_size = max(1, min(100, int(args.get("maxResults") or 20)))
            params: dict[str, Any] = {"pageSize": page_size, "fields": f"files({_DRIVE_FILE_FIELDS})"}
            if args.get("query"):
                params["q"] = str(args["query"])
            data = await client.request("GET", f"{DRIVE_BASE}/files", params=params)
            files = (data or {}).get("files", [])
            return ok(files, message=f"Found {len(files)} file(s).")

        if op == "get":
            fid = str(args.get("fileId") or "").strip()
            if not fid:
                return tool_error("fileId is required for get", success=False, operation=op)
            data = await client.request(
                "GET", f"{DRIVE_BASE}/files/{fid}", params={"fields": _DRIVE_FILE_FIELDS}
            )
            return ok(data)

        if op in ("download", "export"):
            fid = str(args.get("fileId") or "").strip()
            if not fid:
                return tool_error("fileId is required", success=False, operation=op)
            export_mime = str(args.get("exportMimeType") or "application/pdf") if op == "export" else None
            content, name, mime = await drive_download_bytes(client, fid, export_mime=export_mime)
            return ok({
                "fileId": fid,
                "name": name,
                "mimeType": mime,
                "contentBase64": base64.b64encode(content).decode("ascii"),
                "size": len(content),
            })

        if op == "upload":
            name = str(args.get("name") or "untitled").strip()
            raw = str(args.get("content") or "")
            if args.get("contentBase64"):
                content = base64.b64decode(raw.encode("ascii"))
            else:
                content = raw.encode("utf-8")
            mime = str(args.get("mimeType") or "text/plain")
            data = await drive_multipart_upload(
                client,
                name=name,
                content=content,
                mime_type=mime,
                parent_id=str(args.get("parentId") or "").strip() or None,
            )
            return ok(data, message="File uploaded.")

        if op == "create":
            name = str(args.get("name") or "Untitled").strip()
            mime = str(args.get("mimeType") or "application/vnd.google-apps.document")
            body: dict[str, Any] = {"name": name, "mimeType": mime}
            parent = str(args.get("parentId") or "").strip()
            if parent:
                body["parents"] = [parent]
            data = await client.request(
                "POST",
                f"{DRIVE_BASE}/files",
                params={"fields": _DRIVE_FILE_FIELDS},
                json_body=body,
            )
            return ok(data, message="File created.")

        if op == "share":
            fid = str(args.get("fileId") or "").strip()
            if not fid:
                return tool_error("fileId is required for share", success=False, operation=op)
            permission = {
                "type": str(args.get("type") or "user"),
                "role": str(args.get("role") or "reader"),
            }
            email = str(args.get("email") or "").strip()
            if permission["type"] in {"user", "group"} and email:
                permission["emailAddress"] = email
            data = await client.request(
                "POST",
                f"{DRIVE_BASE}/files/{fid}/permissions",
                params={"fields": "id,type,role,emailAddress"},
                json_body=permission,
            )
            return ok(data, message="Permission added.")

        if op == "permissions_update":
            fid = str(args.get("fileId") or "").strip()
            perm_id = str(args.get("permissionId") or "").strip()
            if not fid or not perm_id:
                return tool_error("fileId and permissionId required", success=False, operation=op)
            body = {"role": str(args.get("role") or "reader")}
            data = await client.request(
                "PATCH",
                f"{DRIVE_BASE}/files/{fid}/permissions/{perm_id}",
                json_body=body,
            )
            return ok(data, message="Permission updated.")

        return tool_error(f"Unhandled google_drive operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        from tools.google_scope import map_google_api_error

        return map_google_api_error(exc, tool_name="google_drive", operation=op)
