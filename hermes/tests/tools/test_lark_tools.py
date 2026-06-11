"""Tests for the native Lark messaging tool handler (no network)."""

import json

import pytest

import tools.lark_tools  # noqa: F401 — registers lark_messaging
from tools.registry import registry


class FakeLarkClient:
    def __init__(self, responses):
        self._responses = responses
        self.calls = []

    async def request(self, method, path, *, params=None, json_body=None):
        self.calls.append((method, path, params, json_body))
        for needle, resp in self._responses.items():
            if needle in path:
                return resp
        return {}


@pytest.mark.asyncio
async def test_list_chats():
    client = FakeLarkClient({"/chats": {"items": [{"chat_id": "oc_1", "name": "Team"}]}})
    out = json.loads(registry.dispatch("lark_messaging", {"op": "list_chats"}, client=client))
    assert out["success"] is True
    assert out["data"][0]["chat_id"] == "oc_1"
    assert out["data"][0]["name"] == "Team"


@pytest.mark.asyncio
async def test_send_builds_text_message():
    client = FakeLarkClient({"/messages": {"message_id": "om_123"}})
    out = json.loads(
        registry.dispatch(
            "lark_messaging",
            {"op": "send", "receiveId": "oc_1", "receiveIdType": "chat_id", "text": "hi"},
            client=client,
        )
    )
    assert out["success"] is True
    assert out["messageId"] == "om_123"
    method, path, params, body = client.calls[-1]
    assert params["receive_id_type"] == "chat_id"
    assert body["receive_id"] == "oc_1"
    assert body["msg_type"] == "text"
    assert json.loads(body["content"])["text"] == "hi"


@pytest.mark.asyncio
async def test_send_requires_receive_id():
    client = FakeLarkClient({})
    out = json.loads(registry.dispatch("lark_messaging", {"op": "send", "text": "hi"}, client=client))
    assert out["success"] is False


@pytest.mark.asyncio
async def test_unknown_op():
    client = FakeLarkClient({})
    out = json.loads(registry.dispatch("lark_messaging", {"op": "bogus"}, client=client))
    assert out["success"] is False
