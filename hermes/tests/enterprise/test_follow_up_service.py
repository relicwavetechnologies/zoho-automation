"""Tests for the Divo Follow Ups service layer."""

from __future__ import annotations

from typing import Any

import pytest

from enterprise.follow_up_repository import FollowUpRepository
from enterprise.follow_ups.service import (
    CompanyIdentityFollowUpResolver,
    CompleteFollowUpRequest,
    CreatedLarkTask,
    CreatedTrackingDoc,
    CreateFollowUpRequest,
    DivoFollowUpsService,
    FollowUpServiceError,
    NativeToolFollowUpLarkGateway,
    PauseFollowUpRequest,
    ReassignFollowUpRequest,
    ResolvedFollowUpUser,
    StartFollowUpRequest,
    UpdateFollowUpDocRequest,
)
from tests.enterprise.follow_up_fixtures import make_follow_up_test_users
from tests.enterprise.test_follow_up_repository import _FakeFollowUpConn


class _FakeIdentityResolver:
    def __init__(self, users: dict[str, ResolvedFollowUpUser]):
        self.users = users
        self.calls: list[dict[str, str | None]] = []

    def resolve_company_user(
        self,
        *,
        company_id: str,
        company_user_id: str | None = None,
        query: str | None = None,
    ) -> ResolvedFollowUpUser:
        self.calls.append(
            {
                "company_id": company_id,
                "company_user_id": company_user_id,
                "query": query,
            }
        )
        key = company_user_id or f"query:{query}"
        if key not in self.users:
            raise FollowUpServiceError(f"missing user: {key}")
        return self.users[key]


class _FakeLarkGateway:
    def __init__(self):
        self.created_tasks: list[dict[str, Any]] = []
        self.created_docs: list[dict[str, Any]] = []
        self.task_comments: list[dict[str, Any]] = []
        self.updated_task_assignees: list[dict[str, Any]] = []
        self.completed_tasks: list[dict[str, Any]] = []
        self.appended_docs: list[dict[str, Any]] = []
        self.sent_dms: list[dict[str, Any]] = []
        self.task_guid = "lark-task-guid-created-001"
        self.doc_token = "doc_token_started_001"

    def create_task(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        assignee: ResolvedFollowUpUser,
        title: str,
        due_date: str,
        notes: str | None = None,
        follower: ResolvedFollowUpUser | None = None,
    ) -> CreatedLarkTask:
        self.created_tasks.append(
            {
                "company_id": company_id,
                "requester": requester,
                "assignee": assignee,
                "title": title,
                "due_date": due_date,
                "notes": notes,
                "follower": follower,
            }
        )
        return CreatedLarkTask(
            task_guid=self.task_guid,
            title=title,
            url=f"https://tenant.larksuite.com/client/todo/task?guid={self.task_guid}",
        )

    def send_dm(
        self,
        *,
        company_id: str,
        sender: ResolvedFollowUpUser,
        recipient: ResolvedFollowUpUser,
        text: str,
    ) -> str:
        self.sent_dms.append(
            {
                "company_id": company_id,
                "sender": sender,
                "recipient": recipient,
                "text": text,
            }
        )
        return "om_manager"

    def create_tracking_doc(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        title: str,
        markdown: str,
    ) -> CreatedTrackingDoc:
        self.created_docs.append(
            {
                "company_id": company_id,
                "requester": requester,
                "title": title,
                "markdown": markdown,
            }
        )
        return CreatedTrackingDoc(
            doc_token=self.doc_token,
            title=title,
            url=f"https://tenant.larksuite.com/docx/{self.doc_token}",
        )

    def add_task_comment(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        task_guid: str,
        content: str,
    ) -> str:
        self.task_comments.append(
            {
                "company_id": company_id,
                "requester": requester,
                "task_guid": task_guid,
                "content": content,
            }
        )
        return "comment_started_001"

    def update_task_assignee(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        task_guid: str,
        assignee: ResolvedFollowUpUser,
    ) -> None:
        self.updated_task_assignees.append(
            {
                "company_id": company_id,
                "requester": requester,
                "task_guid": task_guid,
                "assignee": assignee,
            }
        )

    def complete_task(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        task_guid: str,
    ) -> None:
        self.completed_tasks.append(
            {
                "company_id": company_id,
                "requester": requester,
                "task_guid": task_guid,
            }
        )

    def append_tracking_doc(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        doc_token: str,
        markdown: str,
    ) -> None:
        self.appended_docs.append(
            {
                "company_id": company_id,
                "requester": requester,
                "doc_token": doc_token,
                "markdown": markdown,
            }
        )


