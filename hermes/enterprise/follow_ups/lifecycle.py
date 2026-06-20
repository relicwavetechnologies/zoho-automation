"""Lifecycle status constants and transition rules for Divo Follow Ups."""

from __future__ import annotations

from typing import Final

FOLLOW_UP_STATUSES: Final[frozenset[str]] = frozenset(
    {
        "assigned",
        "starting",
        "active",
        "paused",
        "reassigned",
        "done",
        "deleted",
    }
)

TERMINAL_STATUSES: Final[frozenset[str]] = frozenset({"done", "deleted"})

ALLOWED_TRANSITIONS: Final[dict[str, frozenset[str]]] = {
    "assigned": frozenset({"starting", "reassigned", "deleted"}),
    "starting": frozenset({"active", "assigned", "deleted"}),
    "active": frozenset({"paused", "done", "reassigned", "deleted"}),
    "paused": frozenset({"active", "done", "reassigned", "deleted"}),
    "reassigned": frozenset({"assigned"}),
    "done": frozenset(),
    "deleted": frozenset(),
}


class FollowUpLifecycleError(ValueError):
    """Raised when a follow-up status transition is not allowed."""


def is_terminal(status: str) -> bool:
    return status in TERMINAL_STATUSES


def validate_transition(current: str, target: str) -> None:
    if current not in FOLLOW_UP_STATUSES:
        raise FollowUpLifecycleError(f"Unknown follow-up status: {current!r}")
    if target not in FOLLOW_UP_STATUSES:
        raise FollowUpLifecycleError(f"Unknown follow-up status: {target!r}")
    if current == target:
        raise FollowUpLifecycleError(f"Follow-up is already in status {current!r}")
    allowed = ALLOWED_TRANSITIONS.get(current, frozenset())
    if target not in allowed:
        raise FollowUpLifecycleError(
            f"Cannot transition follow-up from {current!r} to {target!r}"
        )
