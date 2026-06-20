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
import time
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


def _user_client(kwargs: dict, *, strict: bool = False):
    """Resolve a user-token LarkClient when available; return None otherwise."""
    try:
        from tools.lark_runtime import resolve_tool_user_client

        enriched = dict(kwargs)
        enriched.setdefault("lark_open_id", _session_lark_user_id(kwargs))
        return resolve_tool_user_client(enriched)
    except Exception:  # noqa: BLE001
        if strict:
            raise
        return None


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

LARK_MESSAGING_OPS = {
    "send",
    "list",
    "get",
    "reply",
    "send_dm",
    "list_chats",
    "search",
    "mention",
    "listMentionsMine",
}
_RECEIVE_ID_TYPES = {"open_id", "user_id", "union_id", "email", "chat_id"}

LARK_MESSAGING_SCHEMA = {
    "name": "lark_messaging",
    "description": "Send, reply, DM, mention, list/search messages, and list chats in Lark/Feishu.",
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_MESSAGING_OPS)},
            "chatId": {
                "type": "string",
                "description": "Target chat ID for send/list/search/mention. If omitted in a Lark session, the current chat is used.",
            },
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


def _message_payload_for_text(text: str) -> tuple[str, str]:
    """Return the best Lark msg_type/content pair for human-facing text.

    Lark plain text does not render markdown. Reuse the Feishu/Lark gateway
    renderer so tables become native cards, ordinary markdown becomes rich
    post content, and truly plain content stays a text message.
    """
    value = str(text or "")
    try:
        from gateway.platforms.feishu import (
            _MARKDOWN_HINT_RE,
            _MARKDOWN_TABLE_RE,
            _build_interactive_markdown_card_payload,
            _build_markdown_post_payload,
        )

        if _MARKDOWN_TABLE_RE.search(value):
            return "interactive", _build_interactive_markdown_card_payload(value)
        if _MARKDOWN_HINT_RE.search(value):
            return "post", _build_markdown_post_payload(value)
    except Exception:  # noqa: BLE001
        pass
    return "text", _text_message_content(value)


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
            receive_id = str(args.get("chatId") or args.get("receiveId") or "").strip() or _session_lark_chat_id(kwargs)
            if not receive_id:
                return tool_error("chatId or receiveId is required for send", success=False, operation=op)
            receive_id_type = str(args.get("receiveIdType") or "chat_id").strip()
            if receive_id_type not in _RECEIVE_ID_TYPES:
                receive_id_type = "chat_id"
            msg_type, content = _message_payload_for_text(str(args.get("text") or ""))
            data = await client.request(
                "POST",
                "/open-apis/im/v1/messages",
                params={"receive_id_type": receive_id_type},
                json_body={
                    "receive_id": receive_id,
                    "msg_type": msg_type,
                    "content": content,
                },
            )
            return tool_result({"success": True, "message": "Message sent.", "messageId": _message_id(data or {})})
        if op == "reply":
            message_id = str(args.get("messageId") or "").strip()
            text = str(args.get("text") or "")
            if not message_id or not text:
                return tool_error("messageId and text are required for reply", success=False, operation=op)
            msg_type, content = _message_payload_for_text(text)
            data = await client.request(
                "POST",
                f"/open-apis/im/v1/messages/{message_id}/reply",
                json_body={"msg_type": msg_type, "content": content},
            )
            return tool_result({"success": True, "message": "Reply sent.", "messageId": _message_id(data or {})})
        if op == "send_dm":
            text = str(args.get("text") or "")
            if not text:
                return tool_error("text is required for send_dm", success=False, operation=op)
            open_id = str(args.get("receiveId") or args.get("chatId") or "").strip()
            if not open_id and args.get("recipientName"):
                search_client = _user_client(kwargs) or client
                resolved = await _resolve_lark_people_live(
                    search_client,
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
            msg_type, content = _message_payload_for_text(text)
            data = await client.request(
                "POST",
                "/open-apis/im/v1/messages",
                params={"receive_id_type": "open_id"},
                json_body={"receive_id": open_id, "msg_type": msg_type, "content": content},
            )
            return tool_result({"success": True, "message": "DM sent.", "messageId": _message_id(data or {})})
        if op == "mention":
            chat_id = str(args.get("chatId") or args.get("receiveId") or "").strip() or _session_lark_chat_id(kwargs)
            text = str(args.get("text") or "")
            names = [str(item).strip() for item in (args.get("mentionNames") or []) if str(item).strip()]
            if not chat_id or not text or not names:
                return tool_error("chatId, text, and mentionNames are required for mention", success=False, operation=op)
            search_client = _user_client(kwargs) or client
            resolved = await _resolve_lark_people_live(
                search_client,
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
            chat_id = str(args.get("chatId") or "").strip() or _session_lark_chat_id(kwargs)
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
            chat_id = str(args.get("chatId") or "").strip() or _session_lark_chat_id(kwargs)
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
        if op == "listMentionsMine":
            limit = _limit_arg(args, default=8, maximum=20)
            user_open_id = _session_lark_user_id(kwargs)
            if not user_open_id:
                return tool_result({"success": True, "data": [], "message": "No Lark user context for mentions."})
            search_client = _user_client(kwargs) or client
            try:
                data = await search_client.request(
                    "POST",
                    "/open-apis/search/v1/message",
                    json_body={
                        "query": f"@{user_open_id}",
                        "count": limit,
                    },
                )
            except Exception:  # noqa: BLE001 - degrade when search scope unavailable
                return tool_result({"success": True, "data": [], "message": "Mention search unavailable."})
            items = (data or {}).get("items") or (data or {}).get("messages") or []
            mentions = []
            for item in items[:limit]:
                if not isinstance(item, dict):
                    continue
                mentions.append({
                    "messageId": item.get("message_id") or item.get("id"),
                    "chatId": item.get("chat_id"),
                    "chatName": item.get("chat_name") or item.get("container_name"),
                    "senderName": item.get("sender_name") or item.get("from_name"),
                    "text": _parse_message_text(item) if item.get("body") else str(item.get("text") or ""),
                    "createTime": item.get("create_time"),
                })
            return tool_result({"success": True, "data": mentions, "message": f"Found {len(mentions)} mention(s)."})
        return tool_error(f"Unhandled lark_messaging operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# ── Doc (Docx v1) ────────────────────────────────────────────────────────────

LARK_DOC_OPS = {
    "get",
    "create",
    "create_markdown",
    "list_blocks",
    "append_block",
    "append_markdown",
    "update_block",
    "delete_block",
    "insert_table",
    "share",
}
_BLOCK_TYPES = {"text": 2, "heading1": 3, "heading2": 4, "heading3": 5, "bullet": 12, "code": 14}
_SHARE_VISIBILITY = {
    "anyone": {"external_access": True, "link_share_entity": "anyone_readable"},
    "tenant": {"external_access": False, "link_share_entity": "tenant_readable"},
    "specified": {"link_share_entity": "closed"},
}
_SHARE_VISIBILITY_ALIASES = {
    "company": "tenant",
    "organization": "tenant",
    "org": "tenant",
    "workspace": "tenant",
    "only_me": "specified",
    "private": "specified",
    "restricted": "specified",
    **{key: key for key in _SHARE_VISIBILITY},
}

LARK_DOC_SCHEMA = {
    "name": "lark_doc",
    "description": (
        "Lark/Feishu Docx documents. Operations: get (metadata + plain text), create, list_blocks, "
        "append_block, update_block, delete_block, insert_table, share. For polished documents, prefer "
        "create_markdown or append_markdown with markdown content; these use Lark Docs AI markdown import "
        "rather than hand-built Docx blocks. Created/read docs return docToken plus url/docUrl when available."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_DOC_OPS)},
            "docToken": {"type": "string"},
            "title": {"type": "string"},
            "blockId": {"type": "string"},
            "content": {"type": "string"},
            "markdown": {"type": "string", "description": "Markdown-style document body for create_markdown/append_markdown."},
            "blockType": {"type": "string", "enum": sorted(_BLOCK_TYPES)},
            "rows": {"type": "integer", "minimum": 1},
            "cols": {"type": "integer", "minimum": 1},
            "visibility": {"type": "string", "enum": sorted(_SHARE_VISIBILITY_ALIASES)},
        },
        "required": ["op"],
    },
}


