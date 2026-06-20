"""Google Docs grouped tool handler."""

from __future__ import annotations

import re
from typing import Any

from tools.google._helpers import extract_doc_text, google_doc_url, ok, resolve_client_and_scopes
from tools.registry import tool_error

DOCS_BASE = "https://docs.googleapis.com/v1"
DRIVE_BASE = "https://www.googleapis.com/drive/v3"

DOCS_OPS = frozenset({"create", "read", "append", "patch", "export", "share"})

DOCS_SCHEMA = {
    "name": "google_docs",
    "description": (
        "Google Docs for the connected account. Operations: create, read, append, patch, export, share."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(DOCS_OPS)},
            "documentId": {"type": "string"},
            "title": {"type": "string"},
            "text": {
                "type": "string",
                "description": "Document body. Markdown-like headings, lists, dividers, and pipe tables are converted to Google Docs formatting.",
            },
            "exportMimeType": {"type": "string", "description": "Default text/plain"},
            "email": {"type": "string"},
            "role": {"type": "string"},
        },
        "required": ["op"],
    },
}


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_ORDERED_LIST_RE = re.compile(r"^\s*\d+[.)]\s+(.+?)\s*$")
_UNORDERED_LIST_RE = re.compile(r"^\s*[-*+]\s+(.+?)\s*$")
_TABLE_SEPARATOR_RE = re.compile(r"^:?-{3,}:?$")
_ESCAPED_PIPE_RE = re.compile(r"\\\|")


def _docs_index_len(text: str) -> int:
    """Google Docs indexes are UTF-16 code units, not Python code points."""
    return len(str(text or "").encode("utf-16-le")) // 2


def _strip_inline_markdown(text: str) -> str:
    value = str(text or "")
    value = _ESCAPED_PIPE_RE.sub("|", value)
    value = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", value)
    value = re.sub(r"(`+)(.*?)\1", r"\2", value)
    value = re.sub(r"(\*\*|__)(.*?)\1", r"\2", value)
    value = re.sub(r"(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)", r"\1", value)
    value = re.sub(r"(?<!_)_(?!_)([^_\n]+?)(?<!_)_(?!_)", r"\1", value)
    return value


def _pipe_table_cells(line: str) -> list[str] | None:
    stripped = _ESCAPED_PIPE_RE.sub("|", line).strip()
    if not (stripped.startswith("|") and stripped.endswith("|")):
        return None
    cells = [cell.strip() for cell in stripped.strip("|").split("|")]
    if len(cells) < 2:
        return None
    return cells


def _is_table_separator(cells: list[str]) -> bool:
    return all(_TABLE_SEPARATOR_RE.match(cell.replace(" ", "")) for cell in cells)


def _markdown_segments(text: str) -> list[tuple[str, str | list[list[str]]]]:
    segments: list[tuple[str, str | list[list[str]]]] = []
    text_lines: list[str] = []

    def flush_text() -> None:
        if text_lines:
            segments.append(("text", "\n".join(text_lines) + "\n"))
            text_lines.clear()

    lines = str(text or "").splitlines()
    i = 0
    while i < len(lines):
        cells = _pipe_table_cells(lines[i])
        if cells is None:
            text_lines.append(lines[i])
            i += 1
            continue

        rows: list[list[str]] = []
        while i < len(lines):
            row_cells = _pipe_table_cells(lines[i])
            if row_cells is None:
                break
            i += 1
            if _is_table_separator(row_cells):
                continue
            rows.append([_strip_inline_markdown(cell).strip() for cell in row_cells])
        if rows:
            flush_text()
            segments.append(("table", rows))
    flush_text()
    return segments


