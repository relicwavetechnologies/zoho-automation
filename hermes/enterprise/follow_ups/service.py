"""Service layer for Divo Follow Ups orchestration.

This module intentionally keeps Lark side effects behind small injected
interfaces. Unit tests can prove the create flow without real Lark credentials,
while production wiring can delegate to the existing native Lark tools.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from enterprise.follow_up_repository import FollowUpRepository
from enterprise.follow_ups.models import DEFAULT_FOLLOW_UP_POLICY, DivoFollowUp


class FollowUpServiceError(ValueError):
    """Raised when a Divo Follow Ups service request is invalid."""


@dataclass(frozen=True)
class ResolvedFollowUpUser:
    company_user_id: str
    lark_open_id: str
    display_name: str
    email: str | None = None


@dataclass(frozen=True)
class CreatedLarkTask:
    task_guid: str
    title: str
    url: str | None = None


@dataclass(frozen=True)
class CreatedTrackingDoc:
    doc_token: str
    title: str
    url: str | None = None


@dataclass(frozen=True)
class CreateFollowUpRequest:
    company_id: str
    delegator_company_user_id: str
    title: str
    due_date: str
    assignee_company_user_id: str | None = None
    assignee_query: str | None = None
    notes: str | None = None
    source_session_id: str | None = None
    follow_up_policy_json: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class CreateFollowUpResult:
    follow_up: DivoFollowUp
    lark_task: CreatedLarkTask
    delegator: ResolvedFollowUpUser
    assignee: ResolvedFollowUpUser


@dataclass(frozen=True)
class StartFollowUpRequest:
    company_id: str
    follow_up_id: str
    actor_company_user_id: str
    active_session_id: str


@dataclass(frozen=True)
class StartFollowUpResult:
    follow_up: DivoFollowUp
    tracking_doc: CreatedTrackingDoc
    manager_message_id: str | None


@dataclass(frozen=True)
class PauseFollowUpRequest:
    company_id: str
    follow_up_id: str
    actor_company_user_id: str
    reason: str | None = None


@dataclass(frozen=True)
class ReassignFollowUpRequest:
    company_id: str
    follow_up_id: str
    actor_company_user_id: str
    new_assignee_company_user_id: str | None = None
    new_assignee_query: str | None = None


@dataclass(frozen=True)
class CompleteFollowUpRequest:
    company_id: str
    follow_up_id: str
    actor_company_user_id: str
    summary: str


@dataclass(frozen=True)
class UpdateFollowUpDocRequest:
    company_id: str
    follow_up_id: str
    actor_company_user_id: str
    note: str


@dataclass(frozen=True)
class LifecycleFollowUpResult:
    follow_up: DivoFollowUp
    manager_message_id: str | None = None


class FollowUpIdentityResolver(Protocol):
    def resolve_company_user(
        self,
        *,
        company_id: str,
        company_user_id: str | None = None,
        query: str | None = None,
    ) -> ResolvedFollowUpUser:
        """Resolve a company user to a Lark open_id."""


class FollowUpLarkGateway(Protocol):
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
        """Create the canonical Lark Task."""

    def send_dm(
        self,
        *,
        company_id: str,
        sender: ResolvedFollowUpUser,
        recipient: ResolvedFollowUpUser,
        text: str,
    ) -> str | None:
        """Send a Lark DM and return the message id if available."""

    def create_tracking_doc(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        title: str,
        markdown: str,
    ) -> CreatedTrackingDoc:
        """Create the Lark tracking doc for a started follow-up."""

    def add_task_comment(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        task_guid: str,
        content: str,
    ) -> str | None:
        """Add a visible comment/reference to the Lark Task."""

    def update_task_assignee(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        task_guid: str,
        assignee: ResolvedFollowUpUser,
    ) -> None:
        """Update the Lark Task assignee."""

    def complete_task(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        task_guid: str,
    ) -> None:
        """Mark the Lark Task complete."""

    def append_tracking_doc(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        doc_token: str,
        markdown: str,
    ) -> None:
        """Append markdown to the tracking doc."""


class DivoFollowUpsService:
    """Application service for Divo Follow Ups v1."""

    def __init__(
        self,
        *,
        repository: FollowUpRepository,
        identity_resolver: FollowUpIdentityResolver,
        lark_gateway: FollowUpLarkGateway,
    ) -> None:
        self._repository = repository
        self._identity_resolver = identity_resolver
        self._lark_gateway = lark_gateway

    def create_follow_up(self, request: CreateFollowUpRequest) -> CreateFollowUpResult:
        """Create the Lark Task and persist the Divo Follow Up control row."""

        title = request.title.strip()
        due_date = request.due_date.strip()
        if not request.company_id.strip():
            raise FollowUpServiceError("company_id is required")
        if not title:
            raise FollowUpServiceError("title is required")
        if not due_date:
            raise FollowUpServiceError("due_date is required")
        if not request.assignee_company_user_id and not (request.assignee_query or "").strip():
            raise FollowUpServiceError("assignee_company_user_id or assignee_query is required")

        delegator = self._identity_resolver.resolve_company_user(
            company_id=request.company_id,
            company_user_id=request.delegator_company_user_id,
        )
        assignee = self._identity_resolver.resolve_company_user(
            company_id=request.company_id,
            company_user_id=request.assignee_company_user_id,
            query=request.assignee_query,
        )
        lark_task = self._lark_gateway.create_task(
            company_id=request.company_id,
            requester=delegator,
            assignee=assignee,
            follower=delegator,
            title=title,
            due_date=due_date,
            notes=request.notes,
        )
        if not lark_task.task_guid:
            raise FollowUpServiceError("Lark task creation did not return a task guid")

        policy = {
            **DEFAULT_FOLLOW_UP_POLICY,
            **dict(request.follow_up_policy_json or {}),
        }
        follow_up_id = self._repository.create_follow_up(
            company_id=request.company_id,
            lark_task_guid=lark_task.task_guid,
            delegator_company_user_id=delegator.company_user_id,
            assignee_company_user_id=assignee.company_user_id,
            source_session_id=request.source_session_id,
            follow_up_policy_json=policy,
        )
        self._repository.append_event(
            request.company_id,
            follow_up_id,
            event_type="created",
            actor_company_user_id=delegator.company_user_id,
            payload={
                "title": title,
                "due_date": due_date,
                "lark_task_guid": lark_task.task_guid,
                **({"lark_task_url": lark_task.url} if lark_task.url else {}),
                **({"notes": request.notes} if request.notes else {}),
                "assignee_company_user_id": assignee.company_user_id,
                "assignee_lark_open_id": assignee.lark_open_id,
            },
        )
        follow_up = self._repository.get_follow_up(request.company_id, follow_up_id)
        if follow_up is None:
            raise FollowUpServiceError(f"Follow-up not found after create: {follow_up_id}")
        return CreateFollowUpResult(
            follow_up=follow_up,
            lark_task=lark_task,
            delegator=delegator,
            assignee=assignee,
        )

    def notify_manager(
        self,
        *,
        company_id: str,
        manager_company_user_id: str,
        actor_company_user_id: str,
        text: str,
    ) -> str | None:
        """Send a manager Lark DM through the injected gateway."""

        manager = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=manager_company_user_id,
        )
        actor = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=actor_company_user_id,
        )
        return self._lark_gateway.send_dm(
            company_id=company_id,
            sender=actor,
            recipient=manager,
            text=text,
        )

    def start_follow_up(self, request: StartFollowUpRequest) -> StartFollowUpResult:
        """Confirm assignee start, create/link tracking doc, and notify manager."""

        company_id = request.company_id.strip()
        follow_up_id = request.follow_up_id.strip()
        actor_company_user_id = request.actor_company_user_id.strip()
        active_session_id = request.active_session_id.strip()
        if not company_id:
            raise FollowUpServiceError("company_id is required")
        if not follow_up_id:
            raise FollowUpServiceError("follow_up_id is required")
        if not actor_company_user_id:
            raise FollowUpServiceError("actor_company_user_id is required")
        if not active_session_id:
            raise FollowUpServiceError("active_session_id is required")

        follow_up = self._repository.get_follow_up(company_id, follow_up_id)
        if follow_up is None:
            raise FollowUpServiceError(f"Follow-up not found: {follow_up_id}")
        if actor_company_user_id != follow_up.assignee_company_user_id:
            raise FollowUpServiceError("Only the assignee can start this follow-up")
        if follow_up.status == "assigned":
            follow_up = self._repository.update_status(
                company_id,
                follow_up_id,
                target_status="starting",
                actor_company_user_id=actor_company_user_id,
                payload={"active_session_id": active_session_id},
            )
        elif follow_up.status not in {"starting", "paused"}:
            raise FollowUpServiceError(f"Cannot start follow-up in status {follow_up.status!r}")

        delegator = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=follow_up.delegator_company_user_id,
        )
        assignee = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=follow_up.assignee_company_user_id,
        )
        created_payload = _created_event_payload(self._repository, company_id, follow_up_id)
        title = str(created_payload.get("title") or follow_up.lark_task_guid).strip()
        due_date = str(created_payload.get("due_date") or "").strip()

        if follow_up.status == "paused":
            if not follow_up.tracking_doc_token:
                raise FollowUpServiceError("Tracking doc is not available yet")
            tracking_doc = CreatedTrackingDoc(
                doc_token=follow_up.tracking_doc_token,
                title=_tracking_doc_title(title),
                url=follow_up.tracking_doc_url,
            )
            self._repository.attach_tracking_doc(
                company_id,
                follow_up_id,
                active_session_id=active_session_id,
                tracking_doc_token=tracking_doc.doc_token,
                tracking_doc_url=tracking_doc.url,
            )
            active = self._repository.update_status(
                company_id,
                follow_up_id,
                target_status="active",
                actor_company_user_id=actor_company_user_id,
                payload={
                    "active_session_id": active_session_id,
                    "tracking_doc_token": tracking_doc.doc_token,
                    "resumed": True,
                    **({"tracking_doc_url": tracking_doc.url} if tracking_doc.url else {}),
                },
            )
            self._repository.append_event(
                company_id,
                follow_up_id,
                event_type="started",
                actor_company_user_id=actor_company_user_id,
                payload={
                    "title": title,
                    "active_session_id": active_session_id,
                    "tracking_doc_token": tracking_doc.doc_token,
                    "resumed": True,
                    **({"tracking_doc_url": tracking_doc.url} if tracking_doc.url else {}),
                },
            )
            manager_message_id: str | None = None
            if bool(active.follow_up_policy_json.get("notify_on_start", True)):
                manager_message_id = self._lark_gateway.send_dm(
                    company_id=company_id,
                    sender=assignee,
                    recipient=delegator,
                    text=_resumed_manager_message(
                        title=title,
                        assignee=assignee,
                        tracking_doc=tracking_doc,
                        lark_task_guid=follow_up.lark_task_guid,
                    ),
                )
            updated = self._repository.get_follow_up(company_id, follow_up_id)
            if updated is None:
                raise FollowUpServiceError(f"Follow-up not found after resume: {follow_up_id}")
            return StartFollowUpResult(
                follow_up=updated,
                tracking_doc=tracking_doc,
                manager_message_id=manager_message_id,
            )

        tracking_doc = self._lark_gateway.create_tracking_doc(
            company_id=company_id,
            requester=assignee,
            title=_tracking_doc_title(title),
            markdown=_tracking_doc_markdown(
                title=title,
                delegator=delegator,
                assignee=assignee,
                due_date=due_date,
                lark_task_guid=follow_up.lark_task_guid,
            ),
        )
        if not tracking_doc.doc_token:
            raise FollowUpServiceError("Tracking doc creation did not return a doc token")

        comment_content = _tracking_doc_comment(tracking_doc)
        comment_id = self._lark_gateway.add_task_comment(
            company_id=company_id,
            requester=assignee,
            task_guid=follow_up.lark_task_guid,
            content=comment_content,
        )
        self._repository.attach_tracking_doc(
            company_id,
            follow_up_id,
            active_session_id=active_session_id,
            tracking_doc_token=tracking_doc.doc_token,
            tracking_doc_url=tracking_doc.url,
        )
        active = self._repository.update_status(
            company_id,
            follow_up_id,
            target_status="active",
            actor_company_user_id=actor_company_user_id,
            payload={
                "active_session_id": active_session_id,
                "tracking_doc_token": tracking_doc.doc_token,
                **({"tracking_doc_url": tracking_doc.url} if tracking_doc.url else {}),
            },
        )
        self._repository.append_event(
            company_id,
            follow_up_id,
            event_type="started",
            actor_company_user_id=actor_company_user_id,
            payload={
                "title": title,
                "active_session_id": active_session_id,
                "tracking_doc_token": tracking_doc.doc_token,
                **({"tracking_doc_url": tracking_doc.url} if tracking_doc.url else {}),
                **({"task_comment_id": comment_id} if comment_id else {}),
            },
        )
        manager_message_id: str | None = None
        if bool(active.follow_up_policy_json.get("notify_on_start", True)):
            manager_message_id = self._lark_gateway.send_dm(
                company_id=company_id,
                sender=assignee,
                recipient=delegator,
                text=_started_manager_message(
                    title=title,
                    assignee=assignee,
                    tracking_doc=tracking_doc,
                    lark_task_guid=follow_up.lark_task_guid,
                ),
            )
        updated = self._repository.get_follow_up(company_id, follow_up_id)
        if updated is None:
            raise FollowUpServiceError(f"Follow-up not found after start: {follow_up_id}")
        return StartFollowUpResult(
            follow_up=updated,
            tracking_doc=tracking_doc,
            manager_message_id=manager_message_id,
        )

    def pause_follow_up(self, request: PauseFollowUpRequest) -> LifecycleFollowUpResult:
        """Pause an active follow-up and notify the manager when configured."""

        company_id = request.company_id.strip()
        follow_up_id = request.follow_up_id.strip()
        actor_company_user_id = request.actor_company_user_id.strip()
        if not company_id:
            raise FollowUpServiceError("company_id is required")
        if not follow_up_id:
            raise FollowUpServiceError("follow_up_id is required")
        if not actor_company_user_id:
            raise FollowUpServiceError("actor_company_user_id is required")

        follow_up = self._repository.get_follow_up(company_id, follow_up_id)
        if follow_up is None:
            raise FollowUpServiceError(f"Follow-up not found: {follow_up_id}")
        if actor_company_user_id != follow_up.assignee_company_user_id:
            raise FollowUpServiceError("Only the assignee can pause this follow-up")

        paused = self._repository.update_status(
            company_id,
            follow_up_id,
            target_status="paused",
            actor_company_user_id=actor_company_user_id,
            payload={"reason": request.reason} if request.reason else None,
        )
        assignee = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=follow_up.assignee_company_user_id,
        )
        delegator = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=follow_up.delegator_company_user_id,
        )
        title = _follow_up_title(self._repository, company_id, follow_up_id, follow_up)
        self._repository.append_event(
            company_id,
            follow_up_id,
            event_type="paused",
            actor_company_user_id=actor_company_user_id,
            payload={"title": title, **({"reason": request.reason} if request.reason else {})},
        )
        manager_message_id: str | None = None
        if bool(paused.follow_up_policy_json.get("notify_on_pause", True)):
            manager_message_id = self._lark_gateway.send_dm(
                company_id=company_id,
                sender=assignee,
                recipient=delegator,
                text=_paused_manager_message(title=title, assignee=assignee, reason=request.reason),
            )
        updated = self._repository.get_follow_up(company_id, follow_up_id)
        if updated is None:
            raise FollowUpServiceError(f"Follow-up not found after pause: {follow_up_id}")
        return LifecycleFollowUpResult(follow_up=updated, manager_message_id=manager_message_id)

    def reassign_follow_up(self, request: ReassignFollowUpRequest) -> LifecycleFollowUpResult:
        """Reassign a follow-up and the backing Lark Task."""

        company_id = request.company_id.strip()
        follow_up_id = request.follow_up_id.strip()
        actor_company_user_id = request.actor_company_user_id.strip()
        if not company_id:
            raise FollowUpServiceError("company_id is required")
        if not follow_up_id:
            raise FollowUpServiceError("follow_up_id is required")
        if not actor_company_user_id:
            raise FollowUpServiceError("actor_company_user_id is required")
        if not request.new_assignee_company_user_id and not (request.new_assignee_query or "").strip():
            raise FollowUpServiceError("new_assignee_company_user_id or new_assignee_query is required")

        follow_up = self._repository.get_follow_up(company_id, follow_up_id)
        if follow_up is None:
            raise FollowUpServiceError(f"Follow-up not found: {follow_up_id}")
        if actor_company_user_id != follow_up.delegator_company_user_id:
            raise FollowUpServiceError("Only the manager can reassign this follow-up")

        delegator = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=follow_up.delegator_company_user_id,
        )
        new_assignee = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=request.new_assignee_company_user_id,
            query=request.new_assignee_query,
        )
        self._lark_gateway.update_task_assignee(
            company_id=company_id,
            requester=delegator,
            task_guid=follow_up.lark_task_guid,
            assignee=new_assignee,
        )
        reassigned = self._repository.update_status(
            company_id,
            follow_up_id,
            target_status="reassigned",
            actor_company_user_id=actor_company_user_id,
            payload={
                "from_assignee_company_user_id": follow_up.assignee_company_user_id,
                "to_assignee_company_user_id": new_assignee.company_user_id,
            },
        )
        self._repository.update_assignee(
            company_id,
            follow_up_id,
            assignee_company_user_id=new_assignee.company_user_id,
        )
        assigned = self._repository.update_status(
            company_id,
            follow_up_id,
            target_status="assigned",
            actor_company_user_id=actor_company_user_id,
            payload={"to_assignee_company_user_id": new_assignee.company_user_id},
        )
        title = _follow_up_title(self._repository, company_id, follow_up_id, reassigned)
        self._repository.append_event(
            company_id,
            follow_up_id,
            event_type="reassigned",
            actor_company_user_id=actor_company_user_id,
            payload={
                "title": title,
                "from_assignee_company_user_id": follow_up.assignee_company_user_id,
                "to_assignee_company_user_id": new_assignee.company_user_id,
                "to_assignee_lark_open_id": new_assignee.lark_open_id,
            },
        )
        return LifecycleFollowUpResult(follow_up=assigned)

    def prepare_done_summary(self, summary: str) -> str:
        """Validate the user-approved final summary text."""

        clean = re.sub(r"\s+", " ", str(summary or "")).strip()
        if not clean:
            raise FollowUpServiceError("completion summary is required")
        return clean

    def update_tracking_doc_checkpoint(self, request: UpdateFollowUpDocRequest) -> LifecycleFollowUpResult:
        """Append an assignee-approved progress checkpoint to the tracking doc."""

        company_id = request.company_id.strip()
        follow_up_id = request.follow_up_id.strip()
        actor_company_user_id = request.actor_company_user_id.strip()
        note = _clean_checkpoint_note(request.note)
        if not company_id:
            raise FollowUpServiceError("company_id is required")
        if not follow_up_id:
            raise FollowUpServiceError("follow_up_id is required")
        if not actor_company_user_id:
            raise FollowUpServiceError("actor_company_user_id is required")

        follow_up = self._repository.get_follow_up(company_id, follow_up_id)
        if follow_up is None:
            raise FollowUpServiceError(f"Follow-up not found: {follow_up_id}")
        if actor_company_user_id != follow_up.assignee_company_user_id:
            raise FollowUpServiceError("Only the assignee can update this follow-up doc")
        if follow_up.status != "active":
            raise FollowUpServiceError(f"Cannot update tracking doc in status {follow_up.status!r}")
        if not follow_up.tracking_doc_token:
            raise FollowUpServiceError("Tracking doc is not available yet")

        assignee = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=follow_up.assignee_company_user_id,
        )
        title = _follow_up_title(self._repository, company_id, follow_up_id, follow_up)
        markdown = _progress_checkpoint_markdown(note)
        self._lark_gateway.append_tracking_doc(
            company_id=company_id,
            requester=assignee,
            doc_token=follow_up.tracking_doc_token,
            markdown=markdown,
        )
        updated = self._repository.mark_doc_appended(company_id, follow_up_id)
        self._repository.append_event(
            company_id,
            follow_up_id,
            event_type="doc_updated",
            actor_company_user_id=actor_company_user_id,
            payload={"title": title, "note": note, "tracking_doc_token": follow_up.tracking_doc_token},
        )
        refreshed = self._repository.get_follow_up(company_id, follow_up_id)
        return LifecycleFollowUpResult(follow_up=refreshed or updated)

    def complete_follow_up(self, request: CompleteFollowUpRequest) -> LifecycleFollowUpResult:
        """Complete the follow-up after the assignee approves a final summary."""

        company_id = request.company_id.strip()
        follow_up_id = request.follow_up_id.strip()
        actor_company_user_id = request.actor_company_user_id.strip()
        summary = self.prepare_done_summary(request.summary)
        if not company_id:
            raise FollowUpServiceError("company_id is required")
        if not follow_up_id:
            raise FollowUpServiceError("follow_up_id is required")
        if not actor_company_user_id:
            raise FollowUpServiceError("actor_company_user_id is required")

        follow_up = self._repository.get_follow_up(company_id, follow_up_id)
        if follow_up is None:
            raise FollowUpServiceError(f"Follow-up not found: {follow_up_id}")
        if actor_company_user_id != follow_up.assignee_company_user_id:
            raise FollowUpServiceError("Only the assignee can complete this follow-up")

        assignee = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=follow_up.assignee_company_user_id,
        )
        delegator = self._identity_resolver.resolve_company_user(
            company_id=company_id,
            company_user_id=follow_up.delegator_company_user_id,
        )
        title = _follow_up_title(self._repository, company_id, follow_up_id, follow_up)
        appended_doc = False
        if follow_up.tracking_doc_token:
            self._lark_gateway.append_tracking_doc(
                company_id=company_id,
                requester=assignee,
                doc_token=follow_up.tracking_doc_token,
                markdown=_final_summary_markdown(summary),
            )
            appended_doc = True
        self._lark_gateway.complete_task(
            company_id=company_id,
            requester=assignee,
            task_guid=follow_up.lark_task_guid,
        )
        self._repository.store_completion_summary(
            company_id,
            follow_up_id,
            summary=summary,
            update_last_doc_append_at=appended_doc,
        )
        done = self._repository.update_status(
            company_id,
            follow_up_id,
            target_status="done",
            actor_company_user_id=actor_company_user_id,
            payload={"summary": summary, "tracking_doc_appended": appended_doc},
        )
        self._repository.append_event(
            company_id,
            follow_up_id,
            event_type="done",
            actor_company_user_id=actor_company_user_id,
            payload={
                "title": title,
                "summary": summary,
                "tracking_doc_appended": appended_doc,
            },
        )
        manager_message_id: str | None = None
        if bool(done.follow_up_policy_json.get("notify_on_done", True)):
            manager_message_id = self._lark_gateway.send_dm(
                company_id=company_id,
                sender=assignee,
                recipient=delegator,
                text=_done_manager_message(
                    title=title,
                    assignee=assignee,
                    summary=summary,
                    follow_up=done,
                ),
            )
        updated = self._repository.get_follow_up(company_id, follow_up_id)
        if updated is None:
            raise FollowUpServiceError(f"Follow-up not found after complete: {follow_up_id}")
        return LifecycleFollowUpResult(follow_up=updated, manager_message_id=manager_message_id)


class CompanyIdentityFollowUpResolver:
    """Resolve follow-up users from the existing company identity helpers."""

    def resolve_company_user(
        self,
        *,
        company_id: str,
        company_user_id: str | None = None,
        query: str | None = None,
    ) -> ResolvedFollowUpUser:
        from gateway.company_identity import (
            list_channel_identities_for_company_user,
            list_company_users,
        )

        users = list_company_users(company_id=company_id)
        selected = _select_company_user(users, company_user_id=company_user_id, query=query)
        selected_company_user_id = _row_text(selected, "id", "company_user_id", "companyUserId")
        identities = list_channel_identities_for_company_user(selected_company_user_id)
        lark_identity = _select_lark_identity(identities)
        if lark_identity is None:
            raise FollowUpServiceError(
                f"Company user {selected_company_user_id} does not have a Lark identity"
            )
        open_id = _row_text(
            lark_identity,
            "platform_user_id",
            "platformUserId",
            "externalUserId",
            "open_id",
        )
        if not open_id:
            raw = _raw_json(lark_identity)
            open_id = _row_text(raw, "open_id", "user_id")
        if not open_id:
            raise FollowUpServiceError(
                f"Company user {selected_company_user_id} Lark identity is missing open_id"
            )
        display_name = (
            _row_text(lark_identity, "display_name", "displayName")
            or _row_text(selected, "display_name", "displayName", "name", "email")
            or open_id
        )
        email = _row_text(selected, "email") or None
        return ResolvedFollowUpUser(
            company_user_id=selected_company_user_id,
            lark_open_id=open_id,
            display_name=display_name,
            email=email,
        )


class NativeToolFollowUpLarkGateway:
    """Lark gateway backed by the native Hermes Lark tool registry."""

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
        args: dict[str, Any] = {
            "op": "create",
            "title": title,
            "dueDate": due_date,
            "assigneeIds": [assignee.lark_open_id],
        }
        if notes:
            args["notes"] = notes
        if follower is not None:
            args["followerIds"] = [follower.lark_open_id]
        result = _dispatch_lark_tool(
            "lark_task",
            args,
            company_id=company_id,
            company_user_id=requester.company_user_id,
            lark_open_id=requester.lark_open_id,
        )
        if not result.get("success"):
            raise FollowUpServiceError(str(result.get("message") or result.get("error") or "Lark task create failed"))
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        task_guid = str(result.get("taskId") or data.get("taskId") or "").strip()
        return CreatedLarkTask(
            task_guid=task_guid,
            title=str(data.get("title") or title),
            url=_optional_url(result) or _optional_url(data),
        )

    def send_dm(
        self,
        *,
        company_id: str,
        sender: ResolvedFollowUpUser,
        recipient: ResolvedFollowUpUser,
        text: str,
    ) -> str | None:
        result = _dispatch_lark_tool(
            "lark_messaging",
            {
                "op": "send_dm",
                "receiveId": recipient.lark_open_id,
                "text": text,
            },
            company_id=company_id,
            company_user_id=sender.company_user_id,
            lark_open_id=sender.lark_open_id,
        )
        if not result.get("success"):
            raise FollowUpServiceError(str(result.get("message") or result.get("error") or "Lark DM failed"))
        return str(result.get("messageId") or "") or None

    def create_tracking_doc(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        title: str,
        markdown: str,
    ) -> CreatedTrackingDoc:
        result = _dispatch_lark_tool(
            "lark_doc",
            {
                "op": "create_markdown",
                "title": title,
                "markdown": markdown,
            },
            company_id=company_id,
            company_user_id=requester.company_user_id,
            lark_open_id=requester.lark_open_id,
        )
        if not result.get("success"):
            raise FollowUpServiceError(str(result.get("message") or result.get("error") or "Lark doc create failed"))
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        doc_token = str(result.get("docToken") or data.get("docToken") or data.get("document_id") or "").strip()
        return CreatedTrackingDoc(
            doc_token=doc_token,
            title=title,
            url=_optional_url(result) or _optional_url(data),
        )

    def add_task_comment(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        task_guid: str,
        content: str,
    ) -> str | None:
        result = _dispatch_lark_tool(
            "lark_task",
            {
                "op": "comment",
                "taskId": task_guid,
                "content": content,
            },
            company_id=company_id,
            company_user_id=requester.company_user_id,
            lark_open_id=requester.lark_open_id,
        )
        if not result.get("success"):
            raise FollowUpServiceError(str(result.get("message") or result.get("error") or "Lark task comment failed"))
        return str(result.get("commentId") or "") or None

    def update_task_assignee(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        task_guid: str,
        assignee: ResolvedFollowUpUser,
    ) -> None:
        result = _dispatch_lark_tool(
            "lark_task",
            {
                "op": "update",
                "taskId": task_guid,
                "assigneeIds": [assignee.lark_open_id],
            },
            company_id=company_id,
            company_user_id=requester.company_user_id,
            lark_open_id=requester.lark_open_id,
        )
        if not result.get("success"):
            raise FollowUpServiceError(str(result.get("message") or result.get("error") or "Lark task update failed"))

    def complete_task(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        task_guid: str,
    ) -> None:
        result = _dispatch_lark_tool(
            "lark_task",
            {
                "op": "complete",
                "taskId": task_guid,
            },
            company_id=company_id,
            company_user_id=requester.company_user_id,
            lark_open_id=requester.lark_open_id,
        )
        if not result.get("success"):
            raise FollowUpServiceError(str(result.get("message") or result.get("error") or "Lark task complete failed"))

    def append_tracking_doc(
        self,
        *,
        company_id: str,
        requester: ResolvedFollowUpUser,
        doc_token: str,
        markdown: str,
    ) -> None:
        result = _dispatch_lark_tool(
            "lark_doc",
            {
                "op": "append_markdown",
                "docToken": doc_token,
                "markdown": markdown,
            },
            company_id=company_id,
            company_user_id=requester.company_user_id,
            lark_open_id=requester.lark_open_id,
        )
        if not result.get("success"):
            raise FollowUpServiceError(str(result.get("message") or result.get("error") or "Lark doc append failed"))


def _dispatch_lark_tool(name: str, args: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    from tools.registry import registry

    raw = registry.dispatch(name, args, **kwargs)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise FollowUpServiceError(f"{name} returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise FollowUpServiceError(f"{name} returned an unexpected response")
    return parsed


def _select_company_user(
    users: list[Mapping[str, Any]],
    *,
    company_user_id: str | None,
    query: str | None,
) -> Mapping[str, Any]:
    if company_user_id:
        for user in users:
            if _row_text(user, "id", "company_user_id", "companyUserId") == company_user_id:
                return user
        raise FollowUpServiceError(f"Company user not found: {company_user_id}")

    normalized_query = _normalize_person_name(query or "")
    if not normalized_query:
        raise FollowUpServiceError("company_user_id or query is required")
    exact = [
        user
        for user in users
        if normalized_query
        in {
            _normalize_person_name(_row_text(user, "display_name", "displayName", "name")),
            _normalize_person_name(_row_text(user, "email")),
        }
    ]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise FollowUpServiceError(f"Ambiguous assignee: {query}")

    query_tokens = set(normalized_query.split())
    matches = [
        user
        for user in users
        if query_tokens
        and query_tokens.issubset(
            set(_normalize_person_name(_row_text(user, "display_name", "displayName", "name")).split())
        )
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise FollowUpServiceError(f"Ambiguous assignee: {query}")
    raise FollowUpServiceError(f"Could not find assignee: {query}")


def _select_lark_identity(identities: list[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    for identity in identities:
        platform = _row_text(identity, "platform", "channel").lower()
        if platform in {"lark", "feishu"}:
            return identity
    return None


def _raw_json(row: Mapping[str, Any]) -> Mapping[str, Any]:
    raw = row.get("raw_json") or row.get("rawJson")
    if isinstance(raw, Mapping):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, Mapping) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _row_text(row: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _optional_url(row: Mapping[str, Any]) -> str | None:
    for key in ("url", "docUrl", "doc_url", "documentUrl", "document_url", "taskUrl", "task_url", "link"):
        value = str(row.get(key) or "").strip()
        if value.startswith(("http://", "https://")):
            return value
    return None


def _created_event_payload(
    repository: FollowUpRepository,
    company_id: str,
    follow_up_id: str,
) -> Mapping[str, Any]:
    for event in repository.list_events(company_id, follow_up_id):
        if event.event_type == "created":
            return event.payload_json
    return {}


def _follow_up_title(
    repository: FollowUpRepository,
    company_id: str,
    follow_up_id: str,
    follow_up: DivoFollowUp,
) -> str:
    created_payload = _created_event_payload(repository, company_id, follow_up_id)
    return str(created_payload.get("title") or follow_up.lark_task_guid).strip()


def _tracking_doc_title(title: str) -> str:
    clean = re.sub(r"\s+", " ", title).strip()
    return f"Divo Follow Up - {clean[:80]}"


def _tracking_doc_markdown(
    *,
    title: str,
    delegator: ResolvedFollowUpUser,
    assignee: ResolvedFollowUpUser,
    due_date: str,
    lark_task_guid: str,
) -> str:
    due_line = f"- Due: {due_date}\n" if due_date else ""
    return (
        f"# Divo Follow Up - {title}\n\n"
        "## Task Brief\n\n"
        f"- Task: {title}\n"
        f"- Manager: {delegator.display_name}\n"
        f"- Assignee: {assignee.display_name}\n"
        f"{due_line}"
        f"- Lark Task: {lark_task_guid}\n\n"
        "## Running Updates\n\n"
        "- Started in Dex. Progress checkpoints will be appended here.\n\n"
        "## Final Summary\n\n"
        "_Pending assignee approval._\n"
    )


def _tracking_doc_comment(tracking_doc: CreatedTrackingDoc) -> str:
    if tracking_doc.url:
        return f"Divo tracking doc: {tracking_doc.url}"
    return f"Divo tracking doc token: {tracking_doc.doc_token}"


def _started_manager_message(
    *,
    title: str,
    assignee: ResolvedFollowUpUser,
    tracking_doc: CreatedTrackingDoc,
    lark_task_guid: str,
) -> str:
    doc_ref = tracking_doc.url or tracking_doc.doc_token
    return (
        f"{assignee.display_name} has started: {title}\n"
        f"Lark task: {lark_task_guid}\n"
        f"Tracking doc: {doc_ref}"
    )


def _resumed_manager_message(
    *,
    title: str,
    assignee: ResolvedFollowUpUser,
    tracking_doc: CreatedTrackingDoc,
    lark_task_guid: str,
) -> str:
    doc_ref = tracking_doc.url or tracking_doc.doc_token
    return (
        f"{assignee.display_name} resumed: {title}\n"
        f"Lark task: {lark_task_guid}\n"
        f"Tracking doc: {doc_ref}"
    )


def _paused_manager_message(
    *,
    title: str,
    assignee: ResolvedFollowUpUser,
    reason: str | None,
) -> str:
    suffix = f"\nReason: {reason.strip()}" if reason and reason.strip() else ""
    return f"{assignee.display_name} paused: {title}{suffix}"


def _clean_checkpoint_note(note: str) -> str:
    clean = re.sub(r"\s+", " ", str(note or "")).strip()
    if not clean:
        raise FollowUpServiceError("progress note is required")
    return clean


def _progress_checkpoint_markdown(note: str) -> str:
    return f"## Progress Update\n\n{note.strip()}\n"


def _final_summary_markdown(summary: str) -> str:
    return f"## Final Summary\n\n{summary.strip()}\n"


def _done_manager_message(
    *,
    title: str,
    assignee: ResolvedFollowUpUser,
    summary: str,
    follow_up: DivoFollowUp,
) -> str:
    doc_ref = follow_up.tracking_doc_url or follow_up.tracking_doc_token
    doc_line = f"\nTracking doc: {doc_ref}" if doc_ref else ""
    return (
        f"{assignee.display_name} completed: {title}\n"
        f"Summary: {summary}"
        f"{doc_line}\n"
        f"Lark task: {follow_up.lark_task_guid}"
    )


_STRIP_TITLES_RE = re.compile(r"\b(mr|mrs|ms|miss|dr|prof|sir|ma'am|shri|smt)\b\.?", re.IGNORECASE)


def _normalize_person_name(value: str) -> str:
    without_title = _STRIP_TITLES_RE.sub("", str(value or "").lower())
    cleaned = re.sub(r"[^a-z0-9\s@._-]", "", without_title)
    return re.sub(r"\s+", " ", cleaned).strip()