def _text_children(content: str, block_type: int) -> dict[str, Any]:
    return {"block_type": block_type, "text": {"elements": [{"text_run": {"content": content}}], "style": {}}}


def _doc_response_url(document: dict[str, Any]) -> str:
    for key in ("url", "doc_url", "docUrl", "document_url", "documentUrl", "link", "share_url", "shareUrl"):
        value = str(document.get(key) or "").strip()
        if value.startswith(("http://", "https://")):
            return value
    return ""


def _doc_token_from_response(data: dict[str, Any] | None) -> str:
    payload = data or {}
    document = payload.get("document") if isinstance(payload.get("document"), dict) else {}
    for source in (document, payload):
        for key in ("document_id", "documentId", "doc_token", "docToken", "token", "obj_token", "objToken"):
            value = str(source.get(key) or "").strip()
            if value:
                return value
    return ""


def _lark_doc_url(document: dict[str, Any] | None = None) -> str:
    response_url = _doc_response_url(document or {})
    if response_url:
        return response_url
    return ""


def _doc_reference_payload(doc_token: str, document: dict[str, Any] | None = None) -> dict[str, str]:
    doc_url = _lark_doc_url(document)
    payload = {"docToken": doc_token}
    if doc_url:
        payload["url"] = doc_url
        payload["docUrl"] = doc_url
    else:
        payload["urlHint"] = (
            "Lark did not return a document URL. The tool attempted Drive metadata lookup "
            "with with_url=true; check that the Lark app has drive metadata/read scopes. "
            "Use the docToken to locate the document in Lark."
        )
    return payload


async def _fetch_doc_meta(client: Any, doc_token: str) -> dict[str, Any]:
    doc_token = str(doc_token or "").strip()
    if not doc_token:
        return {}
    data = await client.request(
        "POST",
        "/open-apis/drive/v1/metas/batch_query",
        json_body={
            "request_docs": [{"doc_token": doc_token, "doc_type": "docx"}],
            "with_url": True,
        },
    )
    metas = (data or {}).get("metas") or []
    for meta in metas:
        if not isinstance(meta, dict):
            continue
        request_info = meta.get("request_doc_info") if isinstance(meta.get("request_doc_info"), dict) else {}
        if meta.get("doc_token") == doc_token or request_info.get("doc_token") == doc_token:
            return meta
    return metas[0] if metas and isinstance(metas[0], dict) else {}


async def _doc_reference_from_api(client: Any, doc_token: str, document: dict[str, Any] | None = None) -> dict[str, str]:
    merged = dict(document or {})
    try:
        meta = await _fetch_doc_meta(client, doc_token)
        merged.update({key: value for key, value in meta.items() if value is not None})
    except Exception as exc:  # noqa: BLE001
        payload = _doc_reference_payload(doc_token, merged)
        payload["urlLookupError"] = str(exc)
        return payload
    return _doc_reference_payload(doc_token, merged)


def _ensure_markdown_title(title: str, markdown: str) -> str:
    body = str(markdown or "").strip()
    if not body:
        return ""
    first = next((line.strip() for line in body.splitlines() if line.strip()), "")
    if first.startswith("# "):
        return body
    title = str(title or "").strip()
    return f"# {title}\n\n{body}" if title else body


def _flush_paragraph(blocks: list[dict[str, Any]], lines: list[str]) -> None:
    if not lines:
        return
    text = " ".join(line.strip() for line in lines if line.strip()).strip()
    lines.clear()
    if text:
        blocks.append(_text_children(text, _BLOCK_TYPES["text"]))


