"""Gmail grouped tool handler."""

from __future__ import annotations

from email.utils import getaddresses
from typing import Any

from tools.google._helpers import (
    build_email_message,
    extract_plain_body,
    header,
    ok,
    resolve_client_and_scopes,
)
from tools.registry import tool_error

GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1"

GMAIL_OPS = frozenset({
    "profile",
    "list",
    "search",
    "get",
    "send",
    "draft_create",
    "draft_get",
    "draft_update",
    "draft_send",
    "draft_delete",
    "reply",
    "reply_all",
    "forward",
    "thread_list",
    "thread_get",
    "labels_list",
    "labels_modify",
    "archive",
    "mark_read",
    "mark_unread",
    "star",
    "unstar",
    "trash",
    "untrash",
})

# Mailbox actions implemented as label add/remove via messages.modify
# (covered by the existing gmail.modify scope — no new scope needed).
_LABEL_ACTIONS: dict[str, tuple[list[str], list[str]]] = {
    # op:        (addLabelIds, removeLabelIds)
    "archive": ([], ["INBOX"]),
    "mark_read": ([], ["UNREAD"]),
    "mark_unread": (["UNREAD"], []),
    "star": (["STARRED"], []),
    "unstar": ([], ["STARRED"]),
}

GMAIL_SCHEMA = {
    "name": "gmail",
    "description": (
        "Access the connected Gmail account. Operations: profile, list, search, get, send, "
        "draft_create, draft_get, draft_update, draft_send, draft_delete, reply, reply_all, "
        "forward, thread_list, thread_get, labels_list, labels_modify, archive, mark_read, "
        "mark_unread, star, unstar, trash, untrash."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(GMAIL_OPS)},
            "query": {"type": "string", "description": "Gmail search query (list/search/thread_list)."},
            "messageId": {"type": "string"},
            "threadId": {"type": "string"},
            "draftId": {"type": "string"},
            "maxResults": {"type": "integer", "minimum": 1, "maximum": 50},
            "to": {"type": "string"},
            "cc": {"type": "string"},
            "subject": {"type": "string"},
            "body": {"type": "string"},
            "addLabelIds": {"type": "array", "items": {"type": "string"}},
            "removeLabelIds": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["op"],
    },
}


def _addrs(*header_values: str) -> list[str]:
    """Extract bare email addresses from one or more raw header values
    (each may be a comma-separated list of ``Name <email>`` entries)."""
    pairs = getaddresses([v for v in header_values if v])
    return [email for _name, email in pairs if email]


def _dedupe_addrs(addrs: list[str], *, exclude: set[str]) -> list[str]:
    """Order-preserving dedupe (case-insensitive), dropping ``exclude`` addresses."""
    seen: set[str] = set()
    out: list[str] = []
    for addr in addrs:
        low = addr.lower()
        if low in exclude or low in seen:
            continue
        seen.add(low)
        out.append(addr)
    return out


async def _fetch_message_metadata(client, mid: str) -> dict[str, Any]:
    msg = await client.request(
        "GET",
        f"{GMAIL_BASE}/users/me/messages/{mid}",
        params={"format": "metadata", "metadataHeaders": ["From", "Subject", "Date", "To"]},
    )
    headers = (msg.get("payload", {}) or {}).get("headers", [])
    return {
        "id": mid,
        "from": header(headers, "From"),
        "to": header(headers, "To"),
        "subject": header(headers, "Subject"),
        "date": header(headers, "Date"),
        "snippet": msg.get("snippet", ""),
    }