def _service():
    users = make_follow_up_test_users()
    conn = _FakeFollowUpConn()
    repo = FollowUpRepository(conn)
    manager = ResolvedFollowUpUser(
        company_user_id=users.manager_company_user_id,
        lark_open_id="ou_abhishek",
        display_name="Abhishek Verma",
        email="abhishek@emiactech.com",
    )
    assignee = ResolvedFollowUpUser(
        company_user_id=users.assignee_company_user_id,
        lark_open_id="ou_anish",
        display_name="Anish Suman",
        email="anish@emiactech.com",
    )
    new_assignee = ResolvedFollowUpUser(
        company_user_id="cu_suman",
        lark_open_id="ou_suman",
        display_name="Suman Rao",
        email="suman@emiactech.com",
    )
    identity = _FakeIdentityResolver(
        {
            users.manager_company_user_id: manager,
            users.assignee_company_user_id: assignee,
            "query:Anish sir": assignee,
            "cu_suman": new_assignee,
            "query:Suman": new_assignee,
        }
    )
    gateway = _FakeLarkGateway()
    return users, conn, DivoFollowUpsService(
        repository=repo,
        identity_resolver=identity,
        lark_gateway=gateway,
    ), identity, gateway


def test_create_follow_up_creates_lark_task_and_persists_control_row():
    users, conn, service, identity, gateway = _service()

    result = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title=" Prepare Q3 enterprise rollout brief ",
            due_date="2026-06-18T12:30:00Z",
            notes="Use the source chat as reference.",
            source_session_id="session-manager-create-001",
            follow_up_policy_json={"notify_on_pause": False},
        )
    )

    assert result.follow_up.status == "assigned"
    assert result.follow_up.lark_task_guid == "lark-task-guid-created-001"
    assert result.follow_up.delegator_company_user_id == users.manager_company_user_id
    assert result.follow_up.assignee_company_user_id == users.assignee_company_user_id
    assert result.follow_up.source_session_id == "session-manager-create-001"
    assert result.follow_up.follow_up_policy_json["notify_on_start"] is True
    assert result.follow_up.follow_up_policy_json["notify_on_pause"] is False
    assert result.lark_task.url == "https://tenant.larksuite.com/client/todo/task?guid=lark-task-guid-created-001"

    assert gateway.created_tasks == [
        {
            "company_id": users.company_id,
            "requester": result.delegator,
            "assignee": result.assignee,
            "title": "Prepare Q3 enterprise rollout brief",
            "due_date": "2026-06-18T12:30:00Z",
            "notes": "Use the source chat as reference.",
            "follower": result.delegator,
        }
    ]
    assert identity.calls == [
        {
            "company_id": users.company_id,
            "company_user_id": users.manager_company_user_id,
            "query": None,
        },
        {
            "company_id": users.company_id,
            "company_user_id": users.assignee_company_user_id,
            "query": None,
        },
    ]
    assert len(conn.events) == 1
    assert conn.events[0]["eventType"] == "created"
    assert conn.events[0]["actorCompanyUserId"] == users.manager_company_user_id
    assert conn.events[0]["payloadJson"]["lark_task_guid"] == "lark-task-guid-created-001"
    assert conn.events[0]["payloadJson"]["assignee_lark_open_id"] == "ou_anish"


def test_create_follow_up_can_resolve_assignee_by_query():
    users, _conn, service, identity, _gateway = _service()

    result = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_query="Anish sir",
            title="Review rollout brief",
            due_date="2026-06-18T12:30:00Z",
        )
    )

    assert result.assignee.company_user_id == users.assignee_company_user_id
    assert identity.calls[-1] == {
        "company_id": users.company_id,
        "company_user_id": None,
        "query": "Anish sir",
    }


