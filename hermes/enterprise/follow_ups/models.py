"""Typed models for the Divo Follow Ups control layer."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Mapping

FollowUpStatus = Literal[
    "assigned",
    "starting",
    "active",
    "paused",
    "reassigned",
    "done",
    "deleted",
]

FollowUpEventType = Literal[
    "created",
    "status_changed",
    "started",
    "paused",
    "reassigned",
    "done",
    "deleted",
    "doc_updated",
]

DEFAULT_FOLLOW_UP_POLICY: dict[str, Any] = {
    "notify_on_start": True,
    "notify_on_pause": True,
    "notify_on_done": True,
    "doc_update_mode": "summary_checkpoint",
    "completion_summary_required": True,
}


@dataclass(frozen=True)
class DivoFollowUp:
    id: str
    company_id: str
    lark_task_guid: str
    delegator_company_user_id: str
    assignee_company_user_id: str
    source_session_id: str | None
    active_session_id: str | None
    tracking_doc_token: str | None
    tracking_doc_url: str | None
    status: str
    follow_up_policy_json: Mapping[str, Any]
    started_at: str | None
    paused_at: str | None
    completed_at: str | None
    summary: str | None
    last_doc_append_at: str | None
    created_at: str | None
    updated_at: str | None

    @classmethod
    def from_row(cls, row: Mapping[str, Any] | None) -> "DivoFollowUp | None":
        if row is None:
            return None
        policy = row.get("followUpPolicyJson") or row.get("follow_up_policy_json") or {}
        return cls(
            id=str(row.get("id") or ""),
            company_id=str(row.get("companyId") or row.get("company_id") or ""),
            lark_task_guid=str(row.get("larkTaskGuid") or row.get("lark_task_guid") or ""),
            delegator_company_user_id=str(
                row.get("delegatorCompanyUserId") or row.get("delegator_company_user_id") or ""
            ),
            assignee_company_user_id=str(
                row.get("assigneeCompanyUserId") or row.get("assignee_company_user_id") or ""
            ),
            source_session_id=_optional_text(row.get("sourceSessionId") or row.get("source_session_id")),
            active_session_id=_optional_text(row.get("activeSessionId") or row.get("active_session_id")),
            tracking_doc_token=_optional_text(row.get("trackingDocToken") or row.get("tracking_doc_token")),
            tracking_doc_url=_optional_text(row.get("trackingDocUrl") or row.get("tracking_doc_url")),
            status=str(row.get("status") or ""),
            follow_up_policy_json=dict(policy),
            started_at=_optional_text(row.get("startedAt") or row.get("started_at")),
            paused_at=_optional_text(row.get("pausedAt") or row.get("paused_at")),
            completed_at=_optional_text(row.get("completedAt") or row.get("completed_at")),
            summary=_optional_text(row.get("summary")),
            last_doc_append_at=_optional_text(row.get("lastDocAppendAt") or row.get("last_doc_append_at")),
            created_at=_optional_text(row.get("createdAt") or row.get("created_at")),
            updated_at=_optional_text(row.get("updatedAt") or row.get("updated_at")),
        )


@dataclass(frozen=True)
class DivoFollowUpEvent:
    id: str
    follow_up_id: str
    event_type: str
    actor_company_user_id: str | None
    payload_json: Mapping[str, Any]
    created_at: str | None

    @classmethod
    def from_row(cls, row: Mapping[str, Any] | None) -> "DivoFollowUpEvent | None":
        if row is None:
            return None
        payload = row.get("payloadJson") or row.get("payload_json") or {}
        return cls(
            id=str(row.get("id") or ""),
            follow_up_id=str(row.get("followUpId") or row.get("follow_up_id") or ""),
            event_type=str(row.get("eventType") or row.get("event_type") or ""),
            actor_company_user_id=_optional_text(
                row.get("actorCompanyUserId") or row.get("actor_company_user_id")
            ),
            payload_json=dict(payload),
            created_at=_optional_text(row.get("createdAt") or row.get("created_at")),
        )


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text or None
