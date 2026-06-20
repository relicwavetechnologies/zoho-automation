"""Tests for the Postgres-backed Divo Follow Ups repository."""

from __future__ import annotations

import json
from typing import Any

import pytest

from enterprise.follow_up_repository import FollowUpRepository
from enterprise.follow_ups.lifecycle import FollowUpLifecycleError, validate_transition
from tests.enterprise.follow_up_fixtures import make_follow_up_test_users, make_sample_follow_up_kwargs


class _Cursor:
    def __init__(self, rows: list[dict[str, Any]] | None = None):
        self._rows = rows or []

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def close(self):
        return None


class _FakeFollowUpConn:
    """Minimal row store that understands FollowUpRepository statements."""

    def __init__(self):
        self.follow_ups: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self._seq = 0

    def execute(self, sql: str, args: tuple[Any, ...]):
        s = " ".join(sql.split())

        if s.startswith('INSERT INTO "HermesFollowUp"'):
            (
                follow_up_id,
                company_id,
                lark_task_guid,
                delegator_company_user_id,
                assignee_company_user_id,
                source_session_id,
                active_session_id,
                tracking_doc_token,
                tracking_doc_url,
                status,
                policy_json,
            ) = args
            self._seq += 1
            self.follow_ups[follow_up_id] = {
                "id": follow_up_id,
                "companyId": company_id,
                "larkTaskGuid": lark_task_guid,
                "delegatorCompanyUserId": delegator_company_user_id,
                "assigneeCompanyUserId": assignee_company_user_id,
                "sourceSessionId": source_session_id,
                "activeSessionId": active_session_id,
                "trackingDocToken": tracking_doc_token,
                "trackingDocUrl": tracking_doc_url,
                "status": status,
                "followUpPolicyJson": json.loads(policy_json),
                "startedAt": None,
                "pausedAt": None,
                "completedAt": None,
                "summary": None,
                "lastDocAppendAt": None,
                "createdAt": f"ts-{self._seq}",
                "updatedAt": f"ts-{self._seq}",
                "seq": self._seq,
            }
            return _Cursor([])

        if s.startswith('UPDATE "HermesFollowUp"'):
            if '"lastDocAppendAt" = now()' in s and '"summary" = %s' not in s:
                company_id, follow_up_id = args
                row = self._find_follow_up(company_id, follow_up_id)
                if row is None:
                    return _Cursor([])
                row["lastDocAppendAt"] = "doc-appended"
                row["updatedAt"] = "updated"
                return _Cursor([])

            if '"assigneeCompanyUserId" = %s' in s:
                assignee_company_user_id, company_id, follow_up_id = args
                row = self._find_follow_up(company_id, follow_up_id)
                if row is None:
                    return _Cursor([])
                row["assigneeCompanyUserId"] = assignee_company_user_id
                row["updatedAt"] = "updated"
                return _Cursor([])

            if '"summary" = %s' in s:
                summary, company_id, follow_up_id = args
                row = self._find_follow_up(company_id, follow_up_id)
                if row is None:
                    return _Cursor([])
                row["summary"] = summary
                row["updatedAt"] = "updated"
                if '"lastDocAppendAt" = now()' in s:
                    row["lastDocAppendAt"] = "doc-appended"
                return _Cursor([])

            if '"trackingDocToken" = %s' in s:
                (
                    active_session_id,
                    tracking_doc_token,
                    tracking_doc_url,
                    company_id,
                    follow_up_id,
                ) = args
                row = self._find_follow_up(company_id, follow_up_id)
                if row is None:
                    return _Cursor([])
                row["activeSessionId"] = active_session_id
                row["trackingDocToken"] = tracking_doc_token
                row["trackingDocUrl"] = tracking_doc_url
                row["updatedAt"] = "updated"
                return _Cursor([])

            target_status, company_id, follow_up_id = args
            row = self._find_follow_up(company_id, follow_up_id)
            if row is None:
                return _Cursor([])
            row["status"] = target_status
            row["updatedAt"] = "updated"
            if '"startedAt" = COALESCE("startedAt", now())' in s:
                row["startedAt"] = row["startedAt"] or "started"
            if '"pausedAt" = now()' in s:
                row["pausedAt"] = "paused"
            if '"completedAt" = now()' in s:
                row["completedAt"] = "completed"
            return _Cursor([])

        if s.startswith('INSERT INTO "HermesFollowUpEvent"'):
            event_id, follow_up_id, event_type, actor_company_user_id, payload_json = args
            self.events.append(
                {
                    "id": event_id,
                    "followUpId": follow_up_id,
                    "eventType": event_type,
                    "actorCompanyUserId": actor_company_user_id,
                    "payloadJson": json.loads(payload_json),
                    "createdAt": f"event-{len(self.events) + 1}",
                }
            )
            return _Cursor([])

        if 'FROM "HermesFollowUp"' in s and 'WHERE "companyId" = %s AND "id" = %s' in s:
            company_id, follow_up_id = args
            row = self._find_follow_up(company_id, follow_up_id)
            return _Cursor([row] if row else [])

        if (
            'FROM "HermesFollowUp"' in s
            and '"delegatorCompanyUserId" = %s' in s
            and '"assigneeCompanyUserId" = %s' in s
            and '"status" <> \'deleted\'' in s
        ):
            company_id, company_user_id, company_user_id_again = args
            assert company_user_id_again == company_user_id
            rows = [
                row
                for row in self.follow_ups.values()
                if row["companyId"] == company_id
                and row["status"] != "deleted"
                and (
                    row["assigneeCompanyUserId"] == company_user_id
                    or row["delegatorCompanyUserId"] == company_user_id
                )
            ]
            rows.sort(key=lambda row: row["seq"], reverse=True)
            return _Cursor(rows)

        if (
            'FROM "HermesFollowUp"' in s
            and '"assigneeCompanyUserId" = %s' in s
            and '"status" <> \'deleted\'' in s
        ):
            company_id, assignee_company_user_id = args
            rows = [
                row
                for row in self.follow_ups.values()
                if row["companyId"] == company_id
                and row["assigneeCompanyUserId"] == assignee_company_user_id
                and row["status"] != "deleted"
            ]
            rows.sort(key=lambda row: row["seq"], reverse=True)
            return _Cursor(rows)

        if (
            'FROM "HermesFollowUp"' in s
            and '"status" = \'active\'' in s
            and '"assigneeCompanyUserId" = %s' in s
        ):
            company_id, assignee_company_user_id = args
            rows = [
                row
                for row in self.follow_ups.values()
                if row["companyId"] == company_id
                and row["assigneeCompanyUserId"] == assignee_company_user_id
                and row["status"] == "active"
            ]
            rows.sort(key=lambda row: row["seq"], reverse=True)
            return _Cursor(rows)

        if 'FROM "HermesFollowUp"' in s and '"status" = \'active\'' in s and len(args) == 1:
            (company_id,) = args
            rows = [
                row
                for row in self.follow_ups.values()
                if row["companyId"] == company_id and row["status"] == "active"
            ]
            rows.sort(key=lambda row: row["seq"], reverse=True)
            return _Cursor(rows)

        if 'FROM "HermesFollowUpEvent" e' in s:
            company_id, follow_up_id = args
            rows = [
                event
                for event in self.events
                if event["followUpId"] == follow_up_id
                and self.follow_ups.get(follow_up_id, {}).get("companyId") == company_id
            ]
            return _Cursor(rows)

        raise AssertionError(f"Unhandled SQL: {s[:160]}")

    def _find_follow_up(self, company_id: str, follow_up_id: str) -> dict[str, Any] | None:
        row = self.follow_ups.get(follow_up_id)
        if row is None or row["companyId"] != company_id:
            return None
        return row


