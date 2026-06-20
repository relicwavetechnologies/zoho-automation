"""PgVectorStore — Hermes-owned vector store on Postgres + pgvector.

Implements the same async interface as :class:`rag.vector_store.QdrantStore`
(``search`` / ``upsert_vectors`` / ``delete_by_source`` / ``count_by_company``)
so the retrieval brokers and ingestion service are backend-agnostic. This is the
DEFAULT backend: it keeps all retrieval data in the Postgres Hermes already owns
and migrates — no external Qdrant, no advance-backend dependency.

The underlying enterprise psycopg connection is synchronous and not safe for
concurrent use, while the document broker fires query-variant searches
concurrently. So every DB call runs in a worker thread (``asyncio.to_thread``)
serialized by a lock — correct and more than fast enough at per-company scale.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Optional

from rag.types import (
    ACTIVE_EMBEDDING_SCHEMA_VERSION,
    SearchGroup,
    SearchResult,
    UpsertRecord,
    VectorQuery,
)
from rag.vector_store import build_point_id

logger = logging.getLogger(__name__)


class PgVectorStore:
    def __init__(self, repository, *, lock: Optional[threading.Lock] = None):
        self._repo = repository
        self._lock = lock or threading.Lock()

    async def _run(self, fn, *args, **kwargs):
        def call():
            with self._lock:
                return fn(*args, **kwargs)

        return await asyncio.to_thread(call)

    # ── search ────────────────────────────────────────────────────────────────

    async def search(self, query: VectorQuery) -> list[SearchGroup]:
        limit = max(1, min(50, query.limit))
        group_size = max(1, min(10, query.group_size or 3))
        # Over-fetch so post-grouping by document still yields up to `limit` groups.
        fetch = min(300, max(limit * group_size, query.candidate_limit or limit))

        rows = await self._run(
            self._repo.search,
            company_id=query.company_id,
            query_vector=query.dense_vector,
            limit=fetch,
            requester_user_id=query.requester_user_id,
            requester_ai_role=query.requester_ai_role,
            source_types=query.source_types,
            file_asset_id=query.file_asset_id,
            include_personal=query.include_personal,
            include_shared=query.include_shared,
            include_public=query.include_public,
            schema_version=query.schema_version or ACTIVE_EMBEDDING_SCHEMA_VERSION,
        )

        # Group by documentKey (mirrors Qdrant grouped search), cap per-group size,
        # return up to `limit` groups in best-score order.
        groups: list[SearchGroup] = []
        index: dict[str, SearchGroup] = {}
        for r in rows:
            payload = r.get("payload") or {}
            doc_key = str(r.get("documentKey") or r.get("sourceId") or "")
            hit = SearchResult(
                id=str(r.get("id")),
                score=float(r.get("score") or 0.0),
                source_type=str(r.get("sourceType") or "file_document"),
                source_id=str(r.get("sourceId") or ""),
                chunk_index=int(r.get("chunkIndex") or 0),
                visibility=str(r.get("visibility") or "shared"),
                payload=payload,
                document_key=doc_key or None,
                owner_user_id=r.get("ownerUserId"),
                allowed_roles=r.get("allowedRoles") if isinstance(r.get("allowedRoles"), list) else None,
            )
            grp = index.get(doc_key)
            if grp is None:
                if len(groups) >= limit:
                    continue
                grp = SearchGroup(group_value=doc_key, hits=[])
                index[doc_key] = grp
                groups.append(grp)
            if len(grp.hits) < group_size:
                grp.hits.append(hit)
        return groups

    # ── upsert / delete / count ───────────────────────────────────────────────

    async def upsert_vectors(self, records: list[UpsertRecord]) -> None:
        if not records:
            return
        rows = [self._record_to_row(r) for r in records]

        def write_all():
            with self._lock:
                for row in rows:
                    self._repo.upsert_chunk(row=row)

        await asyncio.to_thread(write_all)

    @staticmethod
    def _record_to_row(r: UpsertRecord) -> dict[str, Any]:
        document_key = r.document_key or f"{r.company_id}:{r.source_type}:{r.source_id}"
        payload = dict(r.payload or {})
        section_path = payload.get("sectionPath") if isinstance(payload.get("sectionPath"), list) else []
        return {
            "id": build_point_id(r.company_id, r.source_type, r.source_id, r.chunk_index),
            "companyId": r.company_id,
            "sourceType": r.source_type,
            "sourceId": r.source_id,
            "chunkIndex": r.chunk_index,
            "documentKey": document_key,
            "fileAssetId": r.file_asset_id,
            "ownerUserId": r.owner_user_id,
            "visibility": r.visibility,
            "allowedRoles": r.allowed_roles or [],
            "title": r.title,
            "chunkText": r.content or payload.get("chunkText") or "",
            "rawChunkText": payload.get("rawChunkText"),
            "sectionPath": section_path,
            "contentHash": r.content_hash,
            "embedding": r.dense_embedding,
            "payload": payload,
            "embeddingSchemaVersion": r.embedding_schema_version or ACTIVE_EMBEDDING_SCHEMA_VERSION,
            "sourceUpdatedAt": r.source_updated_at,
        }

    async def delete_by_source(self, *, company_id: str, source_type: str, source_id: str) -> None:
        await self._run(
            self._repo.delete_by_source,
            company_id=company_id,
            source_type=source_type,
            source_id=source_id,
        )

    async def count_by_company(self, company_id: str) -> int:
        return await self._run(self._repo.count_by_company, company_id)

    async def health(self) -> dict:
        try:
            n = await self.count_by_company("__health__")
            return {"ok": True, "backend": "pgvector", "probe_count": n}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "backend": "pgvector", "error": str(exc)}
