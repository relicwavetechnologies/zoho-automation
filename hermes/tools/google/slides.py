"""Google Slides grouped tool handler."""

from __future__ import annotations

from typing import Any

from tools.google._helpers import google_slide_url, ok, resolve_client_and_scopes
from tools.registry import tool_error

SLIDES_BASE = "https://slides.googleapis.com/v1"
DRIVE_BASE = "https://www.googleapis.com/drive/v3"

SLIDES_OPS = frozenset({"create", "get", "read_content", "update_text", "export", "share"})

SLIDES_SCHEMA = {
    "name": "google_slides",
    "description": (
        "Google Slides for the connected account. Operations: create, get, read_content, "
        "update_text, export, share."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(SLIDES_OPS)},
            "presentationId": {"type": "string"},
            "title": {"type": "string"},
            "text": {"type": "string"},
            "objectId": {"type": "string", "description": "Text box or shape object id for update_text."},
            "exportMimeType": {"type": "string"},
            "email": {"type": "string"},
            "role": {"type": "string"},
        },
        "required": ["op"],
    },
}


def _extract_slide_text(presentation: dict[str, Any]) -> list[dict[str, Any]]:
    slides_out: list[dict[str, Any]] = []
    for slide in presentation.get("slides", []) or []:
        texts: list[str] = []
        for element in slide.get("pageElements", []) or []:
            shape = element.get("shape", {}) or {}
            text_obj = shape.get("text", {}) or {}
            for text_element in text_obj.get("textElements", []) or []:
                run = text_element.get("textRun", {}) or {}
                if run.get("content"):
                    texts.append(str(run["content"]))
        slides_out.append({"objectId": slide.get("objectId"), "text": "".join(texts)})
    return slides_out


async def handle_slides(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or "").strip()
    if op not in SLIDES_OPS:
        return tool_error(f"Unknown google_slides operation: {op}", success=False)

    client, err = await resolve_client_and_scopes(kwargs, "google_slides", op)
    if err:
        return err

    try:
        if op == "create":
            title = str(args.get("title") or "Untitled Presentation").strip()
            data = await client.request("POST", f"{SLIDES_BASE}/presentations", json_body={"title": title})
            pres_id = str((data or {}).get("presentationId") or "")
            if args.get("text") and pres_id:
                slide_id = (data.get("slides") or [{}])[0].get("objectId")
                if slide_id:
                    await client.request(
                        "POST",
                        f"{SLIDES_BASE}/presentations/{pres_id}:batchUpdate",
                        json_body={
                            "requests": [{
                                "insertText": {
                                    "objectId": slide_id,
                                    "text": str(args["text"]),
                                    "insertionIndex": 0,
                                }
                            }]
                        },
                    )
            if pres_id:
                data = {**(data or {}), "url": google_slide_url(pres_id)}
            return ok(data, message="Presentation created.")

        pres_id = str(args.get("presentationId") or "").strip()
        if op != "create" and not pres_id:
            return tool_error("presentationId is required", success=False, operation=op)

        if op == "get":
            data = await client.request("GET", f"{SLIDES_BASE}/presentations/{pres_id}")
            return ok({
                "presentationId": pres_id,
                "title": data.get("title"),
                "slideCount": len(data.get("slides", [])),
                "url": google_slide_url(pres_id),
            })

        if op == "read_content":
            data = await client.request("GET", f"{SLIDES_BASE}/presentations/{pres_id}")
            return ok(_extract_slide_text(data or {}))

        if op == "update_text":
            text = str(args.get("text") or "")
            object_id = str(args.get("objectId") or "").strip()
            if not text or not object_id:
                return tool_error("objectId and text are required", success=False, operation=op)
            data = await client.request(
                "POST",
                f"{SLIDES_BASE}/presentations/{pres_id}:batchUpdate",
                json_body={"requests": [{"insertText": {"objectId": object_id, "text": text, "insertionIndex": 0}}]},
            )
            return ok(data, message="Slide text updated.")

        if op == "export":
            export_mime = str(args.get("exportMimeType") or "application/pdf")
            from tools.google._helpers import drive_download_bytes
            import base64

            content, name, mime = await drive_download_bytes(client, pres_id, export_mime=export_mime)
            return ok({
                "presentationId": pres_id,
                "name": name,
                "mimeType": mime,
                "url": google_slide_url(pres_id),
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
                f"{DRIVE_BASE}/files/{pres_id}/permissions",
                json_body=permission,
            )
            return ok(data, message="Presentation shared.")

        return tool_error(f"Unhandled google_slides operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        from tools.google_scope import map_google_api_error

        return map_google_api_error(exc, tool_name="google_slides", operation=op)
