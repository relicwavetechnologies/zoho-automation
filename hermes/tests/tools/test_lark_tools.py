"""Tests for the native Lark messaging tool handler (no network)."""

import json

import httpx
import pytest

import tools.lark_tools as lark_tools  # noqa: F401 — registers lark_messaging
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


def _patch_duplicate_current_user(monkeypatch):
    def fake_users(*, company_id=None):
        assert company_id == "comp_1"
        return [
            {
                "id": "cu_abhishek",
                "display_name": "Abhishek Verma",
                "email": "abhishek@emiactech.com",
            }
        ]

    def fake_identities(company_user_id):
        assert company_user_id == "cu_abhishek"
        return [
            {
                "platform": "lark",
                "platform_user_id": "beac9a13",
                "platform_user_id_alt": "on_same_union",
                "display_name": "Abhishek Verma",
                "approved_source": "gateway",
            },
            {
                "platform": "lark",
                "platform_user_id": "ou_abhishek",
                "platform_user_id_alt": "on_same_union",
                "display_name": "Abhishek Verma",
                "approved_source": "dashboard_auth",
            },
        ]

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
async def test_send_defaults_to_current_lark_chat():
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars(platform="lark", chat_id="oc_current")
    try:
        client = FakeLarkClient({"/messages": {"message_id": "om_123"}})
        out = json.loads(
            registry.dispatch(
                "lark_messaging",
                {"op": "send", "text": "hi current chat"},
                client=client,
            )
        )
    finally:
        clear_session_vars(tokens)

    assert out["success"] is True
    _, _, params, body = client.calls[-1]
    assert params["receive_id_type"] == "chat_id"
    assert body["receive_id"] == "oc_current"


@pytest.mark.asyncio
async def test_send_markdown_table_uses_interactive_card():
    client = FakeLarkClient({"/messages": {"message_id": "om_123"}})
    text = """Done.

| Field | Value |
|---|---|
| **Title** | Hermes Harness Docs Test |
| **URL** | https://example.com/doc |
"""

    out = json.loads(
        registry.dispatch(
            "lark_messaging",
            {"op": "send", "receiveId": "oc_1", "receiveIdType": "chat_id", "text": text},
            client=client,
        )
    )

    assert out["success"] is True
    _, _, _, body = client.calls[-1]
    assert body["msg_type"] == "interactive"
    card = json.loads(body["content"])
    assert card["schema"] == "2.0"
    assert any(element["tag"] == "table" for element in card["body"]["elements"])


@pytest.mark.asyncio
async def test_send_markdown_bullets_uses_post():
    client = FakeLarkClient({"/messages": {"message_id": "om_123"}})

    out = json.loads(
        registry.dispatch(
            "lark_messaging",
            {"op": "send", "receiveId": "oc_1", "receiveIdType": "chat_id", "text": "- **Task:** done"},
            client=client,
        )
    )

    assert out["success"] is True
    _, _, _, body = client.calls[-1]
    assert body["msg_type"] == "post"
    post = json.loads(body["content"])
    assert post["zh_cn"]["content"][0][0]["tag"] == "md"


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
    assert client.calls[0] == (
        "POST",
        "/open-apis/docs_ai/v1/documents",
        None,
        {"content": "<title>Spec</title>", "format": "xml"},
    )

    client2 = FakeLarkClient({"/children": {}})
    out2 = json.loads(registry.dispatch(
        "lark_doc", {"op": "append_block", "docToken": "doc_1", "content": "hi", "blockType": "heading1"}, client=client2))
    assert out2["success"] is True
    _, path, _, body = client2.calls[-1]
    assert "/blocks/doc_1/children" in path
    assert body["children"][0]["block_type"] == 3  # heading1


@pytest.mark.asyncio
async def test_doc_create_returns_url_from_api_response():
    client = FakeLarkClient({
        "/documents": {"document": {"document_id": "doc_1", "url": "https://tenant.larksuite.com/docx/doc_1"}},
    })

    out = json.loads(registry.dispatch("lark_doc", {"op": "create", "title": "Spec"}, client=client))

    assert out["success"] is True
    assert out["docToken"] == "doc_1"
    assert out["url"] == "https://tenant.larksuite.com/docx/doc_1"
    assert out["docUrl"] == "https://tenant.larksuite.com/docx/doc_1"
    assert out["data"]["url"] == "https://tenant.larksuite.com/docx/doc_1"