@pytest.mark.parametrize(
    ("create_request", "message"),
    [
        (
            CreateFollowUpRequest(
                company_id="",
                delegator_company_user_id="cu_manager",
                assignee_company_user_id="cu_assignee",
                title="Task",
                due_date="2026-06-18T12:30:00Z",
            ),
            "company_id is required",
        ),
        (
            CreateFollowUpRequest(
                company_id="co_1",
                delegator_company_user_id="cu_manager",
                assignee_company_user_id="cu_assignee",
                title=" ",
                due_date="2026-06-18T12:30:00Z",
            ),
            "title is required",
        ),
        (
            CreateFollowUpRequest(
                company_id="co_1",
                delegator_company_user_id="cu_manager",
                assignee_company_user_id="cu_assignee",
                title="Task",
                due_date="",
            ),
            "due_date is required",
        ),
        (
            CreateFollowUpRequest(
                company_id="co_1",
                delegator_company_user_id="cu_manager",
                title="Task",
                due_date="2026-06-18T12:30:00Z",
            ),
            "assignee_company_user_id or assignee_query is required",
        ),
    ],
)
def test_create_follow_up_validates_required_fields(create_request, message):
    _users, _conn, service, identity, gateway = _service()

    with pytest.raises(FollowUpServiceError, match=message):
        service.create_follow_up(create_request)

    assert identity.calls == []
    assert gateway.created_tasks == []


def test_create_follow_up_fails_when_lark_does_not_return_task_guid():
    users, _conn, service, _identity, gateway = _service()
    gateway.task_guid = ""

    with pytest.raises(FollowUpServiceError, match="task guid"):
        service.create_follow_up(
            CreateFollowUpRequest(
                company_id=users.company_id,
                delegator_company_user_id=users.manager_company_user_id,
                assignee_company_user_id=users.assignee_company_user_id,
                title="Prepare Q3 brief",
                due_date="2026-06-18T12:30:00Z",
            )
        )


def test_notify_manager_sends_dm_from_actor_to_manager():
    users, _conn, service, _identity, gateway = _service()

    message_id = service.notify_manager(
        company_id=users.company_id,
        manager_company_user_id=users.manager_company_user_id,
        actor_company_user_id=users.assignee_company_user_id,
        text="Anish started Prepare Q3 enterprise rollout brief.",
    )

    assert message_id == "om_manager"
    assert gateway.sent_dms == [
        {
            "company_id": users.company_id,
            "sender": ResolvedFollowUpUser(
                company_user_id=users.assignee_company_user_id,
                lark_open_id="ou_anish",
                display_name="Anish Suman",
                email="anish@emiactech.com",
            ),
            "recipient": ResolvedFollowUpUser(
                company_user_id=users.manager_company_user_id,
                lark_open_id="ou_abhishek",
                display_name="Abhishek Verma",
                email="abhishek@emiactech.com",
            ),
            "text": "Anish started Prepare Q3 enterprise rollout brief.",
        }
    ]


