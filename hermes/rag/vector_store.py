"""QdrantStore — async Python port of ``infrastructure/ai/vector/qdrant.adapter.ts``.

Talks to the *same* Qdrant Cloud cluster + ``retrieval_v3`` collection the legacy
backend writes to, using the identical wire protocol so points stay mutually
addressable:

  * deterministic UUID-v5-style point IDs from ``companyId|sourceType|sourceId|chunkIndex``
  * named multi-vectors ``dense_text_v2`` (+ optional ``dense_mm_v1``)
  * grouped query API (``/points/query/groups``) with DBSF/RRF fusion when a
    multimodal branch is present
  * visibility/scope ``should`` clause (public | shared | personal) + role-based
    ``allowedRoles`` gate for file documents
  * collection + payload-index auto-provisioning with retry-on-missing-index

HTTP is injectable (``http=``) so tests run without a network or credentials.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any, Optional

import httpx

from rag.types import (
    ACTIVE_EMBEDDING_SCHEMA_VERSION,
    MULTIMODAL_VECTOR_NAME,
    MULTIMODAL_VECTOR_SIZE,
    PRIMARY_TEXT_VECTOR_NAME,
    SOURCE_TYPE_CHAT,
    ZOHO_SOURCE_TYPES,
    SearchGroup,
    SearchResult,
    UpsertRecord,
    VectorQuery,
)

logger = logging.getLogger(__name__)


class VectorStoreError(RuntimeError):
    def __init__(self, message: str, code: str = "vector_unavailable"):
        super().__init__(message)
        self.code = code


def _is_not_found(exc: Exception) -> bool:
    return isinstance(exc, VectorStoreError) and "(404)" in str(exc)


def _is_missing_index(exc: Exception) -> bool:
    return isinstance(exc, VectorStoreError) and "Index required but not found" in str(exc)


def build_point_id(company_id: str, source_type: str, source_id: str, chunk_index: int) -> str:
    """Deterministic UUID-v5-style id — must match the legacy algorithm exactly."""
    seed = (
        hashlib.sha1(f"{company_id}|{source_type}|{source_id}|{chunk_index}".encode("utf-8"))
        .hexdigest()[:32]
        .ljust(32, "0")
    )
    chars = list(seed)
    chars[12] = "5"
    variant = int(chars[16] or "0", 16)
    chars[16] = format((variant & 0x3) | 0x8, "x")
    n = "".join(chars)
    return f"{n[0:8]}-{n[8:12]}-{n[12:16]}-{n[16:20]}-{n[20:32]}"


# ── Filter builders (mirror qdrant.adapter.ts) ──────────────────────────────


def _build_scope_should(q: VectorQuery) -> list[dict]:
    should: list[dict] = []
    include_personal = q.include_personal and bool(q.requester_user_id)
    if q.include_public:
        should.append({"must": [{"key": "visibility", "match": {"value": "public"}}]})
    if q.include_shared:
        should.append(
            {
                "must": [
                    {"key": "companyId", "match": {"value": q.company_id}},
                    {"key": "visibility", "match": {"value": "shared"}},
                ]
            }
        )
    if include_personal and q.requester_user_id:
        should.append(
            {
                "must": [
                    {"key": "companyId", "match": {"value": q.company_id}},
                    {"key": "visibility", "match": {"value": "personal"}},
                    {"key": "ownerUserId", "match": {"value": q.requester_user_id}},
                ]
            }
        )
    if not should:
        should.append({"must": [{"key": "companyId", "match": {"value": q.company_id}}]})
    return should


def _build_search_filter(q: VectorQuery) -> dict:
    must: list[dict] = [
        {
            "key": "embeddingSchemaVersion",
            "match": {"value": q.schema_version or ACTIVE_EMBEDDING_SCHEMA_VERSION},
        }
    ]
    if q.retrieval_profile:
        must.append({"key": "retrievalProfile", "match": {"value": q.retrieval_profile}})
    if q.source_types:
        types = list(q.source_types)
        must.append(
            {
                "key": "sourceType",
                "match": {"value": types[0]} if len(types) == 1 else {"any": types},
            }
        )
    if q.file_asset_id:
        must.append({"key": "fileAssetId", "match": {"value": q.file_asset_id}})
    if q.conversation_key:
        must.append({"key": "conversationKey", "match": {"value": q.conversation_key}})
    if q.enforce_email_match and q.requester_email:
        must.append(
            {"key": "referenceEmails", "match": {"any": [q.requester_email.strip().lower()]}}
        )
    if q.date_from or q.date_to:
        rng: dict[str, Any] = {}
        if q.date_from:
            rng["gte"] = q.date_from
        if q.date_to:
            rng["lte"] = q.date_to
        must.append({"key": "sourceUpdatedAt", "range": rng})

    is_file_scope = (not q.source_types) or ("file_document" in q.source_types)
    if is_file_scope and q.requester_ai_role:
        must.append(
            {
                "should": [
                    {"is_empty": {"key": "allowedRoles"}},
                    {"key": "allowedRoles", "match": {"any": [q.requester_ai_role]}},
                    {
                        "key": "sourceType",
                        "match": {"any": list(ZOHO_SOURCE_TYPES) + [SOURCE_TYPE_CHAT]},
                    },
                ]
            }
        )
    return {"should": _build_scope_should(q), "must": must}


_PAYLOAD_INDEXES: list[tuple[str, Any]] = [
    ("companyId", "keyword"),
    ("documentKey", "keyword"),
    ("sourceType", "keyword"),
    ("sourceId", "keyword"),
    ("fileAssetId", "keyword"),
    ("visibility", "keyword"),
    ("ownerUserId", "keyword"),
    ("referenceEmails", "keyword"),
    ("conversationKey", "keyword"),
    ("allowedRoles", "keyword"),
    ("embeddingSchemaVersion", "keyword"),
    ("retrievalProfile", "keyword"),
    ("sourceUpdatedAt", "datetime"),
    ("chunkIndex", "integer"),
    (
        "chunkText",
        {"type": "text", "tokenizer": "multilingual", "lowercase": True, "min_token_len": 2},
    ),
]


class QdrantStore:
    def __init__(
        self,
        *,
        base_url: str,
        collection: str,
        primary_vector_size: int,
        api_key: Optional[str] = None,
        timeout_ms: int = 10_000,
        http: Optional[httpx.AsyncClient] = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._collection = collection
        self._api_key = api_key
        self._timeout = timeout_ms / 1000.0
        self._primary_size = primary_vector_size
        self._http = http
        self._collection_ready = False
        self._indexes_ready = False

    def _headers(self, with_body: bool) -> dict[str, str]:
        h: dict[str, str] = {}
        if with_body:
            h["Content-Type"] = "application/json"
        if self._api_key:
            h["api-key"] = self._api_key
        return h

    async def _request(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        client = self._http or httpx.AsyncClient(timeout=self._timeout)
        owns = self._http is None
        try:
            res = await client.request(
                method,
                f"{self._base_url}{path}",
                headers=self._headers(body is not None),
                json=body if body is not None else None,
            )
        except httpx.TimeoutException as exc:
            raise VectorStoreError(str(exc), "vector_timeout") from exc
        except httpx.HTTPError as exc:
            raise VectorStoreError(str(exc) or "Qdrant request failed", "vector_unavailable") from exc
        finally:
            if owns:
                await client.aclose()

        raw = res.text
        try:
            payload: Any = res.json() if raw else {}
        except ValueError:
            payload = raw
        if res.status_code >= 400:
            code = "vector_timeout" if res.status_code in (504, 408) else "vector_unavailable"
            detail = payload if isinstance(payload, str) else raw
            raise VectorStoreError(f"Qdrant request failed ({res.status_code}): {detail}", code)
        return payload

    def _path(self, suffix: str) -> str:
        from urllib.parse import quote

        return f"/collections/{quote(self._collection)}{suffix}"

    # ── Provisioning ────────────────────────────────────────────────────────

    async def ensure_collection(self) -> None:
        if self._collection_ready:
            return
        try:
            await self._request("GET", self._path(""))
            self._collection_ready = True
            return
        except VectorStoreError as exc:
            if not _is_not_found(exc):
                raise
        await self._request(
            "PUT",
            self._path(""),
            {
                "vectors": {
                    PRIMARY_TEXT_VECTOR_NAME: {"size": self._primary_size, "distance": "Cosine"},
                    MULTIMODAL_VECTOR_NAME: {"size": MULTIMODAL_VECTOR_SIZE, "distance": "Cosine"},
                }
            },
        )
        self._collection_ready = True
        logger.info("qdrant.collection.created collection=%s", self._collection)

    async def ensure_indexes(self) -> None:
        if self._indexes_ready:
            return
        for field_name, field_schema in _PAYLOAD_INDEXES:
            try:
                await self._request(
                    "PUT",
                    self._path("/index?wait=true"),
                    {"field_name": field_name, "field_schema": field_schema},
                )
            except VectorStoreError as exc:
                if _is_not_found(exc):
                    return  # collection not yet created; skip
                raise
        self._indexes_ready = True

    # ── Search ───────────────────────────────────────────────────────────────

    async def search(self, query: VectorQuery) -> list[SearchGroup]:
        filt = _build_search_filter(query)
        branch_limit = max(
            query.limit,
            min(50, max(10, query.candidate_limit or max(query.limit * 4, 24))),
        )
        prefetch: list[dict] = [
            {
                "query": query.dense_vector,
                "using": PRIMARY_TEXT_VECTOR_NAME,
                "limit": branch_limit,
                "filter": filt,
                **(
                    {"score_threshold": query.score_threshold}
                    if query.score_threshold is not None
                    else {}
                ),
            }
        ]
        if query.use_multimodal and query.query_mode and query.query_mode != "text":
            prefetch.append(
                {
                    "query": query.dense_vector,
                    "using": MULTIMODAL_VECTOR_NAME,
                    "limit": branch_limit,
                    "filter": filt,
                }
            )
        is_multi = len(prefetch) > 1
        body: dict[str, Any] = {
            "prefetch": prefetch,
            "query": {"fusion": query.fusion or "dbsf"} if is_multi else query.dense_vector,
            "group_by": query.group_by_field or "documentKey",
            "group_size": max(1, min(10, query.group_size or 3)),
            "limit": max(1, min(25, query.limit)),
            "with_payload": True,
        }
        if not is_multi:
            body["using"] = PRIMARY_TEXT_VECTOR_NAME
            body["filter"] = filt
            if query.score_threshold is not None:
                body["score_threshold"] = query.score_threshold

        try:
            await self.ensure_collection()
            payload = await self._request("POST", self._path("/points/query/groups"), body)
        except VectorStoreError as exc:
            if _is_not_found(exc):
                await self.ensure_collection()
                await self.ensure_indexes()
                return []
            if _is_missing_index(exc):
                await self.ensure_indexes()
                return await self.search(query)
            raise

        result = payload.get("result") if isinstance(payload, dict) else None
        if isinstance(result, list):
            raw_groups = result
        elif isinstance(result, dict) and isinstance(result.get("groups"), list):
            raw_groups = result["groups"]
        else:
            raw_groups = []

        groups: list[SearchGroup] = []
        for group in raw_groups:
            hits: list[SearchResult] = []
            for item in group.get("hits") or []:
                p = item.get("payload") or {}
                hits.append(
                    SearchResult(
                        id=str(item.get("id")),
                        score=float(item.get("score") or 0.0),
                        source_type=str(p.get("sourceType") or "zoho_contact"),
                        source_id=str(p.get("sourceId") or ""),
                        chunk_index=int(p.get("chunkIndex") or 0),
                        visibility=str(p.get("visibility") or "shared"),
                        payload=p,
                        document_key=p.get("documentKey") if isinstance(p.get("documentKey"), str) else None,
                        owner_user_id=p.get("ownerUserId") if isinstance(p.get("ownerUserId"), str) else None,
                        conversation_key=p.get("conversationKey")
                        if isinstance(p.get("conversationKey"), str)
                        else None,
                        allowed_roles=p.get("allowedRoles") if isinstance(p.get("allowedRoles"), list) else None,
                    )
                )
            groups.append(SearchGroup(group_value=str(group.get("id") or ""), hits=hits))
        return groups

    # ── Upsert / delete / count / health ─────────────────────────────────────

    async def upsert_vectors(self, records: list[UpsertRecord]) -> None:
        if not records:
            return
        await self.ensure_collection()
        await self.ensure_indexes()
        points = [self._record_to_point(r) for r in records]
        body = {"points": points}
        try:
            await self._request("PUT", self._path("/points?wait=true"), body)
        except VectorStoreError as exc:
            if not _is_missing_index(exc):
                raise
            await self.ensure_indexes()
            await self._request("PUT", self._path("/points?wait=true"), body)

    def _record_to_point(self, r: UpsertRecord) -> dict:
        document_key = r.document_key or f"{r.company_id}:{r.source_type}:{r.source_id}"
        vector: dict[str, Any] = {PRIMARY_TEXT_VECTOR_NAME: r.dense_embedding}
        if r.multimodal_embedding:
            vector[MULTIMODAL_VECTOR_NAME] = r.multimodal_embedding
        payload: dict[str, Any] = {
            "companyId": r.company_id,
            "documentKey": document_key,
            "sourceType": r.source_type,
            "sourceId": r.source_id,
            "chunkIndex": r.chunk_index,
            "contentHash": r.content_hash,
            "visibility": r.visibility,
            "chunkText": r.content or r.payload.get("chunkText") or r.payload.get("text"),
            "text": r.content or r.payload.get("text"),
            "title": r.title,
            "sourceUpdatedAt": r.source_updated_at,
            "embeddingSchemaVersion": r.embedding_schema_version,
            "retrievalProfile": r.retrieval_profile,
            **r.payload,
        }
        if r.owner_user_id:
            payload["ownerUserId"] = r.owner_user_id
        if r.conversation_key:
            payload["conversationKey"] = r.conversation_key
        if r.connection_id:
            payload["connectionId"] = r.connection_id
        if r.file_asset_id:
            payload["fileAssetId"] = r.file_asset_id
        if isinstance(r.reference_emails, list):
            payload["referenceEmails"] = r.reference_emails
        if isinstance(r.allowed_roles, list):
            payload["allowedRoles"] = r.allowed_roles
        return {
            "id": build_point_id(r.company_id, r.source_type, r.source_id, r.chunk_index),
            "vector": vector,
            "payload": payload,
        }

    async def delete_by_source(self, *, company_id: str, source_type: str, source_id: str) -> None:
        filt = {
            "must": [
                {"key": "companyId", "match": {"value": company_id}},
                {"key": "sourceType", "match": {"value": source_type}},
                {"key": "sourceId", "match": {"value": source_id}},
            ]
        }
        try:
            await self.ensure_collection()
            await self.ensure_indexes()
            await self._request("POST", self._path("/points/delete?wait=true"), {"filter": filt})
        except VectorStoreError as exc:
            if _is_not_found(exc):
                return
            if not _is_missing_index(exc):
                raise
            await self.ensure_indexes()
            await self._request("POST", self._path("/points/delete?wait=true"), {"filter": filt})

    async def count_by_company(self, company_id: str) -> int:
        body = {
            "exact": True,
            "filter": {
                "must": [
                    {"key": "companyId", "match": {"value": company_id}},
                    {
                        "key": "embeddingSchemaVersion",
                        "match": {"value": ACTIVE_EMBEDDING_SCHEMA_VERSION},
                    },
                ]
            },
        }
        try:
            payload = await self._request("POST", self._path("/points/count"), body)
        except VectorStoreError as exc:
            if _is_not_found(exc):
                return 0
            if _is_missing_index(exc):
                await self.ensure_indexes()
                return await self.count_by_company(company_id)
            raise
        result = payload.get("result") if isinstance(payload, dict) else None
        return int((result or {}).get("count") or 0)

    async def health(self) -> dict:
        try:
            await self._request("GET", self._path(""))
            return {"ok": True, "backend": "qdrant", "collection": self._collection}
        except Exception as exc:  # noqa: BLE001 — health never raises
            return {"ok": False, "backend": "qdrant", "collection": self._collection, "error": str(exc)}