@pytest.mark.asyncio
async def test_doc_create_resolves_url_from_drive_metadata_api():
    client = FakeLarkClient({
        "/documents": {"document": {"document_id": "doc_1"}},
        "/metas/batch_query": {
            "metas": [
                {
                    "doc_token": "doc_1",
                    "doc_type": "docx",
                    "title": "Spec",
                    "url": "https://tenant.larksuite.com/docx/doc_1",
                }
            ]
        },
    })

    out = json.loads(registry.dispatch("lark_doc", {"op": "create", "title": "Spec"}, client=client))

    assert out["success"] is True
    assert out["url"] == "https://tenant.larksuite.com/docx/doc_1"
    assert out["docUrl"] == "https://tenant.larksuite.com/docx/doc_1"
    assert "urlHint" not in out
    _, path, _, body = client.calls[-1]
    assert path == "/open-apis/drive/v1/metas/batch_query"
    assert body == {
        "request_docs": [{"doc_token": "doc_1", "doc_type": "docx"}],
        "with_url": True,
    }


@pytest.mark.asyncio
async def test_doc_create_returns_url_hint_when_drive_metadata_has_no_url():
    client = FakeLarkClient({
        "/documents": {"document": {"document_id": "doc_1"}},
        "/metas/batch_query": {"metas": [{"doc_token": "doc_1", "doc_type": "docx"}]},
    })

    out = json.loads(registry.dispatch("lark_doc", {"op": "create", "title": "Spec"}, client=client))

    assert out["success"] is True
    assert out["docToken"] == "doc_1"
    assert "url" not in out
    assert "Drive metadata lookup" in out["urlHint"]


@pytest.mark.asyncio
async def test_doc_create_markdown_builds_structured_blocks():
    client = FakeLarkClient({
        "/documents": {"document": {"document_id": "doc_1"}},
    })
    markdown = """# Strategy Brief

Opening context for the team.

## Priorities
- Reduce response time
- Improve finance exports

| Owner | Task |
| --- | --- |
| Anish | Review |

```text
ship checklist
```
"""

    out = json.loads(
        registry.dispatch(
            "lark_doc",
            {"op": "create_markdown", "title": "Strategy Brief", "markdown": markdown},
            client=client,
        )
    )

    assert out["success"] is True
    assert out["docToken"] == "doc_1"
    assert out["message"] == "Document created from markdown."
    method, path, _params, body = client.calls[0]
    assert method == "POST"
    assert path == "/open-apis/docs_ai/v1/documents"
    assert body["format"] == "markdown"
    assert body["content"].startswith("# Strategy Brief")
    assert "Opening context for the team." in body["content"]
    assert "Anish | Review" in body["content"]
    assert "ship checklist" in body["content"]


@pytest.mark.asyncio
async def test_doc_append_markdown_requires_body_and_appends_blocks():
    client = FakeLarkClient({"/children": {}})

    missing = json.loads(registry.dispatch("lark_doc", {"op": "append_markdown", "docToken": "doc_1"}, client=client))
    out = json.loads(
        registry.dispatch(
            "lark_doc",
            {"op": "append_markdown", "docToken": "doc_1", "content": "### Next\n1. Smoke test"},
            client=client,
        )
    )

    assert missing["success"] is False
    assert out["success"] is True
    method, path, _params, body = client.calls[-1]
    assert method == "PUT"
    assert path == "/open-apis/docs_ai/v1/documents/doc_1"
    assert body == {
        "block_id": "-1",
        "command": "block_insert_after",
        "content": "### Next\n1. Smoke test",
        "format": "markdown",
        "revision_id": -1,
    }


