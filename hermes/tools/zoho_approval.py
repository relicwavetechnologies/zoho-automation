"""Business-action approval helpers for Zoho write operations."""

from __future__ import annotations

from typing import Any

from utils import env_var_enabled


def require_zoho_write_approval(
    *,
    pattern_key: str,
    action: str,
    description: str,
    approval_callback=None,
) -> dict[str, Any]:
    """Require user approval for a Zoho write action when Hermes can ask.

    Hermes currently exposes approval primitives for terminal/code actions.
    This helper reuses the same per-session approval queue, hooks, slash
    commands, and CLI prompt machinery for enterprise connector writes.
    """
    import tools.approval as approval

    session_key = approval.get_current_session_key()
    if approval.is_approved(session_key, pattern_key):
        return {"approved": True, "message": None, "approval": "session"}

    if (
        approval._YOLO_MODE_FROZEN
        or approval.is_current_session_yolo_enabled()
        or approval._get_approval_mode() == "off"
    ):
        return {"approved": True, "message": None, "approval": "bypass"}

    is_cli = env_var_enabled("HERMES_INTERACTIVE")
    is_gateway = approval._is_gateway_approval_context()
    is_ask = env_var_enabled("HERMES_EXEC_ASK")

    if not is_cli and not is_gateway and not is_ask:
        if env_var_enabled("HERMES_CRON_SESSION") and approval._get_cron_approval_mode() == "deny":
            return {
                "approved": False,
                "status": "blocked",
                "message": (
                    f"BLOCKED: Zoho write action '{action}' requires user approval, "
                    "but cron jobs run without a user present to approve it."
                ),
                "pattern_key": pattern_key,
                "description": description,
            }
        return {
            "approved": True,
            "message": None,
            "approval": "non_interactive_auto_approved",
        }

    if is_gateway or is_ask:
        notify_cb = None
        with approval._lock:
            notify_cb = approval._gateway_notify_cbs.get(session_key)

        approval_data = {
            "command": action,
            "pattern_key": pattern_key,
            "pattern_keys": [pattern_key],
            "description": description,
        }

        if notify_cb is None:
            approval.submit_pending(session_key, approval_data)
            return {
                "approved": False,
                "status": "pending_approval",
                "approval_pending": True,
                "message": (
                    f"Approval required for Zoho write action: {description}. "
                    "Reply `/approve` to execute or `/deny` to cancel."
                ),
                "pattern_key": pattern_key,
                "description": description,
            }

        decision = approval._await_gateway_decision(
            session_key,
            notify_cb,
            approval_data,
            surface="gateway",
        )
        if decision.get("notify_failed"):
            return {
                "approved": False,
                "message": "BLOCKED: Failed to send Zoho approval request to user.",
                "pattern_key": pattern_key,
                "description": description,
            }
        choice = decision.get("choice")
        if not decision.get("resolved") or choice is None or choice == "deny":
            return {
                "approved": False,
                "message": (
                    "BLOCKED: User did not approve this Zoho write action. "
                    "Do NOT retry or attempt the same action another way."
                ),
                "pattern_key": pattern_key,
                "description": description,
                "outcome": "timeout" if not decision.get("resolved") else "denied",
                "user_consent": False,
            }
        if choice in {"session", "always"}:
            approval.approve_session(session_key, pattern_key)
        if choice == "always":
            approval.approve_permanent(pattern_key)
            approval.save_permanent_allowlist(approval._permanent_approved)
        return {
            "approved": True,
            "message": None,
            "approval": "user_approved",
            "choice": choice,
        }

    approval._fire_approval_hook(
        "pre_approval_request",
        command=action,
        description=description,
        pattern_key=pattern_key,
        pattern_keys=[pattern_key],
        session_key=session_key,
        surface="cli",
    )
    callback = approval_callback
    if callback is None:
        try:
            from tools.terminal_tool import _get_approval_callback

            callback = _get_approval_callback()
        except Exception:
            callback = None
    choice = approval.prompt_dangerous_approval(
        action,
        description,
        allow_permanent=True,
        approval_callback=callback,
    )
    approval._fire_approval_hook(
        "post_approval_response",
        command=action,
        description=description,
        pattern_key=pattern_key,
        pattern_keys=[pattern_key],
        session_key=session_key,
        surface="cli",
        choice=choice,
    )
    if choice == "deny":
        return {
            "approved": False,
            "message": (
                "BLOCKED: User denied this Zoho write action. The user has NOT "
                "consented to this action."
            ),
            "pattern_key": pattern_key,
            "description": description,
            "outcome": "denied",
            "user_consent": False,
        }
    if choice in {"session", "always"}:
        approval.approve_session(session_key, pattern_key)
    if choice == "always":
        approval.approve_permanent(pattern_key)
        approval.save_permanent_allowlist(approval._permanent_approved)
    return {
        "approved": True,
        "message": None,
        "approval": "user_approved",
        "choice": choice,
    }