def test_start_follow_up_creates_doc_links_task_and_notifies_manager():
    users, conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
            notes="Use the source chat as reference.",
        )
    )

    result = service.start_follow_up(
        StartFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            active_session_id="session-active-001",
        )
    )

    assert result.follow_up.status == "active"
    assert result.follow_up.started_at == "started"
    assert result.follow_up.active_session_id == "session-active-001"
    assert result.follow_up.tracking_doc_token == "doc_token_started_001"
    assert result.follow_up.tracking_doc_url == "https://tenant.larksuite.com/docx/doc_token_started_001"
    assert result.tracking_doc == CreatedTrackingDoc(
        doc_token="doc_token_started_001",
        title="Divo Follow Up - Prepare Q3 enterprise rollout brief",
        url="https://tenant.larksuite.com/docx/doc_token_started_001",
    )
    assert result.manager_message_id == "om_manager"

    assert len(gateway.created_docs) == 1
    created_doc = gateway.created_docs[0]
    assert created_doc["requester"] == created.assignee
    assert created_doc["title"] == "Divo Follow Up - Prepare Q3 enterprise rollout brief"
    assert "## Task Brief" in created_doc["markdown"]
    assert "- Manager: Abhishek Verma" in created_doc["markdown"]
    assert "- Assignee: Anish Suman" in created_doc["markdown"]
    assert "- Due: 2026-06-18T12:30:00Z" in created_doc["markdown"]
    assert "- Lark Task: lark-task-guid-created-001" in created_doc["markdown"]

    assert gateway.task_comments == [
        {
            "company_id": users.company_id,
            "requester": created.assignee,
            "task_guid": "lark-task-guid-created-001",
            "content": "Divo tracking doc: https://tenant.larksuite.com/docx/doc_token_started_001",
        }
    ]
    assert gateway.sent_dms[-1]["sender"] == created.assignee
    assert gateway.sent_dms[-1]["recipient"] == created.delegator
    assert "Anish Suman has started: Prepare Q3 enterprise rollout brief" in gateway.sent_dms[-1]["text"]
    assert "Tracking doc: https://tenant.larksuite.com/docx/doc_token_started_001" in gateway.sent_dms[-1]["text"]

    assert [event["eventType"] for event in conn.events] == [
        "created",
        "status_changed",
        "status_changed",
        "started",
    ]
    assert conn.events[-1]["payloadJson"]["tracking_doc_token"] == "doc_token_started_001"
    assert conn.events[-1]["payloadJson"]["task_comment_id"] == "comment_started_001"


def test_start_follow_up_respects_notify_on_start_policy():
    users, _conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
            follow_up_policy_json={"notify_on_start": False},
        )
    )

    result = service.start_follow_up(
        StartFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            active_session_id="session-active-001",
        )
    )

    assert result.follow_up.status == "active"
    assert result.manager_message_id is None
    assert gateway.sent_dms == []


def test_start_follow_up_requires_assignee_actor():
    users, _conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
        )
    )

    with pytest.raises(FollowUpServiceError, match="Only the assignee"):
        service.start_follow_up(
            StartFollowUpRequest(
                company_id=users.company_id,
                follow_up_id=created.follow_up.id,
                actor_company_user_id=users.manager_company_user_id,
                active_session_id="session-active-001",
            )
        )

    assert gateway.created_docs == []
    assert gateway.task_comments == []


def test_pause_follow_up_moves_active_to_paused_and_notifies_manager():
    users, _conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
        )
    )
    service.start_follow_up(
        StartFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            active_session_id="session-active-001",
        )
    )
    gateway.sent_dms.clear()

    result = service.pause_follow_up(
        PauseFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            reason="Waiting for source inputs",
        )
    )

    assert result.follow_up.status == "paused"
    assert result.follow_up.paused_at == "paused"
    assert result.manager_message_id == "om_manager"
    assert gateway.sent_dms == [
        {
            "company_id": users.company_id,
            "sender": created.assignee,
            "recipient": created.delegator,
            "text": (
                "Anish Suman paused: Prepare Q3 enterprise rollout brief\n"
                "Reason: Waiting for source inputs"
            ),
        }
    ]


def test_assigned_active_paused_active_done_flow_reuses_tracking_doc():
    users, conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
        )
    )
    started = service.start_follow_up(
        StartFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            active_session_id="session-active-001",
        )
    )
    service.pause_follow_up(
        PauseFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            reason="Waiting for source inputs",
        )
    )
    gateway.created_docs.clear()
    gateway.task_comments.clear()
    gateway.sent_dms.clear()

    resumed = service.start_follow_up(
        StartFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            active_session_id="session-active-002",
        )
    )

    assert resumed.follow_up.status == "active"
    assert resumed.follow_up.active_session_id == "session-active-002"
    assert resumed.follow_up.tracking_doc_token == started.follow_up.tracking_doc_token
    assert resumed.tracking_doc == CreatedTrackingDoc(
        doc_token="doc_token_started_001",
        title="Divo Follow Up - Prepare Q3 enterprise rollout brief",
        url="https://tenant.larksuite.com/docx/doc_token_started_001",
    )
    assert gateway.created_docs == []
    assert gateway.task_comments == []
    assert gateway.sent_dms[-1]["text"].startswith("Anish Suman resumed: Prepare Q3 enterprise rollout brief")
    assert conn.events[-1]["eventType"] == "started"
    assert conn.events[-1]["payloadJson"]["resumed"] is True

    gateway.sent_dms.clear()
    done = service.complete_follow_up(
        CompleteFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            summary="Finished after resuming the work.",
        )
    )

    assert done.follow_up.status == "done"
    assert done.follow_up.summary == "Finished after resuming the work."
    assert gateway.completed_tasks[-1]["task_guid"] == "lark-task-guid-created-001"
    assert gateway.sent_dms[-1]["text"].startswith("Anish Suman completed: Prepare Q3 enterprise rollout brief")
    assert [event["eventType"] for event in conn.events] == [
        "created",
        "status_changed",
        "status_changed",
        "started",
        "status_changed",
        "paused",
        "status_changed",
        "started",
        "status_changed",
        "done",
    ]