@pytest.mark.asyncio
async def test_doc_insert_table_omits_invalid_cells_count():
    client = FakeLarkClient({"/children": {}})

    out = json.loads(
        registry.dispatch(
            "lark_doc",
            {"op": "insert_table", "docToken": "doc_1", "rows": 2, "cols": 3},
            client=client,
        )
    )

    assert out["success"] is True
    _, path, _params, body = client.calls[-1]
    assert path == "/open-apis/docx/v1/documents/doc_1/blocks/doc_1/children"
    table = body["children"][0]["table"]
    assert table["property"] == {"row_size": 2, "column_size": 3}
    assert "cells" not in table


@pytest.mark.asyncio
async def test_doc_share_uses_drive_v1_public_permission_and_visibility_alias():
    client = FakeLarkClient({"/permissions/doc_1/public": {}})

    out = json.loads(
        registry.dispatch(
            "lark_doc",
            {"op": "share", "docToken": "doc_1", "visibility": "organization"},
            client=client,
        )
    )

    assert out["success"] is True
    method, path, params, body = client.calls[-1]
    assert method == "PATCH"
    assert path == "/open-apis/drive/v1/permissions/doc_1/public"
    assert params == {"type": "docx"}
    assert body == {"external_access": False, "link_share_entity": "tenant_readable"}


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
    client = FakeLarkClient({
        "/calendars/primary": {
            "calendars": [{"calendar": {"calendar_id": "feishu.cn_primary_cal@group.calendar.feishu.cn"}}],
        },
        "/events": {"event": {"event_id": "ev1"}},
    })
    out = json.loads(registry.dispatch(
        "lark_calendar",
        {"op": "create", "title": "Sync", "startTime": "2026-06-12T10:00:00Z", "endTime": "2026-06-12T11:00:00Z",
         "attendeeIds": ["ou_a"]},
        client=client))
    assert out["success"] is True and out["eventId"] == "ev1"
    _, _, _, body = client.calls[-1]
    assert body["start_time"]["timestamp"].isdigit()
    assert body["attendees"][0]["user_id"] == "ou_a"

    client2 = FakeLarkClient({
        "/calendars/primary": {
            "calendars": [{"calendar": {"calendar_id": "feishu.cn_primary_cal@group.calendar.feishu.cn"}}],
        },
        "/events": {"items": [
            {"event_id": "ev2", "summary": "Standup", "start_time": {"timestamp": "1781000000"}, "end_time": {"timestamp": "1781003600"}}]},
    })
    out2 = json.loads(registry.dispatch("lark_calendar", {"op": "list", "limit": 3}, client=client2))
    assert out2["data"][0]["eventId"] == "ev2"
    assert out2["data"][0]["startTime"].startswith("2026")
    # Lark's events endpoint rejects page_size < 50 and requires a time window:
    # request the API minimum (50) + start/end, slice client-side. (Real-API
    # constraint that a naive mock would miss — see live test 2026-06-12.)
    assert client2.calls[0][1] == "/open-apis/calendar/v4/calendars/primary"
    _, events_path, params, _ = client2.calls[-1]
    assert events_path.endswith("/events")
    assert "feishu.cn_primary_cal@group.calendar.feishu.cn" in events_path
    assert params["page_size"] == 50
    assert "start_time" in params and "end_time" in params


@pytest.mark.asyncio
async def test_calendar_create_uses_user_oauth_client_for_primary_calendar():
    app_client = FakeLarkClient({})
    user_client = FakeLarkClient({
        "/calendars/primary": {
            "calendars": [{"calendar": {"calendar_id": "feishu.cn_user_primary@group.calendar.feishu.cn"}}],
        },
        "/events": {"event": {"event_id": "ev_user"}},
    })

    out = json.loads(
        registry.dispatch(
            "lark_calendar",
            {
                "op": "create",
                "title": "User calendar sync",
                "startTime": "2026-06-12T10:00:00Z",
                "endTime": "2026-06-12T11:00:00Z",
            },
            client=app_client,
            user_client=user_client,
            **_admin_identity_kwargs(),
        )
    )

    assert out["success"] is True
    assert out["eventId"] == "ev_user"
    assert app_client.calls == []
    assert user_client.calls[0][1] == "/open-apis/calendar/v4/calendars/primary"
    assert user_client.calls[-1][0] == "POST"
    assert "/calendars/feishu.cn_user_primary@group.calendar.feishu.cn/events" in user_client.calls[-1][1]