def _markdown_insert_requests(text: str, index: int) -> list[dict[str, Any]]:
    """Convert a useful markdown subset into Docs API insert/style requests.

    Google Docs does not interpret markdown in insertText. This formatter keeps
    the body readable by removing markdown control characters and applying the
    native paragraph styles we can express reliably in one batchUpdate call.
    """
    cursor = max(1, int(index))
    out_parts: list[str] = []
    requests: list[dict[str, Any]] = []
    paragraph_styles: list[tuple[int, int, str]] = []
    bullet_ranges: list[tuple[int, int, str]] = []
    text_styles: list[tuple[int, int, dict[str, Any], str]] = []

    def append_line(
        line: str,
        *,
        style: str | None = None,
        bullet: str | None = None,
        text_style: dict[str, Any] | None = None,
        fields: str | None = None,
    ) -> None:
        nonlocal cursor
        clean = _strip_inline_markdown(line).rstrip()
        start = cursor
        segment = clean + "\n"
        out_parts.append(segment)
        cursor += _docs_index_len(segment)
        end = cursor
        if style:
            paragraph_styles.append((start, end, style))
        if bullet:
            bullet_ranges.append((start, end, bullet))
        if text_style and clean:
            text_styles.append((start, start + _docs_index_len(clean), text_style, fields or ",".join(text_style.keys())))

    lines = str(text or "").splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        if not stripped:
            append_line("")
            i += 1
            continue
        if stripped in {"---", "***", "___"}:
            append_line("")
            i += 1
            continue

        cells = _pipe_table_cells(raw)
        if cells is not None:
            first_table_line = True
            while i < len(lines):
                row_cells = _pipe_table_cells(lines[i])
                if row_cells is None:
                    break
                i += 1
                if _is_table_separator(row_cells):
                    continue
                append_line(
                    "\t".join(row_cells),
                    text_style={"bold": True} if first_table_line else None,
                    fields="bold" if first_table_line else None,
                )
                first_table_line = False
            continue

        heading = _HEADING_RE.match(raw)
        if heading:
            level = min(6, len(heading.group(1)))
            style = f"HEADING_{level}" if level <= 6 else "NORMAL_TEXT"
            heading_size = {1: 20, 2: 16, 3: 14}.get(level, 12)
            append_line(
                heading.group(2),
                style=style,
                text_style={"bold": True, "fontSize": {"magnitude": heading_size, "unit": "PT"}},
                fields="bold,fontSize",
            )
            i += 1
            continue

        ordered = _ORDERED_LIST_RE.match(raw)
        if ordered:
            append_line(ordered.group(1), bullet="NUMBERED_DECIMAL_ALPHA_ROMAN")
            i += 1
            continue

        unordered = _UNORDERED_LIST_RE.match(raw)
        if unordered:
            append_line(unordered.group(1), bullet="BULLET_DISC_CIRCLE_SQUARE")
            i += 1
            continue

        append_line(raw)
        i += 1

    body = "".join(out_parts)
    if not body:
        return []
    requests.append({"insertText": {"location": {"index": max(1, int(index))}, "text": body}})
    for start, end, style in paragraph_styles:
        requests.append({
            "updateParagraphStyle": {
                "range": {"startIndex": start, "endIndex": end},
                "paragraphStyle": {"namedStyleType": style},
                "fields": "namedStyleType",
            }
        })
    for start, end, preset in bullet_ranges:
        requests.append({
            "createParagraphBullets": {
                "range": {"startIndex": start, "endIndex": end},
                "bulletPreset": preset,
            }
        })
    for start, end, text_style, fields in text_styles:
        requests.append({
            "updateTextStyle": {
                "range": {"startIndex": start, "endIndex": end},
                "textStyle": text_style,
                "fields": fields,
            }
        })
    return requests


def _normalize_table_rows(rows: list[list[str]]) -> list[list[str]]:
    width = max((len(row) for row in rows), default=0)
    if width <= 0:
        return []
    return [row + [""] * (width - len(row)) for row in rows]


def _find_table_cells(doc: dict[str, Any], *, min_start_index: int) -> list[list[int]]:
    for element in (doc.get("body", {}) or {}).get("content", []) or []:
        table = element.get("table")
        start_index = int(element.get("startIndex") or 0)
        if not isinstance(table, dict) or start_index < min_start_index:
            continue
        cell_indexes: list[list[int]] = []
        for row in table.get("tableRows", []) or []:
            row_indexes: list[int] = []
            for cell in row.get("tableCells", []) or []:
                content = cell.get("content", []) or []
                first = content[0] if content else {}
                row_indexes.append(int(first.get("startIndex") or cell.get("startIndex") or 0))
            cell_indexes.append(row_indexes)
        return cell_indexes
    return []


