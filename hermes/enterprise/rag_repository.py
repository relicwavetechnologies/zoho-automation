"""Postgres + pgvector storage for RAG document chunks (Hermes-owned).

Mirrors the repository shape of :mod:`enterprise.memory_repository` (`%s` binding,
`dict_row` rows, `_execute`/`_fetchall` helpers). All retrieval data lives in the
Postgres Hermes already owns — there is no dependency on advance-backend's Qdrant.

Cosine similarity uses pgvector's ``<=>`` over a ``halfvec(3072)`` cast (the only
index type that supports 3072-d vectors); ``score = 1 - distance``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Optional

# zoho/chat source types are exempt from the file allowedRoles gate (legacy parity).
_ROLE_EXEMPT_SOURCE_TYPES = (
    "zoho_lead", "zoho_contact", "zoho_account", "zoho_deal", "zoho_ticket", "chat_turn",
)


def _vec_literal(vec: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


class RagChunkRepository:
    """CRUD + vector search for ``HermesRagChunk`` scoped to a company."""

    def __init__(self, connection: Any):
        self._connection = connection

    # -- writes ------------------------------------------------------------

    def upsert_chunk(self, *, row: dict[str, Any]) -> None:
        """Insert/replace one chunk (idempotent on company+source+chunkIndex)."""
        self._execute(
            """
            INSERT INTO "HermesRagChunk"
                ("id","companyId","sourceType","sourceId","chunkIndex","documentKey",
                 "fileAssetId","ownerUserId","visibility","allowedRoles","title",
                 "chunkText","rawChunkText","sectionPath","contentHash","embedding",
                 "payload","embeddingSchemaVersion","sourceUpdatedAt")
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s::jsonb,%s,%s::vector,
                    %s::jsonb,%s,%s)
            ON CONFLICT ("companyId","sourceType","sourceId","chunkIndex")
            DO UPDATE SET
                "documentKey" = EXCLUDED."documentKey",
                "fileAssetId" = EXCLUDED."fileAssetId",
                "ownerUserId" = EXCLUDED."ownerUserId",
                "visibility" = EXCLUDED."visibility",
                "allowedRoles" = EXCLUDED."allowedRoles",
                "title" = EXCLUDED."title",
                "chunkText" = EXCLUDED."chunkText",
                "rawChunkText" = EXCLUDED."rawChunkText",
                "sectionPath" = EXCLUDED."sectionPath",
                "contentHash" = EXCLUDED."contentHash",
                "embedding" = EXCLUDED."embedding",
                "payload" = EXCLUDED."payload",
                "embeddingSchemaVersion" = EXCLUDED."embeddingSchemaVersion",
                "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
                "updatedAt" = now()
            """,
            (
                row["id"], row["companyId"], row["sourceType"], row["sourceId"],
                row["chunkIndex"], row["documentKey"], row.get("fileAssetId"),
                row.get("ownerUserId"), row.get("visibility", "shared"),
                json.dumps(row.get("allowedRoles") or []), row.get("title"),
                row["chunkText"], row.get("rawChunkText"),
                json.dumps(row.get("sectionPath") or []), row["contentHash"],
                _vec_literal(row["embedding"]), json.dumps(row.get("payload") or {}),
                row.get("embeddingSchemaVersion", "hermes-rag-v1"), row.get("sourceUpdatedAt"),
            ),
        )

    def delete_by_source(self, *, company_id: str, source_type: str, source_id: str) -> int:
        result = self._connection.execute(
            'DELETE FROM "HermesRagChunk" WHERE "companyId"=%s AND "sourceType"=%s AND "sourceId"=%s',
            (company_id, source_type, source_id),
        )
        count = getattr(result, "rowcount", 0) or 0
        close = getattr(result, "close", None)
        if close is not None:
            close()
        return count

    def count_by_company(self, company_id: str) -> int:
        row = self._fetchone(
            'SELECT count(*) AS n FROM "HermesRagChunk" WHERE "companyId"=%s', (company_id,)
        )
        return int(self._row_get(row, "n") or 0)

    # -- search ------------------------------------------------------------

    def search(
        self,
        *,
        company_id: str,
        query_vector: list[float],
        limit: int,
        requester_user_id: Optional[str] = None,
        requester_ai_role: Optional[str] = None,
        source_types: tuple[str, ...] = (),
        file_asset_id: Optional[str] = None,
        include_personal: bool = True,
        include_shared: bool = True,
        include_public: bool = True,
        schema_version: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        vec = _vec_literal(query_vector)
        where: list[str] = []
        args: list[Any] = [vec]  # first %s is the SELECT score distance operand

        # Visibility scope (OR of the enabled buckets).
        scope: list[str] = []
        if include_public:
            scope.append("\"visibility\" = 'public'")
        if include_shared:
            scope.append('("companyId" = %s AND "visibility" = \'shared\')')
            args.append(company_id)
        if include_personal and requester_user_id:
            scope.append('("companyId" = %s AND "visibility" = \'personal\' AND "ownerUserId" = %s)')
            args.extend([company_id, requester_user_id])
        if not scope:
            scope.append('"companyId" = %s')
            args.append(company_id)
        where.append("(" + " OR ".join(scope) + ")")

        if schema_version:
            where.append('"embeddingSchemaVersion" = %s')
            args.append(schema_version)
        if source_types:
            where.append('"sourceType" = ANY(%s)')
            args.append(list(source_types))
        if file_asset_id:
            where.append('"fileAssetId" = %s')
            args.append(file_asset_id)

        # Role gate for file scope (empty allowedRoles, or contains role, or exempt source type).
        is_file_scope = (not source_types) or ("file_document" in source_types)
        if is_file_scope and requester_ai_role:
            where.append(
                "(jsonb_array_length(\"allowedRoles\") = 0 "
                "OR \"allowedRoles\" @> %s::jsonb "
                "OR \"sourceType\" = ANY(%s))"
            )
            args.append(json.dumps([requester_ai_role]))
            args.append(list(_ROLE_EXEMPT_SOURCE_TYPES))

        args.append(vec)  # ORDER BY distance operand
        args.append(int(limit))

        sql = f"""
            SELECT "id","companyId","sourceType","sourceId","chunkIndex","documentKey",
                   "visibility","ownerUserId","allowedRoles","payload",
                   1 - ("embedding"::halfvec(3072) <=> %s::halfvec(3072)) AS score
            FROM "HermesRagChunk"
            WHERE {" AND ".join(where)}
            ORDER BY "embedding"::halfvec(3072) <=> %s::halfvec(3072)
            LIMIT %s
        """
        return [dict(r) for r in self._fetchall(sql, tuple(args))]

    # -- helpers (mirror MemoryRepository) ---------------------------------

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
            return list(fetchall() or [])
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