@pytest.mark.asyncio
async def test_calendar_create_recurring_resolves_attendee_names(monkeypatch):
    _patch_company_people(monkeypatch)
    client = FakeLarkClient({
        "/calendars/primary": {
            "calendars": [{"calendar": {"calendar_id": "feishu.cn_primary_cal@group.calendar.feishu.cn"}}],
        },
        "/events": {"event": {"event_id": "ev_recurring"}},
    })

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
            "/calendars/primary": {
                "calendars": [{"calendar": {"calendar_id": "feishu.cn_primary_cal@group.calendar.feishu.cn"}}],
            },
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
    free_busy_call = next(call for call in client.calls if call[1].endswith("/freebusy/list"))
    assert free_busy_call[3]["user_id"] == "ou_anish"
    add_attendee_call = next(
        call for call in client.calls if call[0] == "POST" and call[1].endswith("/attendees") and not call[1].endswith("batch_delete")
    )
    assert add_attendee_call[3]["attendees"] == [{"type": "user", "user_id": "ou_anish"}]
    delete_call = next(call for call in client.calls if call[1].endswith("/attendees/batch_delete"))
    assert delete_call[3]["attendee_ids"] == ["att_rahul"]


@pytest.mark.asyncio
async def test_contacts_lookup_uses_user_supported_search():
    client = FakeLarkClient({"/users/search": {"items": [{"open_id": "ou_1", "email": "a@x.com"}]}})
    out = json.loads(registry.dispatch("lark_contacts", {"op": "lookup", "emails": ["a@x.com"]}, client=client))
    assert out["success"] is True
    assert out["data"]["found"][0]["openId"] == "ou_1"
    assert client.calls[0] == (
        "POST",
        "/open-apis/contact/v3/users/search",
        {"page_size": 5},
        {"query": "a@x.com"},
    )


@pytest.mark.asyncio
async def test_contacts_search_and_get_normalize_workspace_users():
    client = FakeLarkClient(
        {
            "/users/search": {
                "items": [
                    {
                        "open_id": "ou_1",
                        "user_id": "u_1",
                        "name": "Abhishek Verma",
                        "email": "abhishek@emiactech.com",
                        "department_ids": ["od_1"],
                        "p2p_chat_id": "oc_1",
                    }
                ]
            },
        }
    )

    searched = json.loads(
        registry.dispatch(
            "lark_contacts",
            {"op": "search", "query": "abhishek", "limit": 5, "excludeExternalUsers": True},
            client=client,
        )
    )
    got = json.loads(registry.dispatch("lark_contacts", {"op": "get", "openIds": ["ou_1"]}, client=client))

    assert searched["success"] is True
    assert searched["data"][0]["openId"] == "ou_1"
    assert searched["data"][0]["p2pChatId"] == "oc_1"
    assert searched["data"][0]["department"] == "od_1"
    assert got["success"] is True
    assert got["data"][0]["displayName"] == "Abhishek Verma"
    assert client.calls[0] == (
        "POST",
        "/open-apis/contact/v3/users/search",
        {"page_size": 5},
        {"query": "abhishek", "filter": {"exclude_external_users": True}},
    )
    assert client.calls[1] == (
        "POST",
        "/open-apis/contact/v3/users/search",
        {"page_size": 1},
        {"filter": {"user_ids": ["ou_1"]}},
    )


@pytest.mark.asyncio
async def test_task_assignee_name_falls_back_to_live_lark_search(monkeypatch):
    monkeypatch.setattr("gateway.company_identity.list_company_users", lambda *, company_id=None: [])
    client = FakeLarkClient(
        {
            "/users/search": {"items": [{"open_id": "ou_live", "name": "Live User", "email": "live@example.com"}]},
            "/tasks": {"task": {"guid": "t1", "summary": "Follow up"}},
        }
    )

    out = json.loads(
        registry.dispatch(
            "lark_task",
            {"op": "create", "title": "Follow up", "assigneeNames": ["Live User"]},
            client=client,
            **_admin_identity_kwargs(),
        )
    )

    assert out["success"] is True
    assert client.calls[0][1] == "/open-apis/contact/v3/users/search"
    assert client.calls[-1][3]["members"] == [{"id": "ou_live", "type": "user", "role": "assignee"}]