async def handle_gmail(args: dict[str, Any], **kwargs: Any) -> str:
    op = str(args.get("op") or args.get("operation") or "").strip()
    if op not in GMAIL_OPS:
        return tool_error(f"Unknown gmail operation: {op}", success=False)

    client, err = await resolve_client_and_scopes(kwargs, "gmail", op)
    if err:
        return err

    try:
        if op == "profile":
            data = await client.request("GET", f"{GMAIL_BASE}/users/me/profile")
            return ok(data)

        if op in ("list", "search"):
            max_results = max(1, min(50, int(args.get("maxResults") or 10)))
            params: dict[str, Any] = {"maxResults": max_results}
            if args.get("query"):
                params["q"] = str(args["query"])
            listing = await client.request("GET", f"{GMAIL_BASE}/users/me/messages", params=params)
            ids = [m["id"] for m in (listing or {}).get("messages", [])]
            items = [await _fetch_message_metadata(client, mid) for mid in ids]
            return ok(items, message=f"Found {len(items)} message(s).")

        if op == "get":
            mid = str(args.get("messageId") or "").strip()
            if not mid:
                return tool_error("messageId is required for get", success=False, operation=op)
            msg = await client.request(
                "GET", f"{GMAIL_BASE}/users/me/messages/{mid}", params={"format": "full"}
            )
            payload = msg.get("payload", {}) or {}
            headers = payload.get("headers", [])
            return ok({
                "id": mid,
                "from": header(headers, "From"),
                "to": header(headers, "To"),
                "subject": header(headers, "Subject"),
                "date": header(headers, "Date"),
                "body": extract_plain_body(payload),
            })

        if op == "send":
            to = str(args.get("to") or "").strip()
            if not to:
                return tool_error("to is required for send", success=False, operation=op)
            raw = build_email_message(
                to=to,
                cc=str(args.get("cc") or ""),
                subject=str(args.get("subject") or ""),
                body=str(args.get("body") or ""),
            )
            sent = await client.request(
                "POST", f"{GMAIL_BASE}/users/me/messages/send", json_body={"raw": raw}
            )
            return ok({"id": sent.get("id")}, message="Email sent.")

        if op == "draft_create":
            raw = build_email_message(
                to=str(args.get("to") or ""),
                cc=str(args.get("cc") or ""),
                subject=str(args.get("subject") or ""),
                body=str(args.get("body") or ""),
            )
            draft = await client.request(
                "POST", f"{GMAIL_BASE}/users/me/drafts", json_body={"message": {"raw": raw}}
            )
            return ok(draft, message="Draft created.")

        if op == "draft_update":
            draft_id = str(args.get("draftId") or "").strip()
            if not draft_id:
                return tool_error("draftId is required for draft_update", success=False, operation=op)
            raw = build_email_message(
                to=str(args.get("to") or ""),
                cc=str(args.get("cc") or ""),
                subject=str(args.get("subject") or ""),
                body=str(args.get("body") or ""),
            )
            draft = await client.request(
                "PUT",
                f"{GMAIL_BASE}/users/me/drafts/{draft_id}",
                json_body={"id": draft_id, "message": {"raw": raw}},
            )
            return ok(draft, message="Draft updated.")

        if op == "draft_send":
            draft_id = str(args.get("draftId") or "").strip()
            if not draft_id:
                return tool_error("draftId is required for draft_send", success=False, operation=op)
            sent = await client.request(
                "POST", f"{GMAIL_BASE}/users/me/drafts/send", json_body={"id": draft_id}
            )
            return ok(sent, message="Draft sent.")

        if op == "reply":
            mid = str(args.get("messageId") or "").strip()
            if not mid:
                return tool_error("messageId is required for reply", success=False, operation=op)
            original = await client.request(
                "GET",
                f"{GMAIL_BASE}/users/me/messages/{mid}",
                params={"format": "metadata", "metadataHeaders": ["From", "Subject", "Message-ID"]},
            )
            headers = (original.get("payload", {}) or {}).get("headers", [])
            subject = header(headers, "Subject")
            if subject and not subject.lower().startswith("re:"):
                subject = f"Re: {subject}"
            raw = build_email_message(
                to=header(headers, "From"),
                subject=subject,
                body=str(args.get("body") or ""),
                in_reply_to=header(headers, "Message-ID"),
                references=header(headers, "Message-ID"),
            )
            sent = await client.request(
                "POST",
                f"{GMAIL_BASE}/users/me/messages/send",
                json_body={"raw": raw, "threadId": original.get("threadId")},
            )
            return ok(sent, message="Reply sent.")

        if op == "forward":
            mid = str(args.get("messageId") or "").strip()
            to = str(args.get("to") or "").strip()
            if not mid or not to:
                return tool_error("messageId and to are required for forward", success=False, operation=op)
            original = await client.request(
                "GET", f"{GMAIL_BASE}/users/me/messages/{mid}", params={"format": "full"}
            )
            payload = original.get("payload", {}) or {}
            headers = payload.get("headers", [])
            subject = header(headers, "Subject")
            if subject and not subject.lower().startswith("fwd:"):
                subject = f"Fwd: {subject}"
            body = str(args.get("body") or "") + "\n\n" + extract_plain_body(payload)
            raw = build_email_message(to=to, subject=subject, body=body)
            sent = await client.request(
                "POST", f"{GMAIL_BASE}/users/me/messages/send", json_body={"raw": raw}
            )
            return ok(sent, message="Message forwarded.")

        if op == "reply_all":
            mid = str(args.get("messageId") or "").strip()
            if not mid:
                return tool_error("messageId is required for reply_all", success=False, operation=op)
            original = await client.request(
                "GET",
                f"{GMAIL_BASE}/users/me/messages/{mid}",
                params={"format": "metadata", "metadataHeaders": ["From", "To", "Cc", "Subject", "Message-ID"]},
            )
            headers = (original.get("payload", {}) or {}).get("headers", [])
            profile = await client.request("GET", f"{GMAIL_BASE}/users/me/profile")
            me = str((profile or {}).get("emailAddress") or "").lower()
            # Reply-all recipients: original sender + everyone on To, with Cc kept
            # as Cc; the current user is removed from both, and duplicates dropped.
            to_addrs = _dedupe_addrs(_addrs(header(headers, "From"), header(headers, "To")), exclude={me})
            cc_addrs = _dedupe_addrs(_addrs(header(headers, "Cc")), exclude={me, *(a.lower() for a in to_addrs)})
            if not to_addrs and not cc_addrs:
                return tool_error("No other recipients to reply-all to", success=False, operation=op)
            subject = header(headers, "Subject")
            if subject and not subject.lower().startswith("re:"):
                subject = f"Re: {subject}"
            raw = build_email_message(
                to=", ".join(to_addrs),
                cc=", ".join(cc_addrs),
                subject=subject,
                body=str(args.get("body") or ""),
                in_reply_to=header(headers, "Message-ID"),
                references=header(headers, "Message-ID"),
            )
            sent = await client.request(
                "POST",
                f"{GMAIL_BASE}/users/me/messages/send",
                json_body={"raw": raw, "threadId": original.get("threadId")},
            )
            return ok(sent, message=f"Reply-all sent to {len(to_addrs) + len(cc_addrs)} recipient(s).")

        if op == "draft_get":
            draft_id = str(args.get("draftId") or "").strip()
            if not draft_id:
                return tool_error("draftId is required for draft_get", success=False, operation=op)
            draft = await client.request(
                "GET", f"{GMAIL_BASE}/users/me/drafts/{draft_id}", params={"format": "full"}
            )
            payload = (draft.get("message", {}) or {}).get("payload", {}) or {}
            headers = payload.get("headers", [])
            return ok({
                "id": draft.get("id"),
                "to": header(headers, "To"),
                "cc": header(headers, "Cc"),
                "subject": header(headers, "Subject"),
                "body": extract_plain_body(payload),
            })

        if op == "draft_delete":
            draft_id = str(args.get("draftId") or "").strip()
            if not draft_id:
                return tool_error("draftId is required for draft_delete", success=False, operation=op)
            await client.request("DELETE", f"{GMAIL_BASE}/users/me/drafts/{draft_id}")
            return ok({"id": draft_id}, message="Draft deleted.")

        if op == "thread_list":
            max_results = max(1, min(50, int(args.get("maxResults") or 10)))
            params: dict[str, Any] = {"maxResults": max_results}
            if args.get("query"):
                params["q"] = str(args["query"])
            listing = await client.request("GET", f"{GMAIL_BASE}/users/me/threads", params=params)
            threads = [
                {"id": t.get("id"), "snippet": t.get("snippet", ""), "historyId": t.get("historyId")}
                for t in (listing or {}).get("threads", [])
            ]
            return ok(threads, message=f"Found {len(threads)} thread(s).")

        if op == "thread_get":
            tid = str(args.get("threadId") or "").strip()
            if not tid:
                return tool_error("threadId is required for thread_get", success=False, operation=op)
            thread = await client.request(
                "GET",
                f"{GMAIL_BASE}/users/me/threads/{tid}",
                params={"format": "metadata", "metadataHeaders": ["From", "To", "Subject", "Date"]},
            )
            messages = []
            for m in (thread or {}).get("messages", []):
                mh = (m.get("payload", {}) or {}).get("headers", [])
                messages.append({
                    "id": m.get("id"),
                    "from": header(mh, "From"),
                    "to": header(mh, "To"),
                    "subject": header(mh, "Subject"),
                    "date": header(mh, "Date"),
                    "snippet": m.get("snippet", ""),
                })
            return ok({"id": tid, "messages": messages}, message=f"Thread has {len(messages)} message(s).")

        if op in _LABEL_ACTIONS:
            mid = str(args.get("messageId") or "").strip()
            if not mid:
                return tool_error(f"messageId is required for {op}", success=False, operation=op)
            add, remove = _LABEL_ACTIONS[op]
            modify_body: dict[str, Any] = {}
            if add:
                modify_body["addLabelIds"] = list(add)
            if remove:
                modify_body["removeLabelIds"] = list(remove)
            data = await client.request(
                "POST", f"{GMAIL_BASE}/users/me/messages/{mid}/modify", json_body=modify_body
            )
            return ok(data, message=f"{op.replace('_', ' ')} done.")

        if op in ("trash", "untrash"):
            mid = str(args.get("messageId") or "").strip()
            if not mid:
                return tool_error(f"messageId is required for {op}", success=False, operation=op)
            data = await client.request(
                "POST", f"{GMAIL_BASE}/users/me/messages/{mid}/{op}"
            )
            return ok(data, message="Moved to trash." if op == "trash" else "Restored from trash.")

        if op == "labels_list":
            data = await client.request("GET", f"{GMAIL_BASE}/users/me/labels")
            labels = [
                {"id": item.get("id"), "name": item.get("name"), "type": item.get("type")}
                for item in (data or {}).get("labels", [])
            ]
            return ok(labels)

        if op == "labels_modify":
            mid = str(args.get("messageId") or "").strip()
            if not mid:
                return tool_error("messageId is required for labels_modify", success=False, operation=op)
            modify_body: dict[str, Any] = {}
            if args.get("addLabelIds"):
                modify_body["addLabelIds"] = list(args["addLabelIds"])
            if args.get("removeLabelIds"):
                modify_body["removeLabelIds"] = list(args["removeLabelIds"])
            if not modify_body:
                return tool_error("addLabelIds or removeLabelIds required", success=False, operation=op)
            data = await client.request(
                "POST", f"{GMAIL_BASE}/users/me/messages/{mid}/modify", json_body=modify_body
            )
            return ok(data, message="Labels updated.")

        return tool_error(f"Unhandled gmail operation: {op}", success=False, operation=op)
    except Exception as exc:  # noqa: BLE001
        from tools.google_scope import map_google_api_error

        return map_google_api_error(exc, tool_name="gmail", operation=op)