async def _document_end_index(client, doc_id: str) -> int:
    doc = await client.request("GET", f"{DOCS_BASE}/documents/{doc_id}")
    content = (doc.get("body", {}) or {}).get("content", []) or []
    if not content:
        return 1
    return max(1, int((content[-1] or {}).get("endIndex") or 1) - 1)


async def _insert_native_table(client, doc_id: str, rows: list[list[str]], index: int) -> None:
    normalized = _normalize_table_rows(rows)
    if not normalized:
        return
    await client.request(
        "POST",
        f"{DOCS_BASE}/documents/{doc_id}:batchUpdate",
        json_body={
            "requests": [{
                "insertTable": {
                    "rows": len(normalized),
                    "columns": len(normalized[0]),
                    "location": {"index": max(1, int(index))},
                }
            }]
        },
    )
    doc = await client.request("GET", f"{DOCS_BASE}/documents/{doc_id}")
    cell_indexes = _find_table_cells(doc or {}, min_start_index=max(1, int(index)))
    requests: list[dict[str, Any]] = []
    for row_index in range(min(len(normalized), len(cell_indexes)) - 1, -1, -1):
        row = normalized[row_index]
        cells = cell_indexes[row_index]
        for col_index in range(min(len(row), len(cells)) - 1, -1, -1):
            cell_text = row[col_index]
            cell_start = cells[col_index]
            if not cell_text or cell_start <= 0:
                continue
            requests.append({"insertText": {"location": {"index": cell_start}, "text": cell_text}})
            if row_index == 0:
                requests.append({
                    "updateTextStyle": {
                        "range": {"startIndex": cell_start, "endIndex": cell_start + _docs_index_len(cell_text)},
                        "textStyle": {"bold": True},
                        "fields": "bold",
                    }
                })
    if requests:
        await client.request(
            "POST",
            f"{DOCS_BASE}/documents/{doc_id}:batchUpdate",
            json_body={"requests": requests},
        )


async def _apply_markdown_document_body(client, doc_id: str, text: str, index: int) -> None:
    cursor = max(1, int(index))
    for segment_type, payload in _markdown_segments(text):
        if segment_type == "text":
            requests = _markdown_insert_requests(str(payload), cursor)
            if not requests:
                continue
            await client.request(
                "POST",
                f"{DOCS_BASE}/documents/{doc_id}:batchUpdate",
                json_body={"requests": requests},
            )
            inserted = requests[0].get("insertText", {}).get("text", "")
            cursor += _docs_index_len(str(inserted))
            continue
        await _insert_native_table(client, doc_id, payload, cursor)  # type: ignore[arg-type]
        cursor = await _document_end_index(client, doc_id)