def _looks_like_table_line(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("|") and stripped.endswith("|") and stripped.count("|") >= 2


def _looks_like_table_separator(line: str) -> bool:
    stripped = line.strip().strip("|")
    cells = [cell.strip() for cell in stripped.split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell or "") for cell in cells)


def _format_markdown_table(lines: list[str]) -> str:
    rows = [[cell.strip() for cell in line.strip().strip("|").split("|")] for line in lines]
    rows = [row for row in rows if not all(re.fullmatch(r":?-{3,}:?", cell or "") for cell in row)]
    if not rows:
        return "\n".join(lines)
    width = max(len(row) for row in rows)
    normalized = [row + [""] * (width - len(row)) for row in rows]
    col_widths = [max(len(row[idx]) for row in normalized) for idx in range(width)]
    rendered: list[str] = []
    for idx, row in enumerate(normalized):
        rendered.append(" | ".join(cell.ljust(col_widths[col]) for col, cell in enumerate(row)).rstrip())
        if idx == 0 and len(normalized) > 1:
            rendered.append("-+-".join("-" * col_widths[col] for col in range(width)))
    return "\n".join(rendered)


def _markdown_to_lark_blocks(markdown: str) -> list[dict[str, Any]]:
    """Convert a small, predictable markdown subset into Docx text blocks."""
    blocks: list[dict[str, Any]] = []
    paragraph: list[str] = []
    code_lines: list[str] | None = None
    table_lines: list[str] = []

    def flush_table() -> None:
        if not table_lines:
            return
        blocks.append(_text_children(_format_markdown_table(table_lines), _BLOCK_TYPES["code"]))
        table_lines.clear()

    for raw_line in str(markdown or "").splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()

        if code_lines is not None:
            if stripped.startswith("```"):
                blocks.append(_text_children("\n".join(code_lines).strip("\n"), _BLOCK_TYPES["code"]))
                code_lines = None
            else:
                code_lines.append(line)
            continue

        if stripped.startswith("```"):
            flush_table()
            _flush_paragraph(blocks, paragraph)
            code_lines = []
            continue

        if _looks_like_table_line(line) or (table_lines and _looks_like_table_separator(line)):
            _flush_paragraph(blocks, paragraph)
            table_lines.append(line)
            continue

        flush_table()
        if not stripped:
            _flush_paragraph(blocks, paragraph)
            continue

        heading = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        if heading:
            _flush_paragraph(blocks, paragraph)
            level = len(heading.group(1))
            blocks.append(_text_children(heading.group(2).strip(), _BLOCK_TYPES[f"heading{level}"]))
            continue

        bullet = re.match(r"^[-*•]\s+(.+)$", stripped)
        numbered = re.match(r"^\d+[.)]\s+(.+)$", stripped)
        if bullet or numbered:
            _flush_paragraph(blocks, paragraph)
            blocks.append(_text_children((bullet or numbered).group(1).strip(), _BLOCK_TYPES["bullet"]))
            continue

        quote = re.match(r"^>\s?(.+)$", stripped)
        paragraph.append(quote.group(1).strip() if quote else stripped)

    if code_lines is not None:
        blocks.append(_text_children("\n".join(code_lines).strip("\n"), _BLOCK_TYPES["code"]))
    flush_table()
    _flush_paragraph(blocks, paragraph)
    return blocks