def test_reassign_follow_up_updates_lark_task_and_control_row():
    users, conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
        )
    )

    result = service.reassign_follow_up(
        ReassignFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.manager_company_user_id,
            new_assignee_query="Suman",
        )
    )

    assert result.follow_up.status == "assigned"
    assert result.follow_up.assignee_company_user_id == "cu_suman"
    assert gateway.updated_task_assignees == [
        {
            "company_id": users.company_id,
            "requester": created.delegator,
            "task_guid": "lark-task-guid-created-001",
            "assignee": ResolvedFollowUpUser(
                company_user_id="cu_suman",
                lark_open_id="ou_suman",
                display_name="Suman Rao",
                email="suman@emiactech.com",
            ),
        }
    ]
    assert [event["eventType"] for event in conn.events] == [
        "created",
        "status_changed",
        "status_changed",
        "reassigned",
    ]
    assert conn.events[-1]["payloadJson"]["to_assignee_lark_open_id"] == "ou_suman"


def test_reassign_follow_up_requires_manager_actor():
    users, _conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
        )
    )

    with pytest.raises(FollowUpServiceError, match="Only the manager"):
        service.reassign_follow_up(
            ReassignFollowUpRequest(
                company_id=users.company_id,
                follow_up_id=created.follow_up.id,
                actor_company_user_id=users.assignee_company_user_id,
                new_assignee_query="Suman",
            )
        )

    assert gateway.updated_task_assignees == []


def test_complete_follow_up_requires_summary():
    _users, _conn, service, _identity, _gateway = _service()

    with pytest.raises(FollowUpServiceError, match="completion summary is required"):
        service.prepare_done_summary("   ")


def test_update_tracking_doc_checkpoint_appends_progress_note():
    users, conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
        )
    )
    service.start_follow_up(
        StartFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            active_session_id="session-active-001",
        )
    )
    gateway.appended_docs.clear()

    result = service.update_tracking_doc_checkpoint(
        UpdateFollowUpDocRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            note=" Drafted the renewal points and waiting on finance numbers. ",
        )
    )

    assert result.follow_up.status == "active"
    assert result.follow_up.last_doc_append_at == "doc-appended"
    assert gateway.appended_docs == [
        {
            "company_id": users.company_id,
            "requester": created.assignee,
            "doc_token": "doc_token_started_001",
            "markdown": "## Progress Update\n\nDrafted the renewal points and waiting on finance numbers.\n",
        }
    ]
    assert conn.events[-1]["eventType"] == "doc_updated"
    assert conn.events[-1]["actorCompanyUserId"] == users.assignee_company_user_id
    assert conn.events[-1]["payloadJson"]["note"] == (
        "Drafted the renewal points and waiting on finance numbers."
    )


def test_update_tracking_doc_checkpoint_requires_active_assignee_with_doc():
    users, _conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
        )
    )

    with pytest.raises(FollowUpServiceError, match="Cannot update tracking doc"):
        service.update_tracking_doc_checkpoint(
            UpdateFollowUpDocRequest(
                company_id=users.company_id,
                follow_up_id=created.follow_up.id,
                actor_company_user_id=users.assignee_company_user_id,
                note="Drafted first pass.",
            )
        )

    service.start_follow_up(
        StartFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            active_session_id="session-active-001",
        )
    )
    with pytest.raises(FollowUpServiceError, match="Only the assignee"):
        service.update_tracking_doc_checkpoint(
            UpdateFollowUpDocRequest(
                company_id=users.company_id,
                follow_up_id=created.follow_up.id,
                actor_company_user_id=users.manager_company_user_id,
                note="Drafted first pass.",
            )
        )
    with pytest.raises(FollowUpServiceError, match="progress note is required"):
        service.update_tracking_doc_checkpoint(
            UpdateFollowUpDocRequest(
                company_id=users.company_id,
                follow_up_id=created.follow_up.id,
                actor_company_user_id=users.assignee_company_user_id,
                note="   ",
            )
        )

    assert gateway.appended_docs == []


