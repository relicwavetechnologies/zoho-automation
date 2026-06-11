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


# ── Doc / Base / Calendar / Contacts / Task / Approval families ──────────────

@pytest.mark.asyncio
async def test_doc_create_and_append():
    client = FakeLarkClient({
        "/documents": {"document": {"document_id": "doc_1"}},
    })
    out = json.loads(registry.dispatch("lark_doc", {"op": "create", "title": "Spec"}, client=client))
    assert out["success"] is True and out["docToken"] == "doc_1"

    client2 = FakeLarkClient({"/children": {}})
    out2 = json.loads(registry.dispatch(
        "lark_doc", {"op": "append_block", "docToken": "doc_1", "content": "hi", "blockType": "heading1"}, client=client2))
    assert out2["success"] is True
    _, path, _, body = client2.calls[-1]
    assert "/blocks/doc_1/children" in path
    assert body["children"][0]["block_type"] == 3  # heading1


@pytest.mark.asyncio
async def test_base_create_and_search():
    client = FakeLarkClient({"/records/search": {"items": [{"record_id": "r1"}]},
                             "/records": {"record": {"record_id": "rNEW"}}})
    out = json.loads(registry.dispatch(
        "lark_base", {"op": "create_record", "appToken": "app", "tableId": "tbl", "fields": {"Name": "X"}}, client=client))
    assert out["success"] is True and out["recordId"] == "rNEW"

    out2 = json.loads(registry.dispatch(
        "lark_base", {"op": "search_records", "appToken": "app", "tableId": "tbl", "fieldName": "Name", "filterValue": "X"}, client=client))
    assert out2["success"] is True and out2["data"][0]["record_id"] == "r1"
    _, _, _, body = client.calls[-1]
    assert body["filter"]["conditions"][0]["field_name"] == "Name"


@pytest.mark.asyncio
async def test_calendar_create_converts_time_and_list_normalizes():
    client = FakeLarkClient({"/events": {"event": {"event_id": "ev1"}}})
    out = json.loads(registry.dispatch(
        "lark_calendar",
        {"op": "create", "title": "Sync", "startTime": "2026-06-12T10:00:00Z", "endTime": "2026-06-12T11:00:00Z",
         "attendeeIds": ["ou_a"]},
        client=client))
    assert out["success"] is True and out["eventId"] == "ev1"
    _, _, _, body = client.calls[-1]
    assert body["start_time"]["timestamp"].isdigit()
    assert body["attendees"][0]["user_id"] == "ou_a"

    client2 = FakeLarkClient({"/events": {"items": [
        {"event_id": "ev2", "summary": "Standup", "start_time": {"timestamp": "1781000000"}, "end_time": {"timestamp": "1781003600"}}]}})
    out2 = json.loads(registry.dispatch("lark_calendar", {"op": "list"}, client=client2))
    assert out2["data"][0]["eventId"] == "ev2"
    assert out2["data"][0]["startTime"].startswith("2026")


@pytest.mark.asyncio
async def test_contacts_lookup_batch_get_id():
    client = FakeLarkClient({"/batch_get_id": {"user_list": [{"user_id": "ou_1", "email": "a@x.com"}]}})
    out = json.loads(registry.dispatch("lark_contacts", {"op": "lookup", "emails": ["a@x.com"]}, client=client))
    assert out["success"] is True
    assert out["data"]["found"][0]["openId"] == "ou_1"


@pytest.mark.asyncio
async def test_task_create_with_due_and_members():
    client = FakeLarkClient({"/tasks": {"task": {"guid": "t1", "summary": "Do it"}}})
    out = json.loads(registry.dispatch(
        "lark_task", {"op": "create", "title": "Do it", "dueDate": "2026-06-12T09:00:00Z", "assigneeIds": ["ou_x"]}, client=client))
    assert out["success"] is True and out["data"]["taskId"] == "t1"
    _, _, _, body = client.calls[-1]
    assert body["due"]["timestamp"].isdigit() and body["due"]["is_all_day"] is False
    assert body["members"][0]["role"] == "assignee"


@pytest.mark.asyncio
async def test_task_complete_and_tasklists():
    client = FakeLarkClient({"/complete": {}, "/tasklists": {"items": [{"guid": "tl1", "name": "Sprint"}]}})
    out = json.loads(registry.dispatch("lark_task", {"op": "complete", "taskId": "t1"}, client=client))
    assert out["success"] is True
    out2 = json.loads(registry.dispatch("lark_task", {"op": "list_tasklists"}, client=client))
    assert out2["data"][0]["name"] == "Sprint"


@pytest.mark.asyncio
async def test_approval_create_form_and_list():
    client = FakeLarkClient({"/instances": {"instance_code": "ic1"}})
    out = json.loads(registry.dispatch(
        "lark_approval", {"op": "create", "approvalCode": "AC", "formValues": {"f1": "v1"}}, client=client))
    assert out["success"] is True and out["instanceCode"] == "ic1"
    _, _, _, body = client.calls[-1]
    assert json.loads(body["form"])[0] == {"id": "f1", "value": "v1"}


@pytest.mark.asyncio
async def test_family_required_params():
    client = FakeLarkClient({})
    assert json.loads(registry.dispatch("lark_doc", {"op": "update_block", "docToken": "d"}, client=client))["success"] is False
    assert json.loads(registry.dispatch("lark_base", {"op": "get_record", "appToken": "a", "tableId": "t"}, client=client))["success"] is False
    assert json.loads(registry.dispatch("lark_task", {"op": "get"}, client=client))["success"] is False
    assert json.loads(registry.dispatch("lark_approval", {"op": "get", "approvalCode": "AC"}, client=client))["success"] is False
