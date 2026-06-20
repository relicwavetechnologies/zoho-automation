#!/usr/bin/env python3
"""Opt-in live smoke harness for Divo Follow Ups create/lifecycle flows.

Default mode is side-effect-free and prints the request it would run. To create
real Lark Tasks/docs/DMs and persist Divo Follow Up rows/events, pass both:

    --mode live --yes-live
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

_WORKTREE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_WORKTREE_ROOT))


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
    follow_up_policy_json: dict[str, Any] | None = None


@dataclass(frozen=True)
class StartFollowUpRequest:
    company_id: str
    follow_up_id: str
    actor_company_user_id: str
    active_session_id: str


@dataclass(frozen=True)
class UpdateFollowUpDocRequest:
    company_id: str
    follow_up_id: str
    actor_company_user_id: str
    note: str


@dataclass(frozen=True)
class PauseFollowUpRequest:
    company_id: str
    follow_up_id: str
    actor_company_user_id: str
    reason: str | None = None


@dataclass(frozen=True)
class CompleteFollowUpRequest:
    company_id: str
    follow_up_id: str
    actor_company_user_id: str
    summary: str


get_enterprise_connection = None
FollowUpRepository = None
DivoFollowUpsService = None
CompanyIdentityFollowUpResolver = None
NativeToolFollowUpLarkGateway = None


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    request = _build_request(args)
    payload = _request_payload(request, mode=args.mode)
    payload["flow"] = args.flow
    if args.flow == "full":
        payload["lifecycle"] = _lifecycle_plan_payload(args)

    if args.mode != "live":
        print(json.dumps({"ok": True, "plan": payload}, indent=2, sort_keys=True))
        return 0

    if not args.yes_live:
        print(
            "Refusing to run live smoke without --yes-live. This can create real Lark Tasks, docs, and DMs.",
            file=sys.stderr,
        )
        return 2

    (
        get_connection,
        follow_up_repository,
        follow_ups_service,
        identity_resolver,
        lark_gateway,
    ) = _live_dependencies()
    connection = get_connection(force_new=True)
    service = follow_ups_service(
        repository=follow_up_repository(connection),
        identity_resolver=identity_resolver(),
        lark_gateway=lark_gateway(),
    )
    result = service.create_follow_up(request)
    output = {
        "ok": True,
        "mode": "live",
        "flow": args.flow,
        "create": _create_result_payload(result),
    }
    if args.flow == "full":
        output["lifecycle"] = _run_full_lifecycle(service, result, args)
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("plan", "live"),
        default=os.getenv("HERMES_FOLLOW_UP_SMOKE_MODE", "plan"),
        help="plan prints the create request without side effects; live creates the Lark Task.",
    )
    parser.add_argument(
        "--yes-live",
        action="store_true",
        help="Required with --mode live because live mode creates a real Lark Task.",
    )
    parser.add_argument(
        "--flow",
        choices=("create", "full"),
        default=os.getenv("HERMES_FOLLOW_UP_SMOKE_FLOW", "create"),
        help="create stops after Lark Task creation; full runs start/update/pause/resume/complete.",
    )
    parser.add_argument(
        "--company-id",
        default=_env("HERMES_FOLLOW_UP_COMPANY_ID", "HERMES_COMPANY_ID", "COMPANY_ID"),
        required=not bool(_env("HERMES_FOLLOW_UP_COMPANY_ID", "HERMES_COMPANY_ID", "COMPANY_ID")),
    )
    parser.add_argument(
        "--manager-company-user-id",
        default=_env("HERMES_FOLLOW_UP_MANAGER_COMPANY_USER_ID", "HERMES_COMPANY_USER_ID"),
        required=not bool(_env("HERMES_FOLLOW_UP_MANAGER_COMPANY_USER_ID", "HERMES_COMPANY_USER_ID")),
    )
    assignee = parser.add_mutually_exclusive_group(required=not bool(_default_assignee()))
    assignee.add_argument(
        "--assignee-company-user-id",
        default=os.getenv("HERMES_FOLLOW_UP_ASSIGNEE_COMPANY_USER_ID", "").strip() or None,
    )
    assignee.add_argument(
        "--assignee-query",
        default=os.getenv("HERMES_FOLLOW_UP_ASSIGNEE_QUERY", "").strip() or None,
        help='Example: "Anish Suman" or "Suman".',
    )
    parser.add_argument(
        "--title",
        default=os.getenv(
            "HERMES_FOLLOW_UP_TITLE",
            "Divo Follow Ups live smoke - create flow",
        ),
    )
    parser.add_argument(
        "--due-date",
        default=os.getenv("HERMES_FOLLOW_UP_DUE_DATE", "").strip() or _tomorrow_noon_utc(),
        help="ISO timestamp accepted by lark_task.create.",
    )
    parser.add_argument(
        "--notes",
        default=os.getenv(
            "HERMES_FOLLOW_UP_NOTES",
            "Created by scripts/follow_up_create_smoke.py for Divo Follow Ups FU-104.",
        ),
    )
    parser.add_argument(
        "--source-session-id",
        default=os.getenv("HERMES_FOLLOW_UP_SOURCE_SESSION_ID", "follow-up-live-smoke"),
    )
    parser.add_argument(
        "--active-session-id",
        default=os.getenv("HERMES_FOLLOW_UP_ACTIVE_SESSION_ID", "follow-up-live-smoke-active-1"),
    )
    parser.add_argument(
        "--resume-session-id",
        default=os.getenv("HERMES_FOLLOW_UP_RESUME_SESSION_ID", "follow-up-live-smoke-active-2"),
    )
    parser.add_argument(
        "--checkpoint-note",
        default=os.getenv(
            "HERMES_FOLLOW_UP_CHECKPOINT_NOTE",
            "Live smoke checkpoint: Divo appended this progress update from the harness.",
        ),
    )
    parser.add_argument(
        "--pause-reason",
        default=os.getenv(
            "HERMES_FOLLOW_UP_PAUSE_REASON",
            "Live smoke pause/resume validation.",
        ),
    )
    parser.add_argument(
        "--completion-summary",
        default=os.getenv(
            "HERMES_FOLLOW_UP_COMPLETION_SUMMARY",
            "Live smoke completed the follow-up lifecycle successfully.",
        ),
    )
    parser.add_argument(
        "--policy-preset",
        choices=("start-pause-done", "start-done", "only-done"),
        default=os.getenv("HERMES_FOLLOW_UP_POLICY_PRESET", "start-pause-done"),
    )
    return parser.parse_args(argv)


def _build_request(args: argparse.Namespace) -> CreateFollowUpRequest:
    return CreateFollowUpRequest(
        company_id=args.company_id,
        delegator_company_user_id=args.manager_company_user_id,
        assignee_company_user_id=args.assignee_company_user_id,
        assignee_query=args.assignee_query,
        title=args.title,
        due_date=args.due_date,
        notes=args.notes,
        source_session_id=args.source_session_id,
        follow_up_policy_json=_policy_for_preset(args.policy_preset),
    )


def _policy_for_preset(preset: str) -> dict[str, Any]:
    if preset == "start-done":
        return {"notify_on_start": True, "notify_on_pause": False, "notify_on_done": True}
    if preset == "only-done":
        return {"notify_on_start": False, "notify_on_pause": False, "notify_on_done": True}
    return {"notify_on_start": True, "notify_on_pause": True, "notify_on_done": True}


def _request_payload(request: CreateFollowUpRequest, *, mode: str) -> dict[str, Any]:
    return {
        "mode": mode,
        "company_id": request.company_id,
        "delegator_company_user_id": request.delegator_company_user_id,
        "assignee_company_user_id": request.assignee_company_user_id,
        "assignee_query": request.assignee_query,
        "title": request.title,
        "due_date": request.due_date,
        "notes": request.notes,
        "source_session_id": request.source_session_id,
        "follow_up_policy_json": dict(request.follow_up_policy_json or {}),
    }


def _lifecycle_plan_payload(args: argparse.Namespace) -> dict[str, str]:
    return {
        "active_session_id": args.active_session_id,
        "checkpoint_note": args.checkpoint_note,
        "pause_reason": args.pause_reason,
        "resume_session_id": args.resume_session_id,
        "completion_summary": args.completion_summary,
    }


def _create_result_payload(result: Any) -> dict[str, Any]:
    return {
        "follow_up": _follow_up_payload(result.follow_up),
        "lark_task": {
            "task_guid": result.lark_task.task_guid,
            "title": result.lark_task.title,
            "url": result.lark_task.url,
        },
        "delegator": _user_payload(result.delegator),
        "assignee": _user_payload(result.assignee),
    }


def _live_dependencies():
    get_connection = globals().get("get_enterprise_connection")
    follow_up_repository = globals().get("FollowUpRepository")
    follow_ups_service = globals().get("DivoFollowUpsService")
    identity_resolver = globals().get("CompanyIdentityFollowUpResolver")
    lark_gateway = globals().get("NativeToolFollowUpLarkGateway")
    if not all((get_connection, follow_up_repository, follow_ups_service, identity_resolver, lark_gateway)):
        from enterprise.db import get_enterprise_connection as get_connection
        from enterprise.follow_up_repository import FollowUpRepository as follow_up_repository
        from enterprise.follow_ups.service import (
            CompanyIdentityFollowUpResolver as identity_resolver,
            DivoFollowUpsService as follow_ups_service,
            NativeToolFollowUpLarkGateway as lark_gateway,
        )
    return get_connection, follow_up_repository, follow_ups_service, identity_resolver, lark_gateway


def _run_full_lifecycle(service: Any, create_result: Any, args: argparse.Namespace) -> dict[str, Any]:
    follow_up = create_result.follow_up
    company_id = follow_up.company_id
    follow_up_id = follow_up.id
    actor_id = follow_up.assignee_company_user_id

    started = service.start_follow_up(
        StartFollowUpRequest(
            company_id=company_id,
            follow_up_id=follow_up_id,
            actor_company_user_id=actor_id,
            active_session_id=args.active_session_id,
        )
    )
    checkpoint = service.update_tracking_doc_checkpoint(
        UpdateFollowUpDocRequest(
            company_id=company_id,
            follow_up_id=follow_up_id,
            actor_company_user_id=actor_id,
            note=args.checkpoint_note,
        )
    )
    paused = service.pause_follow_up(
        PauseFollowUpRequest(
            company_id=company_id,
            follow_up_id=follow_up_id,
            actor_company_user_id=actor_id,
            reason=args.pause_reason,
        )
    )
    resumed = service.start_follow_up(
        StartFollowUpRequest(
            company_id=company_id,
            follow_up_id=follow_up_id,
            actor_company_user_id=actor_id,
            active_session_id=args.resume_session_id,
        )
    )
    completed = service.complete_follow_up(
        CompleteFollowUpRequest(
            company_id=company_id,
            follow_up_id=follow_up_id,
            actor_company_user_id=actor_id,
            summary=args.completion_summary,
        )
    )
    return {
        "started": {
            "follow_up": _follow_up_payload(started.follow_up),
            "tracking_doc": _tracking_doc_payload(started.tracking_doc),
            "manager_message_id": started.manager_message_id,
        },
        "checkpoint": {
            "follow_up": _follow_up_payload(checkpoint.follow_up),
        },
        "paused": {
            "follow_up": _follow_up_payload(paused.follow_up),
            "manager_message_id": paused.manager_message_id,
        },
        "resumed": {
            "follow_up": _follow_up_payload(resumed.follow_up),
            "tracking_doc": _tracking_doc_payload(resumed.tracking_doc),
            "manager_message_id": resumed.manager_message_id,
        },
        "completed": {
            "follow_up": _follow_up_payload(completed.follow_up),
            "manager_message_id": completed.manager_message_id,
        },
    }


def _follow_up_payload(follow_up: Any) -> dict[str, Any]:
    return {
        "id": follow_up.id,
        "company_id": follow_up.company_id,
        "status": follow_up.status,
        "lark_task_guid": follow_up.lark_task_guid,
        "delegator_company_user_id": follow_up.delegator_company_user_id,
        "assignee_company_user_id": follow_up.assignee_company_user_id,
        "active_session_id": follow_up.active_session_id,
        "tracking_doc_token": follow_up.tracking_doc_token,
        "tracking_doc_url": follow_up.tracking_doc_url,
        "summary": follow_up.summary,
    }


def _tracking_doc_payload(tracking_doc: Any) -> dict[str, str | None]:
    return {
        "doc_token": tracking_doc.doc_token,
        "title": tracking_doc.title,
        "url": tracking_doc.url,
    }


def _user_payload(user: Any) -> dict[str, str | None]:
    return {
        "company_user_id": user.company_user_id,
        "display_name": user.display_name,
        "email": user.email,
        "lark_open_id": user.lark_open_id,
    }


def _default_assignee() -> str:
    return _env("HERMES_FOLLOW_UP_ASSIGNEE_COMPANY_USER_ID", "HERMES_FOLLOW_UP_ASSIGNEE_QUERY")


def _env(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _tomorrow_noon_utc() -> str:
    tomorrow = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0) + timedelta(days=1)
    return tomorrow.isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    raise SystemExit(main())