def test_complete_follow_up_appends_summary_completes_task_and_notifies_manager():
    users, conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
        )
    )
    started = service.start_follow_up(
        StartFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            active_session_id="session-active-001",
        )
    )
    assert started.follow_up.status == "active"
    gateway.sent_dms.clear()

    result = service.complete_follow_up(
        CompleteFollowUpRequest(
            company_id=users.company_id,
            follow_up_id=created.follow_up.id,
            actor_company_user_id=users.assignee_company_user_id,
            summary=" Completed the rollout brief and added the key risks. ",
        )
    )

    assert result.follow_up.status == "done"
    assert result.follow_up.completed_at == "completed"
    assert result.follow_up.summary == "Completed the rollout brief and added the key risks."
    assert result.follow_up.last_doc_append_at == "doc-appended"
    assert result.manager_message_id == "om_manager"
    assert gateway.appended_docs == [
        {
            "company_id": users.company_id,
            "requester": created.assignee,
            "doc_token": "doc_token_started_001",
            "markdown": "## Final Summary\n\nCompleted the rollout brief and added the key risks.\n",
        }
    ]
    assert gateway.completed_tasks == [
        {
            "company_id": users.company_id,
            "requester": created.assignee,
            "task_guid": "lark-task-guid-created-001",
        }
    ]
    assert "Anish Suman completed: Prepare Q3 enterprise rollout brief" in gateway.sent_dms[-1]["text"]
    assert "Summary: Completed the rollout brief and added the key risks." in gateway.sent_dms[-1]["text"]
    assert "Tracking doc: https://tenant.larksuite.com/docx/doc_token_started_001" in gateway.sent_dms[-1]["text"]
    assert [event["eventType"] for event in conn.events][-2:] == ["status_changed", "done"]


def test_complete_follow_up_requires_assignee_actor():
    users, _conn, service, _identity, gateway = _service()
    created = service.create_follow_up(
        CreateFollowUpRequest(
            company_id=users.company_id,
            delegator_company_user_id=users.manager_company_user_id,
            assignee_company_user_id=users.assignee_company_user_id,
            title="Prepare Q3 enterprise rollout brief",
            due_date="2026-06-18T12:30:00Z",
        )
    )

    with pytest.raises(FollowUpServiceError, match="Only the assignee"):
        service.complete_follow_up(
            CompleteFollowUpRequest(
                company_id=users.company_id,
                follow_up_id=created.follow_up.id,
                actor_company_user_id=users.manager_company_user_id,
                summary="Finished it.",
            )
        )

    assert gateway.completed_tasks == []


def test_company_identity_resolver_resolves_query_and_strips_titles(monkeypatch):
    users = make_follow_up_test_users()

    def fake_users(*, company_id=None):
        assert company_id == users.company_id
        return [
            {
                "id": users.manager_company_user_id,
                "display_name": "Abhishek Verma",
                "email": "abhishek@emiactech.com",
            },
            {
                "id": users.assignee_company_user_id,
                "display_name": "Anish Suman",
                "email": "anish@emiactech.com",
            },
        ]

    def fake_identities(company_user_id):
        assert company_user_id == users.assignee_company_user_id
        return [
            {
                "platform": "lark",
                "platform_user_id": "ou_anish",
                "display_name": "Anish Suman",
            }
        ]

    monkeypatch.setattr("gateway.company_identity.list_company_users", fake_users)
    monkeypatch.setattr("gateway.company_identity.list_channel_identities_for_company_user", fake_identities)

    resolved = CompanyIdentityFollowUpResolver().resolve_company_user(
        company_id=users.company_id,
        query="Anish sir",
    )

    assert resolved == ResolvedFollowUpUser(
        company_user_id=users.assignee_company_user_id,
        lark_open_id="ou_anish",
        display_name="Anish Suman",
        email="anish@emiactech.com",
    )


