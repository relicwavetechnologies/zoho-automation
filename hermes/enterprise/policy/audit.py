"""Local audit trail for Hermes policy decisions."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
from pathlib import Path
from typing import Any, Mapping

logger = logging.getLogger(__name__)


def _audit_path() -> Path:
    try:
        from hermes_constants import get_hermes_home

        root = get_hermes_home()
    except Exception:
        root = Path.home() / ".hermes"
    return root / "policy_decisions.jsonl"


def write_policy_audit(event: Mapping[str, Any]) -> None:
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **dict(event),
    }
    path = _audit_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
    except Exception as exc:  # noqa: BLE001 - auth must never fail because audit IO failed
        logger.debug("failed to write policy audit event: %s", exc)


def read_recent_policy_audit(limit: int = 100) -> list[dict[str, Any]]:
    path = _audit_path()
    if not path.exists():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    events: list[dict[str, Any]] = []
    for line in lines[-max(1, int(limit)):]:
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            events.append(data)
    return events
