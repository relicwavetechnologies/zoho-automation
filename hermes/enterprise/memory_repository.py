"""Postgres-backed storage for curated agent memory.

Mirrors the repository shape of :mod:`enterprise.identity_repository` (`%s`
binding, `dict_row` results, the `_execute` / `_fetchone` / `_fetchall` /
`_row_get` helpers). Two buckets live in one table, distinguished by ``scope``:

  - ``personal`` — per-user, ``companyUserId`` set, auto-written by the agent.
  - ``company``  — shared, ``companyUserId IS NULL``, read-only to the agent in v1.

Mutations soft-delete (``deletedAt``) rather than hard-delete and write a row to
``HermesMemoryAudit`` so every change is queryable. There is no embedding column
in v1; semantic search is a later, company-bucket-only addition on this table.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from typing import Any


def _new_id() -> str:
    return str(uuid.uuid4())


class MemoryRepository:
    """CRUD + audit for ``HermesMemoryEntry`` scoped to a single company."""

    def __init__(self, connection: Any):
        self._connection = connection

    # -- Reads -------------------------------------------------------------

    def list_personal(self, company_id: str, company_user_id: str, kind: str) -> list[str]:
        """Return a user's live personal entries of one kind, oldest first."""
        rows = self._fetchall(
            """
            SELECT "content"
            FROM "HermesMemoryEntry"
            WHERE "companyId" = %s
              AND "companyUserId" = %s
              AND "scope" = 'personal'
              AND "kind" = %s
              AND "deletedAt" IS NULL
            ORDER BY "createdAt" ASC, "id" ASC
            """,
            (company_id, company_user_id, kind),
        )
        return [c for c in (self._row_get(row, "content") for row in rows) if c]

    def list_company(self, company_id: str, kind: str | None = None) -> list[str]:
        """Return the live shared company entries, oldest first."""
        if kind is None:
            rows = self._fetchall(
                """
                SELECT "content"
                FROM "HermesMemoryEntry"
                WHERE "companyId" = %s
                  AND "companyUserId" IS NULL
                  AND "scope" = 'company'
                  AND "deletedAt" IS NULL
                ORDER BY "createdAt" ASC, "id" ASC
                """,
                (company_id,),
            )
        else:
            rows = self._fetchall(
                """
                SELECT "content"
                FROM "HermesMemoryEntry"
                WHERE "companyId" = %s
                  AND "companyUserId" IS NULL
                  AND "scope" = 'company'
                  AND "kind" = %s
                  AND "deletedAt" IS NULL
                ORDER BY "createdAt" ASC, "id" ASC
                """,
                (company_id, kind),
            )
        return [c for c in (self._row_get(row, "content") for row in rows) if c]

    # -- Mutations (each writes an audit row) ------------------------------

    def add_entry(
        self,
        *,
        company_id: str,
        company_user_id: str | None,
        scope: str,
        kind: str,
        content: str,
        source: str = "auto",
        created_by: str | None = None,
    ) -> str | None:
        """Insert one entry. Returns its id, or None if a live duplicate exists."""
        entry_id = self._insert(
            company_id=company_id,
            company_user_id=company_user_id,
            scope=scope,
            kind=kind,
            content=content,
            source=source,
            created_by=created_by,
        )
        if entry_id is not None:
            self.log_audit(
                company_id=company_id,
                entry_id=entry_id,
                action="add",
                kind=kind,
                actor_user_id=created_by or company_user_id,
                after=content,
            )
        return entry_id

    def remove_entry(
        self,
        *,
        company_id: str,
        company_user_id: str | None,
        scope: str,
        kind: str,
        content: str,
    ) -> str | None:
        """Soft-delete the live entry matching ``content``. Returns its id or None."""
        entry_id = self._soft_delete(
            company_id=company_id,
            company_user_id=company_user_id,
            scope=scope,
            kind=kind,
            content=content,
        )
        if entry_id is not None:
            self.log_audit(
                company_id=company_id,
                entry_id=entry_id,
                action="remove",
                kind=kind,
                actor_user_id=company_user_id,
                before=content,
            )
        return entry_id

    def replace_entry(
        self,
        *,
        company_id: str,
        company_user_id: str | None,
        scope: str,
        kind: str,
        before: str,
        after: str,
        source: str = "auto",
        created_by: str | None = None,
    ) -> str | None:
        """Soft-delete ``before`` and insert ``after`` as one logical replace."""
        self._soft_delete(
            company_id=company_id,
            company_user_id=company_user_id,
            scope=scope,
            kind=kind,
            content=before,
        )
        new_id = self._insert(
            company_id=company_id,
            company_user_id=company_user_id,
            scope=scope,
            kind=kind,
            content=after,
            source=source,
            created_by=created_by,
        )
        self.log_audit(
            company_id=company_id,
            entry_id=new_id,
            action="replace",
            kind=kind,
            actor_user_id=created_by or company_user_id,
            before=before,
            after=after,
        )
        return new_id

    def log_audit(
        self,
        *,
        company_id: str,
        action: str,
        entry_id: str | None = None,
        kind: str | None = None,
        actor_user_id: str | None = None,
        before: str | None = None,
        after: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._execute(
            """
            INSERT INTO "HermesMemoryAudit"
                ("id", "companyId", "entryId", "action", "kind", "actorUserId", "before", "after", "metadata")
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            """,
            (
                _new_id(),
                company_id,
                entry_id,
                action,
                kind,
                actor_user_id,
                before,
                after,
                json.dumps(metadata or {}, sort_keys=True),
            ),
        )

    # -- Internal raw row ops (no audit) -----------------------------------

    def _insert(
        self,
        *,
        company_id: str,
        company_user_id: str | None,
        scope: str,
        kind: str,
        content: str,
        source: str,
        created_by: str | None,
    ) -> str | None:
        # ON CONFLICT DO NOTHING relies on the partial unique dedupe index;
        # RETURNING yields the new id, or nothing when a live duplicate exists.
        row = self._fetchone(
            """
            INSERT INTO "HermesMemoryEntry"
                ("id", "companyId", "companyUserId", "scope", "kind", "content", "source", "createdBy")
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            RETURNING "id"
            """,
            (_new_id(), company_id, company_user_id, scope, kind, content, source, created_by),
        )
        return self._row_get(row, "id")

    def _soft_delete(
        self,
        *,
        company_id: str,
        company_user_id: str | None,
        scope: str,
        kind: str,
        content: str,
    ) -> str | None:
        if company_user_id is None:
            row = self._fetchone(
                """
                UPDATE "HermesMemoryEntry"
                SET "deletedAt" = now(), "updatedAt" = now()
                WHERE "companyId" = %s
                  AND "companyUserId" IS NULL
                  AND "scope" = %s
                  AND "kind" = %s
                  AND md5("content") = md5(%s)
                  AND "deletedAt" IS NULL
                RETURNING "id"
                """,
                (company_id, scope, kind, content),
            )
        else:
            row = self._fetchone(
                """
                UPDATE "HermesMemoryEntry"
                SET "deletedAt" = now(), "updatedAt" = now()
                WHERE "companyId" = %s
                  AND "companyUserId" = %s
                  AND "scope" = %s
                  AND "kind" = %s
                  AND md5("content") = md5(%s)
                  AND "deletedAt" IS NULL
                RETURNING "id"
                """,
                (company_id, company_user_id, scope, kind, content),
            )
        return self._row_get(row, "id")

    # -- Connection helpers (mirrors EnterpriseIdentityRepository) ----------

    def _execute(self, sql: str, args: tuple[Any, ...]) -> None:
        result = self._connection.execute(sql, args)
        close = getattr(result, "close", None)
        if close is not None:
            close()

    def _fetchone(self, sql: str, args: tuple[Any, ...]) -> Any:
        result = self._connection.execute(sql, args)
        fetchone = getattr(result, "fetchone", None)
        if fetchone is None:
            return None
        try:
            return fetchone()
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()

    def _fetchall(self, sql: str, args: tuple[Any, ...]) -> list[Any]:
        result = self._connection.execute(sql, args)
        fetchall = getattr(result, "fetchall", None)
        if fetchall is None:
            return []
        try:
            rows = fetchall()
            return list(rows or [])
        finally:
            close = getattr(result, "close", None)
            if close is not None:
                close()

    @staticmethod
    def _row_get(row: Any, key: str) -> Any:
        if row is None:
            return None
        if isinstance(row, Mapping):
            return row.get(key)
        try:
            return row[key]
        except (KeyError, TypeError, IndexError):
            return None