def _extract_doc_blocks(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Return light structural metadata so agents can verify formatting."""
    blocks: list[dict[str, Any]] = []
    for element in (doc.get("body", {}) or {}).get("content", []) or []:
        paragraph = element.get("paragraph")
        if isinstance(paragraph, dict):
            text = "".join(
                str(((pe.get("textRun") or {}).get("content") or ""))
                for pe in paragraph.get("elements", []) or []
            ).rstrip("\n")
            if text:
                blocks.append({
                    "type": "paragraph",
                    "text": text,
                    "namedStyleType": ((paragraph.get("paragraphStyle") or {}).get("namedStyleType") or "NORMAL_TEXT"),
                    "isListItem": bool(paragraph.get("bullet")),
                })
            continue
        table = element.get("table")
        if isinstance(table, dict):
            rows: list[list[str]] = []
            for row in table.get("tableRows", []) or []:
                values: list[str] = []
                for cell in row.get("tableCells", []) or []:
                    values.append(extract_doc_text({"body": {"content": cell.get("content", []) or []}}).strip())
                rows.append(values)
            blocks.append({"type": "table", "rows": rows})
    return blocks


async def handle_docs(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or "").strip()
    if op not in DOCS_OPS:
        return tool_error(f"Unknown google_docs operation: {op}", success=False)

    client, err = await resolve_client_and_scopes(kwargs, "google_docs", op)
    if err:
        return err

    try:
        if op == "create":
            title = str(args.get("title") or "Untitled").strip()
            data = await client.request("POST", f"{DOCS_BASE}/documents", json_body={"title": title})
            doc_id = str((data or {}).get("documentId") or "")
            if args.get("text") and doc_id:
                await _apply_markdown_document_body(client, doc_id, str(args["text"]), 1)
            if doc_id:
                data = {**(data or {}), "url": google_doc_url(doc_id), "docUrl": google_doc_url(doc_id)}
            return ok(data, message="Document created.")

        doc_id = str(args.get("documentId") or "").strip()
        if op != "create" and not doc_id and op != "share":
            return tool_error("documentId is required", success=False, operation=op)

        if op == "read":
            data = await client.request("GET", f"{DOCS_BASE}/documents/{doc_id}")
            return ok({
                "documentId": doc_id,
                "title": data.get("title"),
                "text": extract_doc_text(data or {}),
                "blocks": _extract_doc_blocks(data or {}),
                "url": google_doc_url(doc_id),
                "docUrl": google_doc_url(doc_id),
            })

        if op == "append":
            text = str(args.get("text") or "")
            if not text:
                return tool_error("text is required for append", success=False, operation=op)
            doc = await client.request("GET", f"{DOCS_BASE}/documents/{doc_id}")
            end_index = int((doc.get("body", {}) or {}).get("content", [{}])[-1].get("endIndex", 1)) - 1
            await _apply_markdown_document_body(client, doc_id, text, max(1, end_index))
            return ok({"documentId": doc_id, "url": google_doc_url(doc_id), "docUrl": google_doc_url(doc_id)}, message="Text appended.")

        if op == "patch":
            text = str(args.get("text") or "")
            if not text:
                return tool_error("text is required for patch", success=False, operation=op)
            doc = await client.request("GET", f"{DOCS_BASE}/documents/{doc_id}")
            end_index = int((doc.get("body", {}) or {}).get("content", [{}])[-1].get("endIndex", 1)) - 1
            requests = []
            if end_index > 1:
                requests.append({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end_index}}})
            if requests:
                await client.request(
                    "POST",
                    f"{DOCS_BASE}/documents/{doc_id}:batchUpdate",
                    json_body={"requests": requests},
                )
            await _apply_markdown_document_body(client, doc_id, text, 1)
            return ok({"documentId": doc_id, "url": google_doc_url(doc_id), "docUrl": google_doc_url(doc_id)}, message="Document updated.")

        if op == "export":
            export_mime = str(args.get("exportMimeType") or "text/plain")
            from tools.google._helpers import drive_download_bytes

            content, name, mime = await drive_download_bytes(client, doc_id, export_mime=export_mime)
            import base64

            return ok({
                "documentId": doc_id,
                "name": name,
                "mimeType": mime,
                "url": google_doc_url(doc_id),
                "docUrl": google_doc_url(doc_id),
                "contentBase64": base64.b64encode(content).decode("ascii"),
            })

        if op == "share":
            if not doc_id:
                return tool_error("documentId is required for share", success=False, operation=op)
            permission = {
                "type": "user",
                "role": str(args.get("role") or "reader"),
                "emailAddress": str(args.get("email") or "").strip(),
            }
            data = await client.request(
                "POST",
                f"{DRIVE_BASE}/files/{doc_id}/permissions",
                json_body=permission,
            )
            return ok(data, message="Document shared.")

        return tool_error(f"Unhandled google_docs operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        from tools.google_scope import map_google_api_error

        return map_google_api_error(exc, tool_name="google_docs", operation=op)
