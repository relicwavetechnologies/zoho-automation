"""Minimal smoke fixtures for Divo Follow Ups unit tests."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any


def _stable_id(prefix: str, *parts: object) -> str:
    seed = "\x1f".join(str(part or "") for part in parts)
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


@dataclass(frozen=True)
class FollowUpTestUsers:
    company_id: str
    manager_company_user_id: str
    assignee_company_user_id: str


def make_follow_up_test_users() -> FollowUpTestUsers:
    """Return stable manager/assignee company-user ids for smoke tests."""
    company_id = _stable_id("co", "divo-follow-ups", "test-company")
    manager_company_user_id = _stable_id("cu", company_id, "manager", "abhishek")
    assignee_company_user_id = _stable_id("cu", company_id, "assignee", "anish")
    return FollowUpTestUsers(
        company_id=company_id,
        manager_company_user_id=manager_company_user_id,
        assignee_company_user_id=assignee_company_user_id,
    )


def make_sample_follow_up_kwargs(
    users: FollowUpTestUsers,
    *,
    lark_task_guid: str = "lark-task-guid-test-001",
    source_session_id: str = "session-manager-create-001",
    follow_up_policy_json: dict[str, Any] | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "company_id": users.company_id,
        "lark_task_guid": lark_task_guid,
        "delegator_company_user_id": users.manager_company_user_id,
        "assignee_company_user_id": users.assignee_company_user_id,
        "source_session_id": source_session_id,
        "follow_up_policy_json": follow_up_policy_json
        or {
            "notify_on_start": True,
            "notify_on_pause": True,
            "notify_on_done": True,
            "doc_update_mode": "summary_checkpoint",
            "completion_summary_required": True,
        },
    }
    kwargs.update(overrides)
    return kwargs