def _repo():
    conn = _FakeFollowUpConn()
    return FollowUpRepository(conn), conn


def test_create_follow_up_without_lark_calls():
    users = make_follow_up_test_users()
    repo, _conn = _repo()

    follow_up_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users))

    row = repo.get_follow_up(users.company_id, follow_up_id)
    assert row is not None
    assert row.status == "assigned"
    assert row.lark_task_guid == "lark-task-guid-test-001"
    assert row.delegator_company_user_id == users.manager_company_user_id
    assert row.assignee_company_user_id == users.assignee_company_user_id
    assert row.follow_up_policy_json["notify_on_start"] is True


def test_append_event():
    users = make_follow_up_test_users()
    repo, conn = _repo()
    follow_up_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users))

    event_id = repo.append_event(
        users.company_id,
        follow_up_id,
        event_type="created",
        actor_company_user_id=users.manager_company_user_id,
        payload={"title": "Prepare Q3 brief"},
    )

    assert event_id
    assert len(conn.events) == 1
    assert conn.events[0]["eventType"] == "created"
    assert conn.events[0]["payloadJson"]["title"] == "Prepare Q3 brief"


def test_attach_tracking_doc_updates_session_and_doc_fields():
    users = make_follow_up_test_users()
    repo, _conn = _repo()
    follow_up_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users))

    row = repo.attach_tracking_doc(
        users.company_id,
        follow_up_id,
        active_session_id="session-active-001",
        tracking_doc_token="doc_token_001",
        tracking_doc_url="https://tenant.larksuite.com/docx/doc_token_001",
    )

    assert row.active_session_id == "session-active-001"
    assert row.tracking_doc_token == "doc_token_001"
    assert row.tracking_doc_url == "https://tenant.larksuite.com/docx/doc_token_001"


