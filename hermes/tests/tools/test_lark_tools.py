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


def _patch_company_people(monkeypatch):
    def fake_users(*, company_id=None):
        assert company_id == "comp_1"
        return [
            {"id": "cu_anish", "display_name": "Anish Suman", "email": "anish@emiactech.com"},
            {"id": "cu_rahul", "display_name": "Rahul Sharma", "email": "rahul@emiactech.com"},
        ]

    def fake_identities(company_user_id):
        rows = {
            "cu_anish": [
                {
                    "platform": "lark",
                    "platform_user_id": "ou_anish",
                    "display_name": "Anish Suman",
                }
            ],
            "cu_rahul": [
                {
                    "platform": "lark",
                    "platform_user_id": "ou_rahul",
                    "display_name": "Rahul Sharma",
                }
            ],
        }
        return rows[company_user_id]

    monkeypatch.setattr("gateway.company_identity.list_company_users", fake_users)
    monkeypatch.setattr("gateway.company_identity.list_channel_identities_for_company_user", fake_identities)


def _admin_identity_kwargs():
    return {
        "company_id": "comp_1",
        "company_user_id": "cu_requester",
        "channel_identity_id": "ci_requester",
        "company_role": "ADMIN",
        "lark_open_id": "ou_requester",
    }


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


@pytest.mark.asyncio
async def test_messaging_reply_get_list_and_search():
    client = FakeLarkClient(
        {
            "/messages/om_parent/reply": {"message": {"message_id": "om_reply"}},
            "/messages/om_1": {
                "items": [
                    {
                        "message_id": "om_1",
                        "body": {"content": json.dumps({"text": "hello"})},
                        "sender": {"id": "ou_me"},
                        "create_time": "1780000000",
                    }
                ]
            },
            "/messages": {
                "items": [
                    {
                        "message_id": "om_2",
                        "body": {"content": json.dumps({"text": "search hit"})},
                        "sender": {"id": "ou_other"},
                    }
                ]
            },
        }
    )

    reply = json.loads(registry.dispatch("lark_messaging", {"op": "reply", "messageId": "om_parent", "text": "ok"}, client=client))
    get = json.loads(registry.dispatch("lark_messaging", {"op": "get", "messageId": "om_1"}, client=client))
    listed = json.loads(registry.dispatch("lark_messaging", {"op": "list", "chatId": "oc_1", "limit": 5}, client=client))
    searched = json.loads(registry.dispatch("lark_messaging", {"op": "search", "chatId": "oc_1", "query": "hit"}, client=client))

    assert reply["messageId"] == "om_reply"
    assert get["data"]["text"] == "hello"
    assert listed["data"][0]["text"] == "search hit"
    assert searched["data"][0]["messageId"] == "om_2"
    assert client.calls[-1][2]["query"] == "hit"


@pytest.mark.asyncio
async def test_messaging_send_dm_and_mention_resolve_names(monkeypatch):
    _patch_company_people(monkeypatch)
    client = FakeLarkClient({"/messages": {"message_id": "om_123"}})

    dm = json.loads(
        registry.dispatch(
            "lark_messaging",
            {"op": "send_dm", "recipientName": "Anish sir", "text": "hello"},
            client=client,
            **_admin_identity_kwargs(),
        )
    )
    mention = json.loads(
        registry.dispatch(
            "lark_messaging",
            {"op": "mention", "chatId": "oc_1", "mentionNames": ["Rahul"], "text": "please check"},
            client=client,
            **_admin_identity_kwargs(),
        )
    )

    assert dm["success"] is True
    assert mention["success"] is True
    _, _, dm_params, dm_body = client.calls[-2]
    assert dm_params["receive_id_type"] == "open_id"
    assert dm_body["receive_id"] == "ou_anish"
    _, _, mention_params, mention_body = client.calls[-1]
    assert mention_params["receive_id_type"] == "chat_id"
    content = json.loads(mention_body["content"])
    assert content["zh_cn"]["content"][0][0] == {"tag": "at", "user_id": "ou_rahul"}


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
    out2 = json.loads(registry.dispatch("lark_calendar", {"op": "list", "limit": 3}, client=client2))
    assert out2["data"][0]["eventId"] == "ev2"
    assert out2["data"][0]["startTime"].startswith("2026")
    # Lark's events endpoint rejects page_size < 50 and requires a time window:
    # request the API minimum (50) + start/end, slice client-side. (Real-API
    # constraint that a naive mock would miss — see live test 2026-06-12.)
    _, _, params, _ = client2.calls[-1]
    assert params["page_size"] == 50
    assert "start_time" in params and "end_time" in params


@pytest.mark.asyncio
async def test_calendar_create_recurring_resolves_attendee_names(monkeypatch):
    _patch_company_people(monkeypatch)
    client = FakeLarkClient({"/events": {"event": {"event_id": "ev_recurring"}}})

    out = json.loads(
        registry.dispatch(
            "lark_calendar",
            {
                "op": "create_recurring",
                "title": "Weekly finance sync",
                "startTime": "2026-06-15T10:00:00Z",
                "endTime": "2026-06-15T10:30:00Z",
                "attendeeNames": ["Anish"],
                "recurrence": {"frequency": "weekly", "daysOfWeek": ["MO"], "count": 4},
            },
            client=client,
            **_admin_identity_kwargs(),
        )
    )

    assert out["success"] is True
    assert out["eventId"] == "ev_recurring"
    _, _, _, body = client.calls[-1]
    assert body["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4"]
    assert body["attendees"] == [
        {"type": "user", "user_id": "ou_anish"},
        {"type": "user", "user_id": "ou_requester"},
    ]


