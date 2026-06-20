"""Tests for the native Google Workspace tool handlers (parsing, no network)."""

import base64
import json

import pytest

import tools.google_tools  # noqa: F401 — registers google tools
from tools.registry import registry
from tools.google_scope import map_google_api_error


class FakeGoogleClient:
    """Canned Google API responses keyed by URL substring."""

    def __init__(self, responses):
        self._responses = responses
        self.calls = []

    async def request(self, method, url, *, params=None, json_body=None):
        self.calls.append((method, url, params, json_body))
        for needle, resp in self._responses.items():
            if needle in url:
                return resp
        return {}


def _b64url(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode()


def test_google_api_disabled_error_is_not_reported_as_scope_upgrade():
    out = json.loads(
        map_google_api_error(
            RuntimeError(
                "Google API GET https://gmail.googleapis.com/gmail/v1/users/me/messages failed (403): "
                "Gmail API has not been used in project 123 before or it is disabled."
            ),
            tool_name="gmail",
            operation="list",
        )
    )
    assert out["code"] == "api_not_enabled"


@pytest.mark.asyncio
async def test_gmail_profile():
    client = FakeGoogleClient({"/profile": {"emailAddress": "me@x.com", "messagesTotal": 5}})
    out = json.loads(registry.dispatch("gmail", {"op": "profile"}, client=client))
    assert out["success"] is True
    assert out["data"]["emailAddress"] == "me@x.com"


@pytest.mark.asyncio
async def test_gmail_search_lists_metadata():
    responses = {
        "/users/me/messages/m1": {
            "snippet": "hi there",
            "payload": {"headers": [
                {"name": "From", "value": "a@x.com"},
                {"name": "Subject", "value": "Hello"},
                {"name": "Date", "value": "Mon"},
            ]},
        },
        "/users/me/messages": {"messages": [{"id": "m1"}]},
    }
    client = FakeGoogleClient(responses)
    out = json.loads(registry.dispatch("gmail", {"op": "search", "query": "in:inbox"}, client=client))
    assert out["success"] is True
    assert out["data"][0]["subject"] == "Hello"


@pytest.mark.asyncio
async def test_gmail_labels_list():
    client = FakeGoogleClient({"/labels": {"labels": [{"id": "INBOX", "name": "INBOX"}]}})
    out = json.loads(registry.dispatch("gmail", {"op": "labels_list"}, client=client))
    assert out["success"] is True
    assert out["data"][0]["id"] == "INBOX"


@pytest.mark.asyncio
async def test_gmail_draft_create():
    client = FakeGoogleClient({"/drafts": {"id": "d1", "message": {"id": "m1"}}})
    out = json.loads(
        registry.dispatch(
            "gmail",
            {"op": "draft_create", "to": "x@y.com", "subject": "Hi", "body": "yo"},
            client=client,
        )
    )
    assert out["success"] is True


@pytest.mark.asyncio
async def test_drive_list():
    client = FakeGoogleClient({"/files": {"files": [{"id": "f1", "name": "Report", "mimeType": "application/pdf"}]}})
    out = json.loads(registry.dispatch("google_drive", {"op": "list"}, client=client))
    assert out["success"] is True
    assert out["data"][0]["name"] == "Report"


@pytest.mark.asyncio
async def test_calendar_events_list():
    client = FakeGoogleClient({
        "/calendars/primary/events": {
            "items": [{
                "id": "e1",
                "summary": "Standup",
                "start": {"dateTime": "2026-06-18T09:00:00Z"},
                "end": {"dateTime": "2026-06-18T09:30:00Z"},
            }]
        }
    })
    out = json.loads(registry.dispatch("google_calendar", {"op": "events_list"}, client=client))
    assert out["success"] is True
    assert out["data"][0]["summary"] == "Standup"


@pytest.mark.asyncio
async def test_calendar_create_meet():
    client = FakeGoogleClient({
        "/calendars/primary/events": {
            "id": "e2",
            "conferenceData": {"entryPoints": [{"entryPointType": "video", "uri": "https://meet.google.com/abc"}]},
        }
    })
    out = json.loads(
        registry.dispatch(
            "google_calendar",
            {
                "op": "event_create_meet",
                "summary": "Sync",
                "start": "2026-06-18T10:00:00Z",
                "end": "2026-06-18T10:30:00Z",
            },
            client=client,
        )
    )
    assert out["success"] is True
    assert out["meetLink"] == "https://meet.google.com/abc"


@pytest.mark.asyncio
async def test_docs_create():
    client = FakeGoogleClient({
        "/documents": {"documentId": "doc1", "title": "Note"},
        "/batchUpdate": {"documentId": "doc1"},
    })
    out = json.loads(
        registry.dispatch("google_docs", {"op": "create", "title": "Note", "text": "hello"}, client=client)
    )
    assert out["success"] is True
    assert out["data"]["url"] == "https://docs.google.com/document/d/doc1/edit"
    assert out["data"]["docUrl"] == "https://docs.google.com/document/d/doc1/edit"


@pytest.mark.asyncio
async def test_docs_create_formats_markdown_like_content():
    client = FakeGoogleClient({
        "/documents/doc1": {
            "body": {
                "content": [
                    {
                        "startIndex": 500,
                        "endIndex": 540,
                        "table": {
                            "tableRows": [
                                {
                                    "tableCells": [
                                        {"content": [{"startIndex": 505, "paragraph": {"elements": [{"textRun": {"content": "\n"}}]}}]},
                                        {"content": [{"startIndex": 507, "paragraph": {"elements": [{"textRun": {"content": "\n"}}]}}]},
                                        {"content": [{"startIndex": 509, "paragraph": {"elements": [{"textRun": {"content": "\n"}}]}}]},
                                    ]
                                },
                                {
                                    "tableCells": [
                                        {"content": [{"startIndex": 512, "paragraph": {"elements": [{"textRun": {"content": "\n"}}]}}]},
                                        {"content": [{"startIndex": 514, "paragraph": {"elements": [{"textRun": {"content": "\n"}}]}}]},
                                        {"content": [{"startIndex": 516, "paragraph": {"elements": [{"textRun": {"content": "\n"}}]}}]},
                                    ]
                                },
                            ]
                        },
                    },
                    {"endIndex": 541},
                ]
            }
        },
        "/documents": {"documentId": "doc1", "title": "Note"},
        "/batchUpdate": {"documentId": "doc1"},
    })
    markdown = r"""# Divo Google Smoke Test - Summary
## Steps Covered
1. Native Google tools inventory
2. Identity resolution

---

## Results Table

\| Step \| Tool \| Result \|
\|---\|---\|---\|
\| 1 \| Schema Discovery \| **PASS** \|
"""

    out = json.loads(
        registry.dispatch("google_docs", {"op": "create", "title": "Note", "text": markdown}, client=client)
    )

    assert out["success"] is True
    batch_bodies = [body for method, url, _params, body in client.calls if method == "POST" and url.endswith(":batchUpdate")]
    text_requests = batch_bodies[0]["requests"]
    inserted = text_requests[0]["insertText"]["text"]
    assert "# Divo" not in inserted
    assert "## Steps" not in inserted
    assert "---" not in inserted
    assert "| Step | Tool | Result |" not in inserted
    assert "Step\tTool\tResult" not in inserted
    assert any(req.get("updateParagraphStyle", {}).get("paragraphStyle", {}).get("namedStyleType") == "HEADING_1" for req in text_requests)
    assert any(req.get("updateParagraphStyle", {}).get("paragraphStyle", {}).get("namedStyleType") == "HEADING_2" for req in text_requests)
    assert any(req.get("createParagraphBullets", {}).get("bulletPreset") == "NUMBERED_DECIMAL_ALPHA_ROMAN" for req in text_requests)
    assert any(
        req.get("updateTextStyle", {}).get("textStyle", {}).get("fontSize", {}).get("magnitude") == 20
        for req in text_requests
    )
    assert any(req.get("insertTable", {}).get("rows") == 2 for req in batch_bodies[1]["requests"])
    filled_cell_text = "\n".join(
        req.get("insertText", {}).get("text", "")
        for req in batch_bodies[2]["requests"]
        if "insertText" in req
    )
    assert "Step" in filled_cell_text
    assert "Schema Discovery" in filled_cell_text
    assert "PASS" in filled_cell_text
    assert "|" not in filled_cell_text
    assert any(req.get("updateTextStyle", {}).get("textStyle", {}).get("bold") is True for req in batch_bodies[2]["requests"])


@pytest.mark.asyncio
async def test_docs_append_formats_markdown_like_content():
    client = FakeGoogleClient({
        "/documents/doc1": {"body": {"content": [{"endIndex": 8}]}},
        "/batchUpdate": {"documentId": "doc1"},
    })

    out = json.loads(
        registry.dispatch(
            "google_docs",
            {"op": "append", "documentId": "doc1", "text": "## Final\n- Done\n"},
            client=client,
        )
    )

    assert out["success"] is True
    _, _, _, body = client.calls[-1]
    inserted = body["requests"][0]["insertText"]
    assert inserted["location"]["index"] == 7
    assert inserted["text"] == "Final\nDone\n"
    assert any(req.get("updateParagraphStyle", {}).get("paragraphStyle", {}).get("namedStyleType") == "HEADING_2" for req in body["requests"])
    assert any(req.get("createParagraphBullets", {}).get("bulletPreset") == "BULLET_DISC_CIRCLE_SQUARE" for req in body["requests"])


@pytest.mark.asyncio
async def test_docs_read_returns_formatting_blocks():
    client = FakeGoogleClient({
        "/documents/doc1": {
            "title": "Formatted",
            "body": {
                "content": [
                    {
                        "paragraph": {
                            "paragraphStyle": {"namedStyleType": "HEADING_1"},
                            "elements": [{"textRun": {"content": "Title\n"}}],
                        }
                    },
                    {
                        "paragraph": {
                            "bullet": {"listId": "k1"},
                            "elements": [{"textRun": {"content": "Item\n"}}],
                        }
                    },
                    {
                        "table": {
                            "tableRows": [
                                {
                                    "tableCells": [
                                        {"content": [{"paragraph": {"elements": [{"textRun": {"content": "Area\n"}}]}}]},
                                        {"content": [{"paragraph": {"elements": [{"textRun": {"content": "Status\n"}}]}}]},
                                    ]
                                }
                            ]
                        }
                    },
                ]
            },
        },
    })

    out = json.loads(registry.dispatch("google_docs", {"op": "read", "documentId": "doc1"}, client=client))

    assert out["success"] is True
    blocks = out["data"]["blocks"]
    assert blocks[0] == {
        "type": "paragraph",
        "text": "Title",
        "namedStyleType": "HEADING_1",
        "isListItem": False,
    }
    assert blocks[1]["isListItem"] is True
    assert blocks[2] == {"type": "table", "rows": [["Area", "Status"]]}


@pytest.mark.asyncio
async def test_sheets_read_range():
    client = FakeGoogleClient({"/values/Sheet1!A1:B2": {"values": [["Name", "Email"], ["A", "a@x.com"]]}})
    out = json.loads(
        registry.dispatch(
            "google_sheets",
            {"op": "read_range", "spreadsheetId": "sheet1", "range": "Sheet1!A1:B2"},
            client=client,
        )
    )
    assert out["success"] is True
    assert out["data"][0][0] == "Name"


@pytest.mark.asyncio
async def test_sheets_create_returns_url():
    client = FakeGoogleClient({"/spreadsheets": {"spreadsheetId": "sheet1", "properties": {"title": "Budget"}}})
    out = json.loads(registry.dispatch("google_sheets", {"op": "create", "title": "Budget"}, client=client))
    assert out["success"] is True
    assert out["data"]["url"] == "https://docs.google.com/spreadsheets/d/sheet1/edit"
    assert out["data"]["spreadsheetUrl"] == "https://docs.google.com/spreadsheets/d/sheet1/edit"


@pytest.mark.asyncio
async def test_slides_create():
    client = FakeGoogleClient({"/presentations": {"presentationId": "p1", "slides": [{"objectId": "slide1"}]}})
    out = json.loads(registry.dispatch("google_slides", {"op": "create", "title": "Deck"}, client=client))
    assert out["success"] is True
    assert out["data"]["url"] == "https://docs.google.com/presentation/d/p1/edit"


# ── Gmail parity ops (ported from legacy advance-backend) ───────────────────
def _last_send_raw(client) -> str:
    """Decode the base64url MIME of the most recent messages.send call."""
    for method, url, _params, body in reversed(client.calls):
        if method == "POST" and url.endswith("/messages/send"):
            return base64.urlsafe_b64decode((body or {})["raw"]).decode()
    raise AssertionError("no messages.send call recorded")


@pytest.mark.asyncio
async def test_gmail_reply_all_excludes_self_and_dedupes():
    responses = {
        "/messages/m1": {
            "threadId": "t1",
            "payload": {"headers": [
                {"name": "From", "value": "Alice <a@x.com>"},
                {"name": "To", "value": "me@x.com, Bob <b@y.com>"},
                {"name": "Cc", "value": "c@z.com, b@y.com"},
                {"name": "Subject", "value": "Hello"},
                {"name": "Message-ID", "value": "<mid-1>"},
            ]},
        },
        "/profile": {"emailAddress": "me@x.com"},
        "/messages/send": {"id": "sent1"},
    }
    client = FakeGoogleClient(responses)
    out = json.loads(registry.dispatch("gmail", {"op": "reply_all", "messageId": "m1", "body": "ok"}, client=client))
    assert out["success"] is True
    raw = _last_send_raw(client)
    assert "a@x.com" in raw and "b@y.com" in raw  # original sender + To kept
    assert "c@z.com" in raw                        # Cc kept
    assert "me@x.com" not in raw                   # self removed everywhere
    assert raw.count("b@y.com") == 1               # deduped across To/Cc
    # threaded reply
    assert any(b and b.get("threadId") == "t1" for _m, _u, _p, b in client.calls if b)


@pytest.mark.asyncio
async def test_gmail_archive_removes_inbox_label():
    client = FakeGoogleClient({"/modify": {"id": "m1", "labelIds": []}})
    out = json.loads(registry.dispatch("gmail", {"op": "archive", "messageId": "m1"}, client=client))
    assert out["success"] is True
    _m, url, _p, body = client.calls[-1]
    assert url.endswith("/messages/m1/modify")
    assert body == {"removeLabelIds": ["INBOX"]}


@pytest.mark.asyncio
async def test_gmail_mark_unread_adds_label():
    client = FakeGoogleClient({"/modify": {"id": "m1"}})
    json.loads(registry.dispatch("gmail", {"op": "mark_unread", "messageId": "m1"}, client=client))
    assert client.calls[-1][3] == {"addLabelIds": ["UNREAD"]}


@pytest.mark.asyncio
async def test_gmail_trash_uses_trash_endpoint():
    client = FakeGoogleClient({"/trash": {"id": "m1"}})
    out = json.loads(registry.dispatch("gmail", {"op": "trash", "messageId": "m1"}, client=client))
    assert out["success"] is True
    assert client.calls[-1][1].endswith("/messages/m1/trash")


@pytest.mark.asyncio
async def test_gmail_thread_get_summarizes_messages():
    responses = {"/threads/t1": {"messages": [
        {"id": "m1", "snippet": "hi", "payload": {"headers": [
            {"name": "From", "value": "a@x.com"}, {"name": "Subject", "value": "Hello"},
        ]}},
    ]}}
    client = FakeGoogleClient(responses)
    out = json.loads(registry.dispatch("gmail", {"op": "thread_get", "threadId": "t1"}, client=client))
    assert out["success"] is True
    assert out["data"]["messages"][0]["subject"] == "Hello"


@pytest.mark.asyncio
async def test_gmail_draft_get_and_delete():
    get_client = FakeGoogleClient({"/drafts/d1": {"id": "d1", "message": {"payload": {
        "headers": [{"name": "To", "value": "x@y.com"}, {"name": "Subject", "value": "Hi"}],
        "body": {"data": _b64url("hello body")},
    }}}})
    out = json.loads(registry.dispatch("gmail", {"op": "draft_get", "draftId": "d1"}, client=get_client))
    assert out["success"] is True
    assert out["data"]["subject"] == "Hi"

    del_client = FakeGoogleClient({})
    out = json.loads(registry.dispatch("gmail", {"op": "draft_delete", "draftId": "d1"}, client=del_client))
    assert out["success"] is True
    assert del_client.calls[-1][0] == "DELETE"