@pytest.mark.asyncio
async def test_messaging_send_dm_falls_back_to_live_lark_search(monkeypatch):
    monkeypatch.setattr("gateway.company_identity.list_company_users", lambda *, company_id=None: [])
    client = FakeLarkClient(
        {
            "/users/search": {"items": [{"open_id": "ou_live", "name": "Live User"}]},
            "/messages": {"message_id": "om_123"},
        }
    )

    out = json.loads(
        registry.dispatch(
            "lark_messaging",
            {"op": "send_dm", "recipientName": "Live User", "text": "hello"},
            client=client,
            **_admin_identity_kwargs(),
        )
    )

    assert out["success"] is True
    assert client.calls[0][1] == "/open-apis/contact/v3/users/search"
    assert client.calls[-1][3]["receive_id"] == "ou_live"


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


def test_lark_people_directory_dedupes_same_union_identity(monkeypatch):
    _patch_duplicate_current_user(monkeypatch)

    people = lark_tools._lark_people_directory("comp_1")
    resolved_by_name = lark_tools._resolve_lark_people(
        company_id="comp_1",
        queries=["Abhishek Verma"],
        requester_open_id="beac9a13",
    )
    resolved_by_email = lark_tools._resolve_lark_people(
        company_id="comp_1",
        queries=["abhishek@emiactech.com"],
        requester_open_id="beac9a13",
    )

    assert people == [
        {
            "openId": "ou_abhishek",
            "displayName": "Abhishek Verma",
            "email": "abhishek@emiactech.com",
            "normName": "abhishek verma",
            "tokens": {"abhishek", "verma"},
            "aliases": {"beac9a13", "ou_abhishek", "on_same_union"},
        }
    ]
    assert resolved_by_name["ambiguous"] == []
    assert resolved_by_name["resolved"][0]["openId"] == "ou_abhishek"
    assert resolved_by_email["ambiguous"] == []
    assert resolved_by_email["resolved"][0]["openId"] == "ou_abhishek"


@pytest.mark.asyncio
async def test_task_create_defaults_to_canonical_open_id_for_duplicate_current_user(monkeypatch):
    _patch_duplicate_current_user(monkeypatch)
    client = FakeLarkClient({"/tasks": {"task": {"guid": "t1", "summary": "Do it"}}})

    out = json.loads(
        registry.dispatch(
            "lark_task",
            {"op": "create", "title": "Do it"},
            client=client,
            company_id="comp_1",
            company_user_id="cu_abhishek",
            channel_identity_id="ci_short",
            company_role="ADMIN",
            lark_open_id="beac9a13",
        )
    )

    assert out["success"] is True
    _, _, _, body = client.calls[-1]
    assert body["members"] == [{"id": "ou_abhishek", "type": "user", "role": "assignee"}]


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
async def test_task_update_uses_current_task_v2_body_shape():
    client = FakeLarkClient({"/tasks/t1": {"task": {"guid": "t1", "summary": "Updated"}}})

    out = json.loads(
        registry.dispatch(
            "lark_task",
            {
                "op": "update",
                "taskId": "t1",
                "title": "Updated",
                "notes": "Desc",
                "dueDate": "2026-06-21T18:00:00+05:30",
            },
            client=client,
        )
    )

    assert out["success"] is True
    method, path, params, body = client.calls[-1]
    assert method == "PATCH"
    assert path == "/open-apis/task/v2/tasks/t1"
    assert params == {"user_id_type": "open_id"}
    assert body["task"]["summary"] == "Updated"
    assert body["task"]["description"] == "Desc"
    assert body["task"]["due"]["timestamp"] == "1782045000000"
    assert body["update_fields"] == ["summary", "description", "due"]