def test_update_assignee_changes_follow_up_owner():
    users = make_follow_up_test_users()
    repo, _conn = _repo()
    follow_up_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users))

    row = repo.update_assignee(
        users.company_id,
        follow_up_id,
        assignee_company_user_id="cu_suman",
    )

    assert row.assignee_company_user_id == "cu_suman"


def test_store_completion_summary_updates_summary_and_doc_append_time():
    users = make_follow_up_test_users()
    repo, _conn = _repo()
    follow_up_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users))

    row = repo.store_completion_summary(
        users.company_id,
        follow_up_id,
        summary="Completed the rollout brief and shared the final notes.",
        update_last_doc_append_at=True,
    )

    assert row.summary == "Completed the rollout brief and shared the final notes."
    assert row.last_doc_append_at == "doc-appended"


def test_mark_doc_appended_updates_doc_append_time_without_summary():
    users = make_follow_up_test_users()
    repo, _conn = _repo()
    follow_up_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users))

    row = repo.mark_doc_appended(users.company_id, follow_up_id)

    assert row.summary is None
    assert row.last_doc_append_at == "doc-appended"


def test_list_for_assignee_isolates_users_and_companies():
    users = make_follow_up_test_users()
    repo, _ = _repo()
    other_company = make_follow_up_test_users()
    other_company = other_company.__class__(
        company_id=other_company.company_id + "-other",
        manager_company_user_id=other_company.manager_company_user_id + "-other",
        assignee_company_user_id=other_company.assignee_company_user_id,
    )

    mine_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users, lark_task_guid="task-1"))
    kept_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users, lark_task_guid="task-2"))
    repo.create_follow_up(
        **make_sample_follow_up_kwargs(
            users,
            lark_task_guid="task-manager",
            assignee_company_user_id=users.manager_company_user_id,
        )
    )
    repo.create_follow_up(
        **make_sample_follow_up_kwargs(other_company, lark_task_guid="task-3")
    )
    repo.update_status(
        users.company_id,
        mine_id,
        target_status="deleted",
        actor_company_user_id=users.manager_company_user_id,
    )

    rows = repo.list_for_assignee(users.company_id, users.assignee_company_user_id)
    assert len(rows) == 1
    assert rows[0].id == kept_id
    assert rows[0].lark_task_guid == "task-2"


def test_list_for_user_returns_assigned_and_delegated_rows():
    users = make_follow_up_test_users()
    repo, _ = _repo()

    assigned_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users, lark_task_guid="task-assigned"))
    delegated_id = repo.create_follow_up(
        **make_sample_follow_up_kwargs(
            users,
            lark_task_guid="task-delegated",
            assignee_company_user_id=users.manager_company_user_id,
        )
    )
    deleted_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users, lark_task_guid="task-deleted"))
    repo.update_status(
        users.company_id,
        deleted_id,
        target_status="deleted",
        actor_company_user_id=users.manager_company_user_id,
    )

    rows = repo.list_for_user(users.company_id, users.manager_company_user_id)

    assert [row.id for row in rows] == [delegated_id, assigned_id]