async def _append_doc_blocks(client: Any, doc_token: str, blocks: list[dict[str, Any]]) -> int:
    if not blocks:
        return 0
    await client.request(
        "POST",
        f"/open-apis/docx/v1/documents/{doc_token}/blocks/{doc_token}/children",
        json_body={"children": blocks, "document_revision_id": -1},
    )
    return len(blocks)


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
            data = await client.request(
                "POST",
                "/open-apis/docs_ai/v1/documents",
                json_body={"content": f"<title>{title}</title>", "format": "xml"},
            )
            doc = (data or {}).get("document", data or {})
            doc_token = _doc_token_from_response(data)
            doc_ref = await _doc_reference_from_api(client, doc_token, doc)
            return tool_result({
                "success": True,
                **doc_ref,
                "data": {**doc, **doc_ref},
            })
        if op == "create_markdown":
            title = str(args.get("title") or "").strip()
            markdown = str(args.get("markdown") or args.get("content") or "").strip()
            if not title or not markdown:
                return tool_error("title and markdown/content are required for create_markdown", success=False, operation=op)
            content = _ensure_markdown_title(title, markdown)
            data = await client.request(
                "POST",
                "/open-apis/docs_ai/v1/documents",
                json_body={"content": content, "format": "markdown"},
            )
            doc = (data or {}).get("document", data or {})
            doc_token = _doc_token_from_response(data)
            if not doc_token:
                return tool_error("Lark did not return a document_id", success=False, operation=op)
            doc_ref = await _doc_reference_from_api(client, doc_token, doc)
            return tool_result({
                "success": True,
                **doc_ref,
                "message": "Document created from markdown.",
                "data": {**doc, **doc_ref},
            })

        doc_token = str(args.get("docToken") or "").strip()
        if not doc_token:
            return tool_error("docToken is required", success=False, operation=op)

        if op == "get":
            meta = await client.request("GET", f"/open-apis/docx/v1/documents/{doc_token}")
            raw = await client.request("GET", f"/open-apis/docx/v1/documents/{doc_token}/raw_content")
            doc = (meta or {}).get("document", meta)
            doc_ref = await _doc_reference_from_api(client, doc_token, doc if isinstance(doc, dict) else {})
            return tool_result({
                "success": True,
                **doc_ref,
                "data": {"document": doc, "content": (raw or {}).get("content", ""), **doc_ref},
            })
        if op == "list_blocks":
            data = await client.request("GET", f"/open-apis/docx/v1/documents/{doc_token}/blocks")
            return tool_result({"success": True, "data": (data or {}).get("items", [])})
        if op == "append_block":
            content = str(args.get("content") or "")
            block_type = _BLOCK_TYPES.get(str(args.get("blockType") or "text"), 2)
            await _append_doc_blocks(client, doc_token, [_text_children(content, block_type)])
            return tool_result({"success": True, "message": "Block appended."})
        if op == "append_markdown":
            markdown = str(args.get("markdown") or args.get("content") or "").strip()
            if not markdown:
                return tool_error("markdown/content is required for append_markdown", success=False, operation=op)
            await client.request(
                "PUT",
                f"/open-apis/docs_ai/v1/documents/{doc_token}",
                json_body={
                    "block_id": "-1",
                    "command": "block_insert_after",
                    "content": markdown,
                    "format": "markdown",
                    "revision_id": -1,
                },
            )
            return tool_result({"success": True, "message": "Markdown appended."})
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
                    "children": [{"block_type": 31, "table": {"property": {"row_size": rows, "column_size": cols}}}],
                    "document_revision_id": -1,
                },
            )
            return tool_result({"success": True, "message": "Table inserted."})
        if op == "share":
            raw_vis = str(args.get("visibility") or "").strip().lower()
            vis = _SHARE_VISIBILITY_ALIASES.get(raw_vis, raw_vis)
            if vis not in _SHARE_VISIBILITY:
                return tool_error(
                    "visibility must be anyone|tenant|specified (aliases: company, organization, private)",
                    success=False,
                    operation=op,
                )
            await client.request(
                "PATCH",
                f"/open-apis/drive/v1/permissions/{doc_token}/public",
                params={"type": "docx"},
                json_body=_SHARE_VISIBILITY[vis],
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


def _norm_event(ev: dict[str, Any]) -> dict[str, Any] | None:
    status = str(ev.get("status") or "").strip().lower()
    if status in {"cancelled", "canceled"}:
        return None
    start_raw = (ev.get("start_time") or {}).get("timestamp")
    end_raw = (ev.get("end_time") or {}).get("timestamp")
    start_ts = int(start_raw) if start_raw else None
    end_ts = int(end_raw) if end_raw else None
    duration_min = None
    if start_ts and end_ts and end_ts >= start_ts:
        duration_min = max(1, round((end_ts - start_ts) / 60))
    attendees = ev.get("attendees") or []
    vchat = ev.get("vchat") if isinstance(ev.get("vchat"), dict) else {}
    return {
        "eventId": ev.get("event_id") or ev.get("id"),
        "summary": ev.get("summary") or ev.get("title"),
        "startTime": _epoch_to_iso(start_ts) if start_ts else None,
        "endTime": _epoch_to_iso(end_ts) if end_ts else None,
        "attendeeCount": len(attendees) if isinstance(attendees, list) else 0,
        "vcUrl": vchat.get("meeting_url") or vchat.get("url"),
        "durationMin": duration_min,
    }


_primary_calendar_cache: dict[int, tuple[str, float]] = {}


async def _resolve_calendar_id(client: Any, calendar_id: str) -> str:
    """Resolve ``primary`` to the user's real Lark calendar id."""
    cal = (calendar_id or "primary").strip() or "primary"
    if cal != "primary":
        return cal
    cache_key = id(client)
    now = time.time()
    cached = _primary_calendar_cache.get(cache_key)
    if cached and cached[1] > now:
        return cached[0]
    data = await client.request("POST", "/open-apis/calendar/v4/calendars/primary")
    resolved = ""
    for item in (data or {}).get("calendars") or []:
        if not isinstance(item, dict):
            continue
        calendar = item.get("calendar")
        if isinstance(calendar, dict):
            cid = str(calendar.get("calendar_id") or "").strip()
            if cid:
                resolved = cid
                break
    if not resolved:
        raise ValueError("Could not resolve Lark primary calendar id")
    _primary_calendar_cache[cache_key] = (resolved, now + 3600)
    return resolved


def reset_primary_calendar_cache() -> None:
    _primary_calendar_cache.clear()


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


async def _calendar_user_ids(
    client: Any,
    args: dict[str, Any],
    kwargs: dict[str, Any],
    *,
    id_key: str,
    names_key: str,
) -> list[str]:
    ids = [str(item).strip() for item in (args.get(id_key) or []) if str(item).strip()]
    if ids:
        return ids
    names = [str(item).strip() for item in (args.get(names_key) or []) if str(item).strip()]
    if not names:
        return []
    resolved = await _resolve_lark_people_live(
        client,
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


async def _calendar_attendee_ids(
    client: Any,
    args: dict[str, Any],
    kwargs: dict[str, Any],
    *,
    default_include_requester: bool = False,
) -> list[str]:
    ids = await _calendar_user_ids(client, args, kwargs, id_key="attendeeIds", names_key="attendeeNames")
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
    cal_arg = str(args.get("calendarId") or "primary").strip() or "primary"
    try:
        if op == "list":
            limit = max(1, min(50, int(args.get("limit") or 50)))
            # Lark's events endpoint requires a start_time/end_time window
            # (Unix seconds) AND page_size >= 50. Request the API minimum and
            # slice client-side to the caller's limit.
            now = int(datetime.now(timezone.utc).timestamp())
            start = _iso_to_epoch(str(args["dateFrom"])) if args.get("dateFrom") else now
            end = _iso_to_epoch(str(args["dateTo"])) if args.get("dateTo") else now + 30 * 24 * 3600
            read_client = _user_client(kwargs) or client
            cal = await _resolve_calendar_id(read_client, cal_arg)
            base = f"/open-apis/calendar/v4/calendars/{cal}"
            data = await read_client.request(
                "GET",
                f"{base}/events",
                params={"page_size": 50, "start_time": str(start), "end_time": str(end)},
            )
            events = [
                normalized
                for e in (data or {}).get("items", [])
                if (normalized := _norm_event(e)) is not None
            ]
            return tool_result({"success": True, "data": events[:limit]})
        calendar_client = _user_client(kwargs) or client
        cal = await _resolve_calendar_id(calendar_client, cal_arg)
        base = f"/open-apis/calendar/v4/calendars/{cal}"
        if op == "get":
            eid = str(args.get("eventId") or "").strip()
            if not eid:
                return tool_error("eventId is required", success=False, operation=op)
            data = await calendar_client.request("GET", f"{base}/events/{eid}")
            normalized = _norm_event((data or {}).get("event", {}))
            return tool_result({"success": True, "data": normalized})
        if op == "create":
            title = str(args.get("title") or "").strip()
            start, end = str(args.get("startTime") or ""), str(args.get("endTime") or "")
            if not title or not start or not end:
                return tool_error("title, startTime, endTime are required for create", success=False, operation=op)
            body: dict[str, Any] = {"summary": title, "start_time": _cal_time(start), "end_time": _cal_time(end)}
            if args.get("description"):
                body["description"] = str(args["description"])
            search_client = _user_client(kwargs) or client
            attendee_ids = await _calendar_attendee_ids(search_client, args, kwargs, default_include_requester=True)
            if attendee_ids:
                body["attendees"] = [{"type": "user", "user_id": str(a)} for a in attendee_ids]
            data = await calendar_client.request("POST", f"{base}/events", json_body=body)
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
            search_client = _user_client(kwargs) or client
            attendee_ids = await _calendar_attendee_ids(search_client, args, kwargs, default_include_requester=True)
            if attendee_ids:
                body["attendees"] = [{"type": "user", "user_id": str(a)} for a in attendee_ids]
            data = await calendar_client.request("POST", f"{base}/events", json_body=body)
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
            await calendar_client.request("PATCH", f"{base}/events/{eid}", json_body=body)
            return tool_result({"success": True, "message": "Event updated."})
        if op == "delete":
            eid = str(args.get("eventId") or "").strip()
            if not eid:
                return tool_error("eventId is required", success=False, operation=op)
            await calendar_client.request("DELETE", f"{base}/events/{eid}")
            return tool_result({"success": True, "message": "Event deleted."})
        if op == "free_busy":
            search_client = _user_client(kwargs) or client
            user_ids = await _calendar_user_ids(search_client, args, kwargs, id_key="userIds", names_key="names")
            d_from, d_to = str(args.get("dateFrom") or ""), str(args.get("dateTo") or "")
            if not user_ids or not d_from or not d_to:
                return tool_error("userIds or names, dateFrom, dateTo are required for free_busy", success=False, operation=op)
            out: dict[str, Any] = {}
            for uid in user_ids:
                data = await calendar_client.request(
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
            data = await calendar_client.request("GET", f"{base}/events/{eid}/attendees")
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
            search_client = _user_client(kwargs) or client
            add_ids = await _calendar_user_ids(search_client, args, kwargs, id_key="attendeeIds", names_key="addNames")
            remove_ids = set(await _calendar_user_ids(search_client, args, kwargs, id_key="removeAttendeeIds", names_key="removeNames"))
            if add_ids:
                await calendar_client.request("POST", f"{base}/events/{eid}/attendees", json_body={"attendees": [{"type": "user", "user_id": str(a)} for a in add_ids]})
            if remove_ids:
                existing = await calendar_client.request("GET", f"{base}/events/{eid}/attendees")
                to_delete = [a.get("attendee_id") for a in (existing or {}).get("items", []) if str(a.get("user_id")) in remove_ids and a.get("attendee_id")]
                if to_delete:
                    await calendar_client.request("POST", f"{base}/events/{eid}/attendees/batch_delete", json_body={"attendee_ids": to_delete})
            return tool_result({"success": True, "message": "Attendees updated."})
        return tool_error(f"Unhandled lark_calendar operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# ── Contacts (Contact v3) ────────────────────────────────────────────────────

LARK_CONTACTS_OPS = {"lookup", "search", "get", "list_department"}

LARK_CONTACTS_SCHEMA = {
    "name": "lark_contacts",
    "description": (
        "Lark/Feishu company directory and contact resolution. Operations: search (fuzzy workspace user "
        "search by name/email), get (read one or more users by open_id), lookup (email/mobile → open_id), "
        "list_department (members of a department by name). Use this before messaging, task assignment, "
        "or calendar attendee selection when a human name is ambiguous."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_CONTACTS_OPS)},
            "emails": {"type": "array", "items": {"type": "string"}},
            "mobiles": {"type": "array", "items": {"type": "string"}},
            "query": {"type": "string", "description": "Name/email/mobile search query for workspace contact search."},
            "openIds": {"type": "array", "items": {"type": "string"}},
            "department": {"type": "string"},
            "hasChatted": {"type": "boolean"},
            "hasEnterpriseEmail": {"type": "boolean"},
            "excludeExternalUsers": {"type": "boolean"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        },
        "required": ["op"],
    },
}


def _normalize_lark_user(user: dict[str, Any]) -> dict[str, Any]:
    meta = user.get("meta_data") if isinstance(user.get("meta_data"), dict) else {}
    name = user.get("name")
    if isinstance(user.get("localized_name"), dict):
        name = user["localized_name"].get("default_value") or user["localized_name"].get("zh_cn") or name
    if not name and isinstance(meta.get("i18n_names"), dict):
        names = meta["i18n_names"]
        name = (
            names.get("en_us")
            or names.get("default_value")
            or names.get("zh_cn")
            or next((str(value) for value in names.values() if str(value).strip()), None)
        )
    if not name and user.get("display_info"):
        display = re.sub(r"<[^>]+>", "", str(user.get("display_info") or ""))
        name = display.splitlines()[0].strip() or None
    department = user.get("department")
    if not department and isinstance(user.get("department_ids"), list):
        department = ", ".join(str(item) for item in user["department_ids"] if str(item).strip())
    if not department and isinstance(meta.get("department"), str):
        department = meta.get("department")
    email = (
        user.get("email")
        or user.get("enterprise_email")
        or meta.get("enterprise_mail_address")
        or meta.get("mail_address")
    )
    return {
        "openId": user.get("open_id") or user.get("user_id") or user.get("id"),
        "userId": user.get("user_id"),
        "unionId": user.get("union_id"),
        "displayName": name or user.get("en_name") or user.get("nickname") or email,
        "email": email,
        "mobile": user.get("mobile") or meta.get("mobile"),
        "department": department,
        "p2pChatId": user.get("p2p_chat_id") or meta.get("chat_id"),
        "isActivated": user.get("is_activated") if user.get("is_activated") is not None else meta.get("is_registered"),
        "isTenantManager": user.get("is_tenant_manager"),
        "isCrossTenant": user.get("is_cross_tenant") if user.get("is_cross_tenant") is not None else meta.get("is_cross_tenant"),
    }


def _contact_search_filter(args: dict[str, Any]) -> dict[str, Any]:
    filt: dict[str, Any] = {}
    if "hasChatted" in args:
        filt["has_chatted"] = bool(args["hasChatted"])
    if "hasEnterpriseEmail" in args:
        filt["has_enterprise_email"] = bool(args["hasEnterpriseEmail"])
    if "excludeExternalUsers" in args:
        filt["exclude_external_users"] = bool(args["excludeExternalUsers"])
    return filt


async def _search_lark_users(
    client: Any,
    query: str,
    *,
    limit: int = 10,
    filters: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    query = str(query or "").strip()
    if not query:
        return []
    body: dict[str, Any] = {"query": query}
    if filters:
        body["filter"] = filters
    data = await client.request(
        "POST",
        "/open-apis/contact/v3/users/search",
        params={"page_size": max(1, min(30, int(limit)))},
        json_body=body,
    )
    users = (data or {}).get("items") or (data or {}).get("users") or (data or {}).get("user_list") or []
    return [_normalize_lark_user(item) for item in users if isinstance(item, dict)]


async def _search_lark_users_by_open_ids(
    client: Any,
    open_ids: list[str],
    *,
    limit: int = 100,
) -> list[dict[str, Any]]:
    ids = [str(item).strip() for item in open_ids if str(item).strip()]
    if not ids:
        return []
    data = await client.request(
        "POST",
        "/open-apis/contact/v3/users/search",
        params={"page_size": max(1, min(30, int(limit), len(ids)))},
        json_body={"filter": {"user_ids": ids[:100]}},
    )
    users = (data or {}).get("items") or (data or {}).get("users") or (data or {}).get("user_list") or []
    return [_normalize_lark_user(item) for item in users if isinstance(item, dict)]


async def _handle_lark_contacts(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in LARK_CONTACTS_OPS:
        return tool_error(f"Unknown lark_contacts operation: {op}", success=False)
    try:
        client = _user_client(kwargs, strict=True) or _client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)
    try:
        if op == "search":
            query = str(args.get("query") or "").strip()
            if not query:
                return tool_error("query is required for search", success=False, operation=op)
            limit = max(1, min(100, int(args.get("limit") or 10)))
            users = await _search_lark_users(client, query, limit=limit, filters=_contact_search_filter(args))
            return tool_result({
                "success": True,
                "message": f"Found {len(users)} Lark user(s).",
                "data": users[:limit],
            })
        if op == "get":
            open_ids = [str(item).strip() for item in (args.get("openIds") or []) if str(item).strip()]
            if not open_ids:
                return tool_error("openIds are required for get", success=False, operation=op)
            users = await _search_lark_users_by_open_ids(client, open_ids, limit=len(open_ids))
            return tool_result({"success": True, "data": users})
        if op == "lookup":
            emails = [str(e) for e in (args.get("emails") or []) if str(e).strip()]
            mobiles = [str(m) for m in (args.get("mobiles") or []) if str(m).strip()]
            if not emails and not mobiles:
                return tool_error("emails or mobiles are required for lookup", success=False, operation=op)
            found: list[dict[str, Any]] = []
            seen: set[str] = set()
            for query in [*emails, *mobiles]:
                for user in await _search_lark_users(client, query, limit=5):
                    open_id = str(user.get("openId") or "").strip()
                    if not open_id or open_id in seen:
                        continue
                    seen.add(open_id)
                    found.append(user)
            matched_emails = {str(item.get("email") or item.get("enterpriseEmail") or "").lower() for item in found}
            not_found = [email for email in emails if email.lower() not in matched_emails]
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
        message = str(exc)
        if "99991679" in message or "permission" in message.lower():
            return tool_error(
                "Lark contact search requires the app permission/scope contact:user:search. "
                "Grant/approve that permission for the Lark app, then log out and log back into Divo Dex with Lark.",
                success=False,
                operation=op,
            )
        if "99991668" in message or "user access token not support" in message.lower():
            return tool_error(
                "This Lark contact endpoint does not support user access tokens. "
                "Use lark_contacts search/get with contact:user:search, or reconnect after updating Divo.",
                success=False,
                operation=op,
            )
        return tool_error(str(exc), success=False, operation=op)


# ── Task (Task v2) ───────────────────────────────────────────────────────────

LARK_TASK_OPS = {
    "create", "get", "list", "listMine", "listOpenMine", "update", "delete", "complete", "reopen",
    "create_subtask", "list_subtasks", "create_tasklist", "list_tasklists",
    "add_to_tasklist", "remove_from_tasklist", "comment",
}

LARK_TASK_SCHEMA = {
    "name": "lark_task",
    "description": (
        "Lark/Feishu Tasks. Operations: create, get, list, listMine, listOpenMine, update, delete, "
        "complete, reopen, create_subtask, list_subtasks, create_tasklist, list_tasklists, add_to_tasklist, "
        "remove_from_tasklist, comment. dueDate is ISO 8601. assigneeIds take raw Lark ids; "
        "assigneeNames resolve people from Hermes company identity. Use comment to attach human-visible "
        "tracking doc links to tasks."
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
            "content": {"type": "string", "description": "Task comment content."},
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


def _task_update_payload(body: dict[str, Any]) -> dict[str, Any]:
    return {"task": body, "update_fields": list(body.keys())}


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


def _session_lark_chat_id(kwargs: dict[str, Any]) -> str:
    value = str(kwargs.get("chat_id") or kwargs.get("chatId") or "").strip()
    if value:
        return value
    try:
        from gateway.session_context import get_session_env

        return str(get_session_env("HERMES_SESSION_CHAT_ID", "") or "").strip()
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
    by_key: dict[str, dict[str, Any]] = {}

    def canonical_key(
        *,
        company_user_id: str,
        email: str,
        union_id: str,
        open_id: str,
    ) -> str:
        if union_id:
            return f"union:{union_id.lower()}"
        if email:
            return f"email:{email.lower()}"
        if company_user_id:
            return f"company_user:{company_user_id}"
        return f"open:{open_id}"

    def prefer_open_id(candidate: str, current: str) -> bool:
        if not current:
            return True
        # Lark APIs in this module use open_id where possible. Gateway events
        # may carry a short user_id for the same union_id; prefer open_id.
        return candidate.startswith("ou_") and not current.startswith("ou_")

    for row in _identity_rows_for_company(company_id):
        user = row["user"]
        identity = row["identity"]
        raw = _raw_identity_json(identity)
        company_user_id = str(
            user.get("id")
            or user.get("company_user_id")
            or user.get("companyUserId")
            or identity.get("company_user_id")
            or identity.get("companyUserId")
            or ""
        ).strip()
        open_id = str(
            identity.get("platform_user_id")
            or identity.get("externalUserId")
            or raw.get("open_id")
            or raw.get("user_id")
            or ""
        ).strip()
        if not open_id:
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
        union_id = str(
            identity.get("platform_user_id_alt")
            or identity.get("platformUserIdAlt")
            or raw.get("union_id")
            or raw.get("user_id_alt")
            or ""
        ).strip()
        norm_name = _normalize_person_name(display_name)
        key = canonical_key(
            company_user_id=company_user_id,
            email=email,
            union_id=union_id,
            open_id=open_id,
        )
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = {
                "openId": open_id,
                "displayName": display_name,
                "email": email,
                "normName": norm_name,
                "tokens": _tokens(norm_name),
                "aliases": {open_id, *({union_id} if union_id else set())},
            }
            continue
        existing.setdefault("aliases", set()).update({open_id, *({union_id} if union_id else set())})
        if email and not existing.get("email"):
            existing["email"] = email
        if display_name and not existing.get("displayName"):
            existing["displayName"] = display_name
        if prefer_open_id(open_id, str(existing.get("openId") or "")):
            existing["openId"] = open_id
    return list(by_key.values())


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
                self_entry = next(
                    (
                        item
                        for item in directory
                        if item["openId"] == requester_open_id
                        or requester_open_id in item.get("aliases", set())
                    ),
                    None,
                )
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


async def _resolve_lark_people_live(
    client: Any,
    *,
    company_id: str,
    queries: list[str],
    requester_open_id: str,
) -> dict[str, Any]:
    """Resolve from local Hermes identity first, then live Lark workspace search.

    Local identity remains the fast/canonical path when present. The live search
    fallback is what lets an agent resolve arbitrary company users before the
    user has chatted with them or before identity rows have been synced.
    """
    base = _resolve_lark_people(
        company_id=company_id,
        queries=queries,
        requester_open_id=requester_open_id,
    )
    if not base["notFound"]:
        return base

    resolved: list[dict[str, Any]] = list(base["resolved"])
    ambiguous: list[dict[str, Any]] = list(base["ambiguous"])
    not_found: list[str] = []
    seen = {str(item.get("openId") or "") for item in resolved if item.get("openId")}

    def add_person(person: dict[str, Any]) -> None:
        open_id = str(person.get("openId") or "").strip()
        if not open_id or open_id in seen:
            return
        seen.add(open_id)
        resolved.append(
            {
                "openId": open_id,
                "displayName": person.get("displayName") or open_id,
                **({"email": person["email"]} if person.get("email") else {}),
                **({"department": person["department"]} if person.get("department") else {}),
                **({"p2pChatId": person["p2pChatId"]} if person.get("p2pChatId") else {}),
            }
        )

    for query in base["notFound"]:
        normalized = _normalize_person_name(str(query))
        try:
            matches = await _search_lark_users(
                client,
                str(query),
                limit=10,
                filters={"exclude_external_users": True},
            )
        except Exception:  # noqa: BLE001
            not_found.append(str(query))
            continue
        usable = [item for item in matches if item.get("openId")]
        if not usable:
            not_found.append(str(query))
            continue
        exact = [
            item
            for item in usable
            if _normalize_person_name(str(item.get("displayName") or "")) == normalized
            or str(item.get("email") or "").strip().lower() == normalized
        ]
        if len(exact) == 1:
            add_person(exact[0])
            continue
        if len(exact) > 1:
            ambiguous.append({"query": query, "matches": exact})
            continue
        query_tokens = _tokens(normalized)
        scored = [
            (item, _overlap_score(query_tokens, _tokens(_normalize_person_name(str(item.get("displayName") or "")))))
            for item in usable
        ]
        scored = [(item, score) for item, score in scored if score >= 0.5]
        scored.sort(key=lambda item: item[1], reverse=True)
        if not scored:
            if len(usable) == 1:
                add_person(usable[0])
            else:
                ambiguous.append({"query": query, "matches": usable})
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


async def _resolve_assignee_ids(
    client: Any,
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
        resolved = await _resolve_lark_people_live(
            client,
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
        resolved = await _resolve_lark_people_live(
            client,
            company_id=_company_id(kwargs),
            queries=["me"],
            requester_open_id=requester,
        )
        if resolved["resolved"]:
            return [item["openId"] for item in resolved["resolved"]]
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
            search_client = _user_client(kwargs) or client
            assignee_ids = await _resolve_assignee_ids(search_client, args, kwargs, default_to_requester=True)
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
            read_client = _user_client(kwargs) or client
            tasks = await _list_lark_tasks(read_client, limit=limit, tasklist_id=_tasklist_id(args))
            tasks = [task for task in tasks if _task_has_member(task, requester)]
            if op == "listOpenMine":
                tasks = [task for task in tasks if not _is_task_completed(task)]
            return tool_result({"success": True, "data": [_norm_task(t) for t in tasks], "message": f"Found {len(tasks)} {'open ' if op == 'listOpenMine' else ''}tasks assigned to you"})
        if op == "update":
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            search_client = _user_client(kwargs) or client
            body = _task_body(args, assignee_ids=await _resolve_assignee_ids(search_client, args, kwargs))
            fields = ",".join(k for k in body)
            if not fields:
                return tool_error("No task fields supplied for update", success=False, operation=op)
            await client.request(
                "PATCH",
                f"/open-apis/task/v2/tasks/{tid}",
                params={"user_id_type": "open_id"},
                json_body=_task_update_payload(body),
            )
            return tool_result({"success": True, "taskId": tid, "message": "Task updated."})
        if op in {"complete", "reopen"}:
            tid = str(args.get("taskId") or "").strip()
            if not tid:
                return tool_error("taskId is required", success=False, operation=op)
            completed_at = "0" if op == "reopen" else str(int(time.time() * 1000))
            await client.request(
                "PATCH",
                f"/open-apis/task/v2/tasks/{tid}",
                params={"user_id_type": "open_id"},
                json_body={"task": {"completed_at": completed_at}, "update_fields": ["completed_at"]},
            )
            return tool_result({
                "success": True,
                "taskId": tid,
                "message": "Task reopened." if op == "reopen" else "Task marked complete.",
            })
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
                json_body=_task_body(args, assignee_ids=await _resolve_assignee_ids(_user_client(kwargs) or client, args, kwargs)),
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
            members = _members(await _resolve_assignee_ids(_user_client(kwargs) or client, args, kwargs), "editor")
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
        if op == "comment":
            tid = str(args.get("taskId") or "").strip()
            content = str(args.get("content") or args.get("notes") or "").strip()
            if not tid or not content:
                return tool_error("taskId and content are required for comment", success=False, operation=op)
            data = await client.request(
                "POST",
                "/open-apis/task/v2/comments",
                params={"user_id_type": "open_id"},
                json_body={"resource_id": tid, "resource_type": "task", "content": content},
            )
            comment = (data or {}).get("comment", data or {})
            return tool_result({
                "success": True,
                "taskId": tid,
                "commentId": comment.get("id") or comment.get("comment_id") or comment.get("commentId"),
                "message": "Task comment added.",
            })
        return tool_error(f"Unhandled lark_task operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)


# ── Approval (Approval v4) ───────────────────────────────────────────────────

LARK_APPROVAL_OPS = {"create", "get", "list", "listPendingMine", "listInitiatedPending"}

LARK_APPROVAL_SCHEMA = {
    "name": "lark_approval",
    "description": (
        "Lark/Feishu Approval instances. Operations: create, get, list, listPendingMine, listInitiatedPending."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(LARK_APPROVAL_OPS)},
            "approvalCode": {"type": "string"},
            "instanceCode": {"type": "string"},
            "formValues": {"type": "object", "additionalProperties": True, "description": "{ field_id: value } pairs."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 50},
        },
        "required": ["op"],
    },
}


def _norm_instance(i: dict[str, Any]) -> dict[str, Any]:
    return {
        "instanceCode": i.get("instance_code"),
        "approvalCode": i.get("approval_code"),
        "status": i.get("status"),
        "title": i.get("title") or i.get("reason") or i.get("name"),
    }


def _norm_approval_task(task: dict[str, Any]) -> dict[str, Any]:
    instance = task.get("instance") if isinstance(task.get("instance"), dict) else task
    return {
        "instanceCode": instance.get("instance_code") or task.get("instance_code"),
        "approvalCode": instance.get("approval_code") or task.get("approval_code"),
        "status": instance.get("status") or task.get("status"),
        "title": (
            instance.get("title")
            or instance.get("approval_name")
            or task.get("title")
            or task.get("approval_name")
            or "Approval"
        ),
        "startTime": instance.get("start_time") or task.get("start_time"),
    }


async def _handle_lark_approval(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in LARK_APPROVAL_OPS:
        return tool_error(f"Unknown lark_approval operation: {op}", success=False)
    approval_code = str(args.get("approvalCode") or "").strip()
    if op not in {"listPendingMine", "listInitiatedPending"} and not approval_code:
        return tool_error("approvalCode is required", success=False, operation=op)
    try:
        client = _client(kwargs)
    except Exception as exc:  # noqa: BLE001
        return tool_error(str(exc), success=False, operation=op)
    try:
        if op in {"listPendingMine", "listInitiatedPending"}:
            limit = max(1, min(50, int(args.get("limit") or 20)))
            user_open_id = _session_lark_user_id(kwargs)
            if not user_open_id:
                return tool_result({"success": True, "data": [], "message": "No Lark user context for approvals."})
            topic = "1" if op == "listPendingMine" else "2"
            try:
                data = await client.request(
                    "POST",
                    "/open-apis/approval/v4/tasks/query",
                    json_body={
                        "user_id": user_open_id,
                        "topic": topic,
                        "page_size": limit,
                    },
                )
            except Exception:  # noqa: BLE001 - degrade when approval task query unavailable
                return tool_result({"success": True, "data": [], "message": "Approval inbox unavailable."})
            items = (data or {}).get("tasks") or (data or {}).get("items") or []
            return tool_result({
                "success": True,
                "data": [_norm_approval_task(item) for item in items if isinstance(item, dict)],
            })
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
