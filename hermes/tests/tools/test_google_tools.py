"""Tests for the native Gmail + Drive tool handlers (parsing, no network)."""

import base64
import json

import pytest

import tools.google_tools  # noqa: F401 — registers gmail + google_drive
from tools.registry import registry


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
    assert out["data"][0]["from"] == "a@x.com"


@pytest.mark.asyncio
async def test_gmail_get_decodes_body():
    msg = {
        "payload": {
            "headers": [{"name": "Subject", "value": "Body test"}],
            "mimeType": "text/plain",
            "body": {"data": _b64url("the plain body")},
        }
    }
    client = FakeGoogleClient({"/users/me/messages/abc": msg})
    out = json.loads(registry.dispatch("gmail", {"op": "get", "messageId": "abc"}, client=client))
    assert out["success"] is True
    assert out["data"]["body"] == "the plain body"
    assert out["data"]["subject"] == "Body test"


@pytest.mark.asyncio
async def test_gmail_send_builds_raw():
    client = FakeGoogleClient({"/messages/send": {"id": "sent123"}})
    out = json.loads(
        registry.dispatch(
            "gmail", {"op": "send", "to": "x@y.com", "subject": "Hi", "body": "yo"}, client=client
        )
    )
    assert out["success"] is True
    assert out["id"] == "sent123"
    # the raw payload was base64url-encoded RFC822
    _, _, _, json_body = client.calls[-1]
    assert "raw" in json_body


@pytest.mark.asyncio
async def test_gmail_get_requires_message_id():
    client = FakeGoogleClient({})
    out = json.loads(registry.dispatch("gmail", {"op": "get"}, client=client))
    assert out["success"] is False


@pytest.mark.asyncio
async def test_drive_list():
    client = FakeGoogleClient({"/files": {"files": [{"id": "f1", "name": "Report", "mimeType": "application/pdf"}]}})
    out = json.loads(registry.dispatch("google_drive", {"op": "list"}, client=client))
    assert out["success"] is True
    assert out["data"][0]["name"] == "Report"


@pytest.mark.asyncio
async def test_drive_get_requires_file_id():
    client = FakeGoogleClient({})
    out = json.loads(registry.dispatch("google_drive", {"op": "get"}, client=client))
    assert out["success"] is False