def test_list_active_only_returns_active_status():
    users = make_follow_up_test_users()
    repo, _ = _repo()

    assigned_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users, lark_task_guid="task-a"))
    starting_id = repo.create_follow_up(
        **make_sample_follow_up_kwargs(users, lark_task_guid="task-s")
    )
    active_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users, lark_task_guid="task-active"))
    paused_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users, lark_task_guid="task-p"))

    repo.update_status(users.company_id, starting_id, target_status="starting")
    repo.update_status(users.company_id, active_id, target_status="starting")
    repo.update_status(users.company_id, active_id, target_status="active")
    repo.update_status(users.company_id, paused_id, target_status="starting")
    repo.update_status(users.company_id, paused_id, target_status="active")
    repo.update_status(users.company_id, paused_id, target_status="paused")

    active_rows = repo.list_active(users.company_id, assignee_company_user_id=users.assignee_company_user_id)
    assert [row.id for row in active_rows] == [active_id]
    assert assigned_id not in {row.id for row in active_rows}


def test_valid_lifecycle_transitions_pass_and_append_events():
    users = make_follow_up_test_users()
    repo, _ = _repo()
    follow_up_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users))

    repo.update_status(users.company_id, follow_up_id, target_status="starting")
    repo.update_status(users.company_id, follow_up_id, target_status="active")
    repo.update_status(users.company_id, follow_up_id, target_status="paused")
    repo.update_status(users.company_id, follow_up_id, target_status="active")
    repo.update_status(users.company_id, follow_up_id, target_status="done")

    row = repo.get_follow_up(users.company_id, follow_up_id)
    assert row is not None
    assert row.status == "done"
    assert row.started_at == "started"
    assert row.paused_at == "paused"
    assert row.completed_at == "completed"

    events = repo.list_events(users.company_id, follow_up_id)
    assert len(events) == 5
    assert all(event.event_type == "status_changed" for event in events)
    assert events[-1].payload_json["to_status"] == "done"


def test_reassigned_flow_returns_to_assigned():
    users = make_follow_up_test_users()
    repo, _ = _repo()
    follow_up_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users))

    repo.update_status(users.company_id, follow_up_id, target_status="reassigned")
    repo.update_status(users.company_id, follow_up_id, target_status="assigned")

    row = repo.get_follow_up(users.company_id, follow_up_id)
    assert row is not None
    assert row.status == "assigned"


def test_invalid_transitions_fail_clearly():
    users = make_follow_up_test_users()
    repo, _ = _repo()
    follow_up_id = repo.create_follow_up(**make_sample_follow_up_kwargs(users))

    with pytest.raises(FollowUpLifecycleError, match="from 'assigned' to 'active'"):
        repo.update_status(users.company_id, follow_up_id, target_status="active")

    repo.update_status(users.company_id, follow_up_id, target_status="starting")
    repo.update_status(users.company_id, follow_up_id, target_status="active")
    repo.update_status(users.company_id, follow_up_id, target_status="done")

    with pytest.raises(FollowUpLifecycleError, match="from 'done' to 'active'"):
        repo.update_status(users.company_id, follow_up_id, target_status="active")

    deleted_id = repo.create_follow_up(
        **make_sample_follow_up_kwargs(users, lark_task_guid="task-deleted")
    )
    repo.update_status(users.company_id, deleted_id, target_status="deleted")
    with pytest.raises(FollowUpLifecycleError, match="from 'deleted' to 'assigned'"):
        repo.update_status(users.company_id, deleted_id, target_status="assigned")


@pytest.mark.parametrize(
    ("current", "target"),
    [
        ("assigned", "active"),
        ("done", "assigned"),
        ("deleted", "assigned"),
        ("starting", "paused"),
    ],
)
def test_validate_transition_rejects_invalid_pairs(current: str, target: str):
    with pytest.raises(FollowUpLifecycleError):
        validate_transition(current, target)


@pytest.mark.parametrize(
    ("current", "target"),
    [
        ("assigned", "starting"),
        ("starting", "active"),
        ("active", "paused"),
        ("paused", "active"),
        ("active", "done"),
        ("assigned", "reassigned"),
        ("reassigned", "assigned"),
    ],
)
def test_validate_transition_accepts_valid_pairs(current: str, target: str):
    validate_transition(current, target)
