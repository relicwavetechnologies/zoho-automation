"""Local policy state for Hermes RBAC/ABAC decisions.

The database migration creates first-class policy tables for production.  This
repository also keeps a small JSON fallback under ``HERMES_HOME`` so the
dashboard can manage policy locally before Postgres migrations are applied.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from .models import PolicyPrincipal, PolicyResource


POLICY_BINDING_EFFECTS = frozenset({"permit", "forbid", "approval"})
POLICY_BINDING_PRINCIPALS = frozenset({"any", "role", "company_user", "department"})


@dataclass(frozen=True)
class PolicyBinding:
    id: str
    company_id: str
    principal_type: str
    principal_id: str
    resource_type: str
    resource_id: str
    action: str
    effect: str = "permit"
    context: Mapping[str, Any] = field(default_factory=dict)
    status: str = "active"
    created_at: str = ""
    updated_at: str = ""

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "PolicyBinding":
        principal_type = _normalize_principal_type(value.get("principal_type") or value.get("principalType"))
        effect = _normalize_effect(value.get("effect"))
        now = _now()
        return cls(
            id=_text(value.get("id")),
            company_id=_text(value.get("company_id") or value.get("companyId")),
            principal_type=principal_type,
            principal_id=_normalize_principal_id(
                principal_type,
                value.get("principal_id") or value.get("principalId"),
            ),
            resource_type=_normalize_resource_type(value.get("resource_type") or value.get("resourceType")),
            resource_id=_normalize_resource_id(value.get("resource_id") or value.get("resourceId")),
            action=_normalize_action(value.get("action")),
            effect=effect,
            context=_context_mapping(value.get("context") or value.get("context_json") or value.get("contextJson")),
            status=_text(value.get("status") or "active").lower() or "active",
            created_at=_text(value.get("created_at") or value.get("createdAt")) or now,
            updated_at=_text(value.get("updated_at") or value.get("updatedAt")) or now,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "company_id": self.company_id,
            "principal_type": self.principal_type,
            "principal_id": self.principal_id,
            "resource_type": self.resource_type,
            "resource_id": self.resource_id,
            "action": self.action,
            "effect": self.effect,
            "context": dict(self.context),
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class PolicyRepository:
    """Policy binding store with DB-first and JSON fallback behavior."""

    def __init__(self, connection: Any | None = None, *, store_path: Path | None = None):
        self._connection = connection
        self._store_path = store_path or _default_policy_store_path()

    def list_bindings(self, *, company_id: str, include_inactive: bool = False) -> list[PolicyBinding]:
        company_id = _text(company_id)
        if not company_id:
            return []
        if self._connection is not None:
            try:
                return self._list_bindings_db(company_id=company_id, include_inactive=include_inactive)
            except Exception:
                pass
        return self._list_bindings_json(company_id=company_id, include_inactive=include_inactive)

    def put_binding(self, *, company_id: str, binding: Mapping[str, Any]) -> PolicyBinding:
        company_id = _text(company_id)
        if not company_id:
            raise ValueError("company_id is required")
        data = dict(binding)
        data["company_id"] = company_id
        candidate = PolicyBinding.from_mapping(data)
        if not candidate.principal_id:
            raise ValueError("principal_id is required")
        if not candidate.resource_type:
            raise ValueError("resource_type is required")
        if not candidate.resource_id:
            raise ValueError("resource_id is required")
        if not candidate.action:
            raise ValueError("action is required")
        now = _now()
        if not candidate.id:
            candidate = PolicyBinding.from_mapping({
                **candidate.to_dict(),
                "id": _stable_binding_id(candidate),
                "created_at": now,
                "updated_at": now,
            })
        else:
            candidate = PolicyBinding.from_mapping({
                **candidate.to_dict(),
                "updated_at": now,
            })
        if self._connection is not None:
            try:
                self._put_binding_db(candidate)
                return candidate
            except Exception:
                pass
        self._put_binding_json(candidate)
        return candidate

    def delete_binding(self, *, company_id: str, binding_id: str) -> bool:
        company_id = _text(company_id)
        binding_id = _text(binding_id)
        if not company_id or not binding_id:
            return False
        if self._connection is not None:
            try:
                deleted = self._delete_binding_db(company_id=company_id, binding_id=binding_id)
                if deleted:
                    return True
            except Exception:
                pass
        return self._delete_binding_json(company_id=company_id, binding_id=binding_id)

    def _list_bindings_db(self, *, company_id: str, include_inactive: bool) -> list[PolicyBinding]:
        status_filter = "" if include_inactive else "AND COALESCE(\"status\", 'active') = 'active'"
        rows = self._fetchall(
            f"""
            SELECT
                "id",
                "companyId",
                "principalType",
                "principalId",
                "resourceType",
                "resourceId",
                "action",
                "effect",
                "contextJson",
                "status",
                "createdAt",
                "updatedAt"
            FROM "PolicyBinding"
            WHERE "companyId" = %s
              {status_filter}
            ORDER BY "updatedAt" DESC, "id" ASC
            """,
            (company_id,),
        )
        return [PolicyBinding.from_mapping(_row_to_mapping(row)) for row in rows]

    def _put_binding_db(self, binding: PolicyBinding) -> None:
        self._execute(
            """
            INSERT INTO "PolicyBinding" (
                "id",
                "companyId",
                "templateId",
                "principalType",
                "principalId",
                "resourceType",
                "resourceId",
                "action",
                "effect",
                "contextJson",
                "status",
                "createdAt",
                "updatedAt"
            )
            VALUES (%s, %s, 'adhoc', %s, %s, %s, %s, %s, %s, %s::jsonb, %s, now(), now())
            ON CONFLICT ("id") DO UPDATE SET
                "principalType" = excluded."principalType",
                "principalId" = excluded."principalId",
                "resourceType" = excluded."resourceType",
                "resourceId" = excluded."resourceId",
                "action" = excluded."action",
                "effect" = excluded."effect",
                "contextJson" = excluded."contextJson",
                "status" = excluded."status",
                "updatedAt" = now()
            """,
            (
                binding.id,
                binding.company_id,
                binding.principal_type,
                binding.principal_id,
                binding.resource_type,
                binding.resource_id,
                binding.action,
                binding.effect,
                json.dumps(dict(binding.context), sort_keys=True, separators=(",", ":")),
                binding.status,
            ),
        )

    def _delete_binding_db(self, *, company_id: str, binding_id: str) -> bool:
        rowcount = self._execute_rowcount(
            """
            UPDATE "PolicyBinding"
            SET "status" = 'deleted',
                "updatedAt" = now()
            WHERE "companyId" = %s AND "id" = %s AND COALESCE("status", 'active') = 'active'
            """,
            (company_id, binding_id),
        )
        return rowcount > 0

    def _list_bindings_json(self, *, company_id: str, include_inactive: bool) -> list[PolicyBinding]:
        payload = self._read_json_store()
        bindings = [
            PolicyBinding.from_mapping(item)
            for item in payload.get("bindings", [])
            if isinstance(item, Mapping) and _text(item.get("company_id") or item.get("companyId")) == company_id
        ]
        if not include_inactive:
            bindings = [binding for binding in bindings if binding.status == "active"]
        return sorted(bindings, key=lambda item: (item.updated_at, item.id), reverse=True)

    def _put_binding_json(self, binding: PolicyBinding) -> None:
        payload = self._read_json_store()
        rows = [item for item in payload.get("bindings", []) if isinstance(item, Mapping)]
        replaced = False
        next_rows: list[dict[str, Any]] = []
        for item in rows:
            if _text(item.get("id")) == binding.id:
                existing = PolicyBinding.from_mapping(item)
                next_rows.append({
                    **binding.to_dict(),
                    "created_at": existing.created_at or binding.created_at,
                })
                replaced = True
            else:
                next_rows.append(dict(item))
        if not replaced:
            next_rows.append(binding.to_dict())
        payload["bindings"] = next_rows
        self._write_json_store(payload)

    def _delete_binding_json(self, *, company_id: str, binding_id: str) -> bool:
        payload = self._read_json_store()
        rows = [item for item in payload.get("bindings", []) if isinstance(item, Mapping)]
        next_rows: list[dict[str, Any]] = []
        deleted = False
        for item in rows:
            if (
                _text(item.get("id")) == binding_id
                and _text(item.get("company_id") or item.get("companyId")) == company_id
                and _text(item.get("status") or "active").lower() == "active"
            ):
                next_rows.append({
                    **dict(item),
                    "status": "deleted",
                    "updated_at": _now(),
                })
                deleted = True
            else:
                next_rows.append(dict(item))
        payload["bindings"] = next_rows
        self._write_json_store(payload)
        return deleted

    def _read_json_store(self) -> dict[str, Any]:
        try:
            raw = self._store_path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except Exception:
            return {"bindings": []}
        if not isinstance(data, dict):
            return {"bindings": []}
        bindings = data.get("bindings")
        if not isinstance(bindings, list):
            data["bindings"] = []
        return data

    def _write_json_store(self, payload: Mapping[str, Any]) -> None:
        self._store_path.parent.mkdir(parents=True, exist_ok=True)
        self._store_path.write_text(
            json.dumps(dict(payload), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def _fetchall(self, sql: str, args: tuple[Any, ...]) -> list[Any]:
        result = self._connection.execute(sql, args)
        fetchall = getattr(result, "fetchall", None)
        if fetchall is None:
            return []
        try:
            return list(fetchall() or [])
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()

    def _execute(self, sql: str, args: tuple[Any, ...]) -> None:
        result = self._connection.execute(sql, args)
        close = getattr(result, "close", None)
        if close is not None:
            close()

    def _execute_rowcount(self, sql: str, args: tuple[Any, ...]) -> int:
        result = self._connection.execute(sql, args)
        rowcount = int(getattr(result, "rowcount", 0) or 0)
        close = getattr(result, "close", None)
        if close is not None:
            close()
        return rowcount


def get_policy_repository(connection: Any | None = None) -> PolicyRepository:
    return PolicyRepository(connection)


def load_company_policy_bindings(company_id: str) -> list[PolicyBinding]:
    return get_policy_repository().list_bindings(company_id=company_id)


def matching_policy_bindings(
    *,
    principal: PolicyPrincipal,
    action: str,
    resource: PolicyResource,
    bindings: list[PolicyBinding] | None = None,
) -> list[PolicyBinding]:
    candidates = bindings if bindings is not None else load_company_policy_bindings(principal.company_id)
    return [
        binding
        for binding in candidates
        if binding.status == "active"
        and binding.company_id == principal.company_id
        and _principal_matches(binding, principal)
        and _resource_matches(binding, resource)
        and _action_matches(binding, action, resource)
    ]


def _principal_matches(binding: PolicyBinding, principal: PolicyPrincipal) -> bool:
    if binding.principal_type == "any":
        return binding.principal_id in {"*", "any"}
    if binding.principal_type == "role":
        return binding.principal_id.upper() == principal.role.upper()
    if binding.principal_type == "company_user":
        return binding.principal_id == principal.company_user_id
    if binding.principal_type == "department":
        return binding.principal_id.lower() == principal.department_id.lower()
    return False


def _resource_matches(binding: PolicyBinding, resource: PolicyResource) -> bool:
    if binding.resource_type not in {"*", resource.type}:
        return False
    resource_id = _normalize_resource_id(resource.id)
    return binding.resource_id in {"*", resource_id, f"{resource.type}:{resource_id}"}


def _action_matches(binding: PolicyBinding, action: str, resource: PolicyResource) -> bool:
    normalized = _normalize_action(action)
    if binding.action in {"*", normalized}:
        return True
    if resource.type in {"Tool", "Connector", "DataScope"} and binding.action == "execute":
        return True
    return False


def _default_policy_store_path() -> Path:
    try:
        from hermes_constants import get_hermes_home

        root = get_hermes_home()
    except Exception:
        root = Path.home() / ".hermes"
    return root / "policy_store.json"


def _stable_binding_id(binding: PolicyBinding) -> str:
    seed = "\x1f".join(
        (
            binding.company_id,
            binding.principal_type,
            binding.principal_id,
            binding.resource_type,
            binding.resource_id,
            binding.action,
            binding.effect,
        )
    )
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
    return f"pb_{digest}"


def _normalize_principal_type(value: Any) -> str:
    text = _text(value).lower().replace("-", "_")
    if text in {"user", "companyuser", "company_user"}:
        text = "company_user"
    if text not in POLICY_BINDING_PRINCIPALS:
        raise ValueError(f"Unsupported principal_type {value!r}")
    return text


def _normalize_principal_id(principal_type: str, value: Any) -> str:
    text = _text(value)
    if principal_type == "role":
        return text.upper()
    if principal_type == "department":
        return text.lower()
    if principal_type == "any":
        return text or "*"
    return text


def _normalize_effect(value: Any) -> str:
    text = _text(value or "permit").lower()
    if text in {"allow", "allowed"}:
        text = "permit"
    if text in {"deny", "denied"}:
        text = "forbid"
    if text in {"needs_approval", "approval_required"}:
        text = "approval"
    if text not in POLICY_BINDING_EFFECTS:
        raise ValueError(f"Unsupported effect {value!r}")
    return text


def _normalize_resource_type(value: Any) -> str:
    return _text(value).replace(" ", "")


def _normalize_resource_id(value: Any) -> str:
    text = _text(value)
    if ":" in text:
        text = text.split(":", 1)[1]
    return text


def _normalize_action(value: Any) -> str:
    return _text(value or "*").lower() or "*"


def _context_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, Mapping):
            return dict(parsed)
    return {}


def _row_to_mapping(row: Any) -> Mapping[str, Any]:
    if isinstance(row, Mapping):
        return row
    return {
        key: _row_get(row, key)
        for key in (
            "id",
            "companyId",
            "principalType",
            "principalId",
            "resourceType",
            "resourceId",
            "action",
            "effect",
            "contextJson",
            "status",
            "createdAt",
            "updatedAt",
        )
    }


def _row_get(row: Any, key: str) -> Any:
    if row is None:
        return None
    try:
        return row[key]
    except (KeyError, TypeError, IndexError):
        return None


def _text(value: Any) -> str:
    return str(value or "").strip()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
