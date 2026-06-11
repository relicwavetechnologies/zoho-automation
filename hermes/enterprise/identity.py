"""Enterprise identity envelope carried into every runtime turn."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


def _first_text(mapping: Mapping[str, Any], *keys: str, default: str = "") -> str:
    for key in keys:
        value = mapping.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return default


@dataclass(frozen=True)
class EnterpriseIdentityEnvelope:
    """Company-aware identity attached to a run request.

    The runtime accepts both snake_case and camelCase field names so Python
    gateway callers and TypeScript clients can share one contract.
    """

    company_id: str = ""
    company_user_id: str = ""
    channel_identity_id: str = ""
    company_role: str = ""
    department_id: str = ""
    session_key: str = ""

    @classmethod
    def from_mapping(
        cls,
        mapping: Mapping[str, Any],
        *,
        session_key: str = "",
    ) -> "EnterpriseIdentityEnvelope":
        return cls(
            company_id=_first_text(mapping, "company_id", "companyId"),
            company_user_id=_first_text(mapping, "company_user_id", "companyUserId"),
            channel_identity_id=_first_text(mapping, "channel_identity_id", "channelIdentityId"),
            company_role=_first_text(mapping, "company_role", "companyRole"),
            department_id=_first_text(mapping, "department_id", "departmentId"),
            session_key=_first_text(mapping, "session_key", "sessionKey", default=session_key),
        )

    def session_vars(self) -> dict[str, str]:
        return {
            "company_id": self.company_id,
            "company_user_id": self.company_user_id,
            "channel_identity_id": self.channel_identity_id,
            "company_role": self.company_role,
            "department_id": self.department_id,
        }

    def as_event_payload(self) -> dict[str, str]:
        return {
            "company_id": self.company_id,
            "company_user_id": self.company_user_id,
            "channel_identity_id": self.channel_identity_id,
            "company_role": self.company_role,
            "department_id": self.department_id,
            "session_key": self.session_key,
        }

    @classmethod
    def from_session_entry(
        cls,
        entry: Any,
        *,
        session_key: str = "",
    ) -> "EnterpriseIdentityEnvelope":
        """Build an envelope from a resolved SessionEntry.

        Normalisation point so Feishu, desktop, and API channels all feed the
        same shape into ``set_session_vars()`` without duplicating field mapping
        logic.  ``session_key`` overrides the entry's own key when the caller
        needs a stable per-channel key that differs from ``entry.session_key``.
        """
        return cls(
            company_id=str(entry.company_id or ""),
            company_user_id=str(entry.company_user_id or ""),
            channel_identity_id=str(entry.channel_identity_id or ""),
            company_role=str(entry.company_role or ""),
            department_id=str(entry.department_id or ""),
            session_key=session_key or str(entry.session_key or ""),
        )
