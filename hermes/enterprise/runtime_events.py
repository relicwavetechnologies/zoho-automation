"""Canonical runtime event contract for Hermes-Divo runs."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Mapping

from .identity import EnterpriseIdentityEnvelope


TERMINAL_EVENT_STATUSES = {
    "run.completed": "completed",
    "run.failed": "failed",
    "run.cancelled": "cancelled",
}

RUN_STATUS_EVENTS = {
    "approval.request": "waiting_for_approval",
    "approval.responded": "running",
    "run.completed": "completed",
    "run.failed": "failed",
    "run.cancelled": "cancelled",
}


@dataclass(frozen=True)
class RuntimeIdentityContext:
    company_id: str = ""
    company_user_id: str = ""
    channel_identity_id: str = ""
    company_role: str = ""
    department_id: str = ""
    session_key: str = ""

    @classmethod
    def from_envelope(cls, envelope: EnterpriseIdentityEnvelope) -> "RuntimeIdentityContext":
        return cls(
            company_id=envelope.company_id,
            company_user_id=envelope.company_user_id,
            channel_identity_id=envelope.channel_identity_id,
            company_role=envelope.company_role,
            department_id=envelope.department_id,
            session_key=envelope.session_key,
        )


@dataclass(frozen=True)
class RuntimeRunContext:
    run_id: str
    company_id: str
    channel: str
    channel_conversation_key: str
    raw_channel_key: str
    hermes_session_id: str
    session_key: str
    department_id: str = ""
    created_by_user_id: str = ""
    channel_identity_id: str = ""
    created_by_email: str = ""
    parent_run_id: str = ""
    parent_hermes_session_id: str = ""
    model_id: str = ""
    system_prompt_snapshot: str = ""
    cwd: str = ""
    entrypoint: str = "api_server:/v1/runs"
    engine: str = "hermes"
    engine_mode: str = "primary"


@dataclass(frozen=True)
class RuntimeEvent:
    run_id: str
    sequence: int
    event_type: str
    timestamp: float
    idempotency_key: str
    status: str = ""
    message_role: str = ""
    message_kind: str = ""
    content_text: str = ""
    tool_name: str = ""
    tool_call_id: str = ""
    approval_id: str = ""
    error: str = ""
    finish_reason: str = ""
    usage: Mapping[str, Any] = field(default_factory=dict)
    identity: RuntimeIdentityContext = field(default_factory=RuntimeIdentityContext)
    raw: Mapping[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "sequence": self.sequence,
            "event_type": self.event_type,
            "timestamp": self.timestamp,
            "idempotency_key": self.idempotency_key,
            "status": self.status,
            "message_role": self.message_role,
            "message_kind": self.message_kind,
            "content_text": self.content_text,
            "tool_name": self.tool_name,
            "tool_call_id": self.tool_call_id,
            "approval_id": self.approval_id,
            "error": self.error,
            "finish_reason": self.finish_reason,
            "usage": dict(self.usage or {}),
            "identity": {
                "company_id": self.identity.company_id,
                "company_user_id": self.identity.company_user_id,
                "channel_identity_id": self.identity.channel_identity_id,
                "company_role": self.identity.company_role,
                "department_id": self.identity.department_id,
                "session_key": self.identity.session_key,
            },
            "raw": dict(self.raw or {}),
        }


class RuntimeEventNormalizer:
    """Assign per-run sequence and normalize raw Hermes event payloads."""

    def __init__(
        self,
        *,
        run_id: str,
        identity: RuntimeIdentityContext | None = None,
        sequence_start: int = 0,
    ):
        self.run_id = run_id
        self.identity = identity or RuntimeIdentityContext()
        self._sequence = sequence_start

    def normalize(self, raw_event: Mapping[str, Any]) -> RuntimeEvent:
        self._sequence += 1
        event_type = str(raw_event.get("event") or "runtime.event")
        timestamp = _coerce_timestamp(raw_event.get("timestamp"))
        return RuntimeEvent(
            run_id=str(raw_event.get("run_id") or self.run_id),
            sequence=self._sequence,
            event_type=event_type,
            timestamp=timestamp,
            idempotency_key=f"{self.run_id}:{self._sequence}:{event_type}",
            status=RUN_STATUS_EVENTS.get(event_type, ""),
            message_role=_message_role(event_type),
            message_kind=_message_kind(event_type),
            content_text=_content_text(event_type, raw_event),
            tool_name=str(raw_event.get("tool") or raw_event.get("tool_name") or ""),
            tool_call_id=str(raw_event.get("tool_call_id") or raw_event.get("call_id") or ""),
            approval_id=str(raw_event.get("approval_id") or raw_event.get("approvalId") or ""),
            error=str(raw_event.get("error") or ""),
            finish_reason=_finish_reason(event_type),
            usage=raw_event.get("usage") if isinstance(raw_event.get("usage"), Mapping) else {},
            identity=self.identity,
            raw=dict(raw_event),
        )


def _coerce_timestamp(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return time.time()


def _message_role(event_type: str) -> str:
    if event_type in {"message.delta", "run.completed", "reasoning.available"}:
        return "assistant"
    if event_type.startswith("tool."):
        return "tool"
    if event_type.startswith("approval.") or event_type.startswith("run."):
        return "system"
    return ""


def _message_kind(event_type: str) -> str:
    if event_type == "message.delta":
        return "delta"
    if event_type == "run.completed":
        return "final"
    if event_type == "reasoning.available":
        return "reasoning"
    if event_type.startswith("tool."):
        return "tool"
    if event_type.startswith("approval."):
        return "approval"
    if event_type.startswith("run."):
        return "status"
    return ""


def _content_text(event_type: str, raw_event: Mapping[str, Any]) -> str:
    if event_type == "message.delta":
        return str(raw_event.get("delta") or "")
    if event_type == "run.completed":
        return str(raw_event.get("output") or "")
    if event_type == "run.failed":
        return str(raw_event.get("error") or "")
    if event_type == "run.cancelled":
        return "cancelled"
    if event_type == "reasoning.available":
        return str(raw_event.get("text") or "")
    return str(raw_event.get("preview") or "")


def _finish_reason(event_type: str) -> str:
    if event_type in TERMINAL_EVENT_STATUSES:
        return TERMINAL_EVENT_STATUSES[event_type]
    return ""