def test_company_identity_resolver_reports_ambiguous_query(monkeypatch):
    users = make_follow_up_test_users()

    def fake_users(*, company_id=None):
        assert company_id == users.company_id
        return [
            {"id": "cu_1", "display_name": "Anish Suman"},
            {"id": "cu_2", "display_name": "Anish Sharma"},
        ]

    monkeypatch.setattr("gateway.company_identity.list_company_users", fake_users)

    with pytest.raises(FollowUpServiceError, match="Ambiguous assignee"):
        CompanyIdentityFollowUpResolver().resolve_company_user(
            company_id=users.company_id,
            query="Anish",
        )


def test_native_lark_gateway_maps_create_task_to_lark_tool(monkeypatch):
    calls: list[dict[str, Any]] = []

    def fake_dispatch(name, args, **kwargs):
        calls.append({"name": name, "args": args, "kwargs": kwargs})
        return {
            "success": True,
            "taskId": "task_guid_1",
            "data": {"title": "Prepare Q3 brief"},
        }

    monkeypatch.setattr("enterprise.follow_ups.service._dispatch_lark_tool", fake_dispatch)

    gateway = NativeToolFollowUpLarkGateway()
    task = gateway.create_task(
        company_id="co_1",
        requester=ResolvedFollowUpUser("cu_manager", "ou_manager", "Manager"),
        assignee=ResolvedFollowUpUser("cu_assignee", "ou_assignee", "Assignee"),
        follower=ResolvedFollowUpUser("cu_manager", "ou_manager", "Manager"),
        title="Prepare Q3 brief",
        due_date="2026-06-18T12:30:00Z",
        notes="Use source context.",
    )

    assert task == CreatedLarkTask(task_guid="task_guid_1", title="Prepare Q3 brief", url=None)
    assert calls == [
        {
            "name": "lark_task",
            "args": {
                "op": "create",
                "title": "Prepare Q3 brief",
                "dueDate": "2026-06-18T12:30:00Z",
                "assigneeIds": ["ou_assignee"],
                "notes": "Use source context.",
                "followerIds": ["ou_manager"],
            },
            "kwargs": {
                "company_id": "co_1",
                "company_user_id": "cu_manager",
                "lark_open_id": "ou_manager",
            },
        }
    ]


def test_native_lark_gateway_maps_manager_dm_to_lark_tool(monkeypatch):
    calls: list[dict[str, Any]] = []

    def fake_dispatch(name, args, **kwargs):
        calls.append({"name": name, "args": args, "kwargs": kwargs})
        return {"success": True, "messageId": "om_1"}

    monkeypatch.setattr("enterprise.follow_ups.service._dispatch_lark_tool", fake_dispatch)

    message_id = NativeToolFollowUpLarkGateway().send_dm(
        company_id="co_1",
        sender=ResolvedFollowUpUser("cu_assignee", "ou_assignee", "Assignee"),
        recipient=ResolvedFollowUpUser("cu_manager", "ou_manager", "Manager"),
        text="Started the task.",
    )

    assert message_id == "om_1"
    assert calls == [
        {
            "name": "lark_messaging",
            "args": {
                "op": "send_dm",
                "receiveId": "ou_manager",
                "text": "Started the task.",
            },
            "kwargs": {
                "company_id": "co_1",
                "company_user_id": "cu_assignee",
                "lark_open_id": "ou_assignee",
            },
        }
    ]