@pytest.mark.asyncio
async def test_calendar_free_busy_and_update_attendees_resolve_names(monkeypatch):
    _patch_company_people(monkeypatch)
    client = FakeLarkClient(
        {
            "/freebusy/list": {"freebusy_list": [{"start_time": "2026-06-15T10:00:00Z", "end_time": "2026-06-15T10:30:00Z"}]},
            "/events/ev1/attendees/batch_delete": {},
            "/events/ev1/attendees": {
                "items": [
                    {"attendee_id": "att_rahul", "user_id": "ou_rahul"},
                    {"attendee_id": "att_other", "user_id": "ou_other"},
                ]
            },
        }
    )

    busy = json.loads(
        registry.dispatch(
            "lark_calendar",
            {
                "op": "free_busy",
                "names": ["Anish"],
                "dateFrom": "2026-06-15T00:00:00Z",
                "dateTo": "2026-06-16T00:00:00Z",
            },
            client=client,
            **_admin_identity_kwargs(),
        )
    )
    updated = json.loads(
        registry.dispatch(
            "lark_calendar",
            {"op": "update_attendees", "eventId": "ev1", "addNames": ["Anish"], "removeNames": ["Rahul"]},
            client=client,
            **_admin_identity_kwargs(),
        )
    )

    assert busy["success"] is True
    assert busy["data"]["ou_anish"]["busy"][0]["start"] == "2026-06-15T10:00:00Z"
    assert updated["success"] is True
    assert client.calls[0][3]["user_id"] == "ou_anish"
    assert client.calls[1][3]["attendees"] == [{"type": "user", "user_id": "ou_anish"}]
    assert client.calls[-1][3]["attendee_ids"] == ["att_rahul"]


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
async def test_task_create_defaults_to_requester_when_no_assignee():
    client = FakeLarkClient({"/tasks": {"task": {"guid": "t1", "summary": "Do it"}}})
    out = json.loads(
        registry.dispatch(
            "lark_task",
            {"op": "create", "title": "Do it"},
            client=client,
            lark_open_id="ou_requester",
        )
    )

    assert out["success"] is True
    _, _, _, body = client.calls[-1]
    assert body["members"] == [{"id": "ou_requester", "type": "user", "role": "assignee"}]


@pytest.mark.asyncio
async def test_task_create_resolves_assignee_names_from_company_identity(monkeypatch):
    _patch_company_people(monkeypatch)
    client = FakeLarkClient({"/tasks": {"task": {"guid": "t1", "summary": "Follow up"}}})

    out = json.loads(
        registry.dispatch(
            "lark_task",
            {"op": "create", "title": "Follow up", "assigneeNames": ["Anish sir"]},
            client=client,
            company_id="comp_1",
            company_user_id="cu_requester",
            channel_identity_id="ci_requester",
            company_role="ADMIN",
            lark_open_id="ou_requester",
        )
    )

    assert out["success"] is True
    _, _, _, body = client.calls[-1]
    assert body["members"] == [{"id": "ou_anish", "type": "user", "role": "assignee"}]


@pytest.mark.asyncio
async def test_task_list_open_mine_filters_requester_and_completion():
    client = FakeLarkClient(
        {
            "/tasks": {
                "items": [
                    {
                        "guid": "t1",
                        "summary": "Mine open",
                        "members": [{"id": "ou_me"}],
                        "completed": False,
                    },
                    {
                        "guid": "t2",
                        "summary": "Mine done",
                        "members": [{"id": "ou_me"}],
                        "completed_at": "1780000000000",
                    },
                    {
                        "guid": "t3",
                        "summary": "Someone else",
                        "members": [{"id": "ou_other"}],
                        "completed": False,
                    },
                ]
            }
        }
    )

    out = json.loads(
        registry.dispatch(
            "lark_task",
            {"op": "listOpenMine", "limit": 10},
            client=client,
            lark_open_id="ou_me",
        )
    )

    assert out["success"] is True
    assert out["message"] == "Found 1 open tasks assigned to you"
    assert [item["taskId"] for item in out["data"]] == ["t1"]


@pytest.mark.asyncio
async def test_task_list_falls_back_to_tasklists_when_broad_list_empty():
    class FallbackClient(FakeLarkClient):
        async def request(self, method, path, *, params=None, json_body=None):
            self.calls.append((method, path, params, json_body))
            if path == "/open-apis/task/v2/tasks" and not (params or {}).get("tasklist_id"):
                return {"items": []}
            if path == "/open-apis/task/v2/tasklists":
                return {"items": [{"guid": "tl1", "name": "Sprint"}]}
            if path == "/open-apis/task/v2/tasks" and (params or {}).get("tasklist_id") == "tl1":
                return {"items": [{"guid": "t1", "summary": "From tasklist"}]}
            return {}

    client = FallbackClient({})
    out = json.loads(registry.dispatch("lark_task", {"op": "list", "limit": 5}, client=client))

    assert out["success"] is True
    assert [item["taskId"] for item in out["data"]] == ["t1"]
    assert client.calls[1][1] == "/open-apis/task/v2/tasklists"
    assert client.calls[2][2]["tasklist_id"] == "tl1"


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


def test_lark_tools_are_autodiscoverable():
    """Regression guard: the built-in autoloader only imports a tool module when
    an AST scan finds a TOP-LEVEL registry.register(...) call. Registering in a
    for-loop made all Lark tools invisible to a real agent session (caught via
    `are the tools registered beside legacy hermes tools?`). Keep registrations
    as explicit top-level calls.
    """
    from pathlib import Path

    from tools.registry import _module_registers_tools, discover_builtin_tools

    lark_path = Path(__file__).resolve().parents[2] / "tools" / "lark_tools.py"
    assert _module_registers_tools(lark_path), "lark_tools.py not detected by autoloader"
    assert "tools.lark_tools" in discover_builtin_tools()