@pytest.mark.asyncio
async def test_task_complete_and_reopen_patch_completed_at():
    client = FakeLarkClient({
        "/tasks/t1": {"task": {"guid": "t1", "summary": "Task", "completed_at": "0"}},
    })

    complete = json.loads(registry.dispatch("lark_task", {"op": "complete", "taskId": "t1"}, client=client))
    reopen = json.loads(registry.dispatch("lark_task", {"op": "reopen", "taskId": "t1"}, client=client))

    assert complete["success"] is True
    assert reopen["success"] is True
    complete_body = client.calls[0][3]
    reopen_body = client.calls[1][3]
    assert complete_body["update_fields"] == ["completed_at"]
    assert int(complete_body["task"]["completed_at"]) > 0
    assert reopen_body == {"task": {"completed_at": "0"}, "update_fields": ["completed_at"]}


@pytest.mark.asyncio
async def test_lark_client_treats_non_json_success_as_empty_payload():
    from enterprise.lark_token import LarkClient, LarkStaticTokenProvider

    transport = httpx.MockTransport(lambda _request: httpx.Response(200, text="done"))
    client = LarkClient(
        LarkStaticTokenProvider("u-token"),
        api_base_url="https://open.larksuite.com",
        transport=transport,
    )

    data = await client.request("POST", "/open-apis/task/v2/tasks/t1/complete")

    assert data == {}


@pytest.mark.asyncio
async def test_task_comment_adds_human_visible_tracking_link():
    client = FakeLarkClient({"/comments": {"comment": {"id": "c1"}}})

    out = json.loads(
        registry.dispatch(
            "lark_task",
            {
                "op": "comment",
                "taskId": "t1",
                "content": "Tracking doc: https://tenant.larksuite.com/docx/doc_1",
            },
            client=client,
        )
    )

    assert out["success"] is True
    assert out["taskId"] == "t1"
    assert out["commentId"] == "c1"
    method, path, params, body = client.calls[-1]
    assert method == "POST"
    assert path == "/open-apis/task/v2/comments"
    assert params == {"user_id_type": "open_id"}
    assert body == {
        "resource_id": "t1",
        "resource_type": "task",
        "content": "Tracking doc: https://tenant.larksuite.com/docx/doc_1",
    }


@pytest.mark.asyncio
async def test_task_comment_requires_task_and_content():
    client = FakeLarkClient({})

    no_task = json.loads(registry.dispatch("lark_task", {"op": "comment", "content": "hi"}, client=client))
    no_content = json.loads(registry.dispatch("lark_task", {"op": "comment", "taskId": "t1"}, client=client))

    assert no_task["success"] is False
    assert no_content["success"] is False
    assert client.calls == []


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


@pytest.mark.asyncio
async def test_approval_list_pending_mine_degrades_without_user():
    client = FakeLarkClient({})
    out = json.loads(registry.dispatch("lark_approval", {"op": "listPendingMine"}, client=client))
    assert out["success"] is True
    assert out["data"] == []


@pytest.mark.asyncio
async def test_approval_list_pending_mine_queries_tasks():
    client = FakeLarkClient(
        {
            "/tasks/query": {
                "tasks": [
                    {
                        "instance_code": "ic1",
                        "approval_code": "ac1",
                        "title": "Expense",
                        "status": "PENDING",
                    }
                ]
            }
        }
    )
    out = json.loads(
        registry.dispatch(
            "lark_approval",
            {"op": "listPendingMine", "limit": 5},
            client=client,
            lark_open_id="ou_user_1",
        )
    )
    assert out["success"] is True
    assert out["data"][0]["instanceCode"] == "ic1"
    assert client.calls[-1][1] == "/open-apis/approval/v4/tasks/query"


@pytest.mark.asyncio
async def test_messaging_list_mentions_mine_degrades_on_search_failure():
    class _FailSearchClient(FakeLarkClient):
        async def request(self, method, path, **kwargs):
            if "/search/v1/message" in path:
                raise RuntimeError("search unavailable")
            return await super().request(method, path, **kwargs)

    client = _FailSearchClient({})
    out = json.loads(
        registry.dispatch(
            "lark_messaging",
            {"op": "listMentionsMine"},
            client=client,
            lark_open_id="ou_user_1",
        )
    )
    assert out["success"] is True
    assert out["data"] == []


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