def test_native_lark_gateway_maps_tracking_doc_create_to_lark_tool(monkeypatch):
    calls: list[dict[str, Any]] = []

    def fake_dispatch(name, args, **kwargs):
        calls.append({"name": name, "args": args, "kwargs": kwargs})
        return {
            "success": True,
            "docToken": "doc_1",
            "docUrl": "https://tenant.larksuite.com/docx/doc_1",
        }

    monkeypatch.setattr("enterprise.follow_ups.service._dispatch_lark_tool", fake_dispatch)

    doc = NativeToolFollowUpLarkGateway().create_tracking_doc(
        company_id="co_1",
        requester=ResolvedFollowUpUser("cu_assignee", "ou_assignee", "Assignee"),
        title="Divo Follow Up - Prepare Q3 brief",
        markdown="# Divo Follow Up\n\nBody",
    )

    assert doc == CreatedTrackingDoc(
        doc_token="doc_1",
        title="Divo Follow Up - Prepare Q3 brief",
        url="https://tenant.larksuite.com/docx/doc_1",
    )
    assert calls == [
        {
            "name": "lark_doc",
            "args": {
                "op": "create_markdown",
                "title": "Divo Follow Up - Prepare Q3 brief",
                "markdown": "# Divo Follow Up\n\nBody",
            },
            "kwargs": {
                "company_id": "co_1",
                "company_user_id": "cu_assignee",
                "lark_open_id": "ou_assignee",
            },
        }
    ]


def test_native_lark_gateway_maps_task_comment_to_lark_tool(monkeypatch):
    calls: list[dict[str, Any]] = []

    def fake_dispatch(name, args, **kwargs):
        calls.append({"name": name, "args": args, "kwargs": kwargs})
        return {"success": True, "commentId": "comment_1"}

    monkeypatch.setattr("enterprise.follow_ups.service._dispatch_lark_tool", fake_dispatch)

    comment_id = NativeToolFollowUpLarkGateway().add_task_comment(
        company_id="co_1",
        requester=ResolvedFollowUpUser("cu_assignee", "ou_assignee", "Assignee"),
        task_guid="task_guid_1",
        content="Divo tracking doc: https://tenant.larksuite.com/docx/doc_1",
    )

    assert comment_id == "comment_1"
    assert calls == [
        {
            "name": "lark_task",
            "args": {
                "op": "comment",
                "taskId": "task_guid_1",
                "content": "Divo tracking doc: https://tenant.larksuite.com/docx/doc_1",
            },
            "kwargs": {
                "company_id": "co_1",
                "company_user_id": "cu_assignee",
                "lark_open_id": "ou_assignee",
            },
        }
    ]


def test_native_lark_gateway_maps_reassign_complete_and_doc_append(monkeypatch):
    calls: list[dict[str, Any]] = []

    def fake_dispatch(name, args, **kwargs):
        calls.append({"name": name, "args": args, "kwargs": kwargs})
        return {"success": True}

    monkeypatch.setattr("enterprise.follow_ups.service._dispatch_lark_tool", fake_dispatch)

    gateway = NativeToolFollowUpLarkGateway()
    requester = ResolvedFollowUpUser("cu_manager", "ou_manager", "Manager")
    assignee = ResolvedFollowUpUser("cu_assignee", "ou_assignee", "Assignee")
    gateway.update_task_assignee(
        company_id="co_1",
        requester=requester,
        task_guid="task_guid_1",
        assignee=assignee,
    )
    gateway.complete_task(
        company_id="co_1",
        requester=assignee,
        task_guid="task_guid_1",
    )
    gateway.append_tracking_doc(
        company_id="co_1",
        requester=assignee,
        doc_token="doc_1",
        markdown="## Final Summary\n\nDone.",
    )

    assert calls == [
        {
            "name": "lark_task",
            "args": {
                "op": "update",
                "taskId": "task_guid_1",
                "assigneeIds": ["ou_assignee"],
            },
            "kwargs": {
                "company_id": "co_1",
                "company_user_id": "cu_manager",
                "lark_open_id": "ou_manager",
            },
        },
        {
            "name": "lark_task",
            "args": {
                "op": "complete",
                "taskId": "task_guid_1",
            },
            "kwargs": {
                "company_id": "co_1",
                "company_user_id": "cu_assignee",
                "lark_open_id": "ou_assignee",
            },
        },
        {
            "name": "lark_doc",
            "args": {
                "op": "append_markdown",
                "docToken": "doc_1",
                "markdown": "## Final Summary\n\nDone.",
            },
            "kwargs": {
                "company_id": "co_1",
                "company_user_id": "cu_assignee",
                "lark_open_id": "ou_assignee",
            },
        },
    ]
