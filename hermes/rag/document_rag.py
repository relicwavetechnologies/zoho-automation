"""DocumentRagBroker — port of ``application/retrieval/document-rag.broker.ts``.

Orchestrates the file-RAG retrieval pipeline:

  1. expand the query into variants (:mod:`rag.query_rewrite`)
  2. embed each variant and run parallel semantic search over the file profile
  3. dedupe candidates by chunk id, keep top ``limit * 4``
  4. rerank with the Groq listwise judge, filter by threshold
  5. corrective retry on a broadened query when < 2 ranked results
  6. slice to ``limit``, assemble citations

Collaborators (embedder / store / reranker) are injected so the broker is unit
testable without a network. ``read_full`` reassembles a document from its
indexed chunks for exact-wording questions.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from rag.config import RagConfig
from rag.embeddings import EmbeddingService
from rag.query_rewrite import (
    broaden_document_search_query,
    build_document_search_queries,
)
from rag.reranker import GroqReranker, RankedChunk
from rag.types import RETRIEVAL_PROFILES, SOURCE_TYPE_FILE, SearchResult, VectorQuery
from rag.vector_store import QdrantStore

logger = logging.getLogger(__name__)


def _payload_text(p: dict[str, Any]) -> str:
    return str(p.get("rawChunkText") or p.get("chunkText") or p.get("text") or "")


def _file_name(p: dict[str, Any]) -> str:
    return str(p.get("fileName") or p.get("citationTitle") or p.get("title") or "document")


def _section_path(p: dict[str, Any]) -> Optional[str]:
    sp = p.get("sectionPath")
    if isinstance(sp, list) and sp:
        return " > ".join(str(s) for s in sp)
    if isinstance(sp, str) and sp.strip():
        return sp.strip()
    return None


def _citation(p: dict[str, Any]) -> str:
    name = _file_name(p)
    section = _section_path(p)
    return f"[{name} § {section}]" if section else f"[{name}]"


class DocumentRagBroker:
    def __init__(
        self,
        *,
        embedder: EmbeddingService,
        store: QdrantStore,
        reranker: GroqReranker,
        config: RagConfig,
    ):
        self._embedder = embedder
        self._store = store
        self._reranker = reranker
        self._config = config

    # ── search ────────────────────────────────────────────────────────────────

    async def search(
        self,
        *,
        query: str,
        company_id: str,
        requester_user_id: Optional[str] = None,
        requester_ai_role: Optional[str] = None,
        file_asset_id: Optional[str] = None,
        limit: int = 6,
    ) -> dict:
        profile = RETRIEVAL_PROFILES["file"]
        limit = max(1, min(limit, profile.final_top_k))
        candidate_limit = limit * 4

        queries = (
            build_document_search_queries(query)
            if self._config.rewrite_enabled
            else [query]
        ) or [query]

        candidates = await self._run_search(
            queries, company_id, requester_user_id, requester_ai_role, file_asset_id, candidate_limit
        )

        ranked = await self._rank(query, candidates)

        # Corrective retry: broaden and re-search when reranking left us thin.
        if self._config.grading_enabled and len(ranked) < 2:
            broadened = broaden_document_search_query(query)
            if broadened and broadened.strip().lower() != query.strip().lower():
                extra = await self._run_search(
                    [broadened],
                    company_id,
                    requester_user_id,
                    requester_ai_role,
                    file_asset_id,
                    candidate_limit,
                )
                merged = self._dedupe(candidates + extra)
                ranked = await self._rank(query, merged)

        top = ranked[:limit]
        results = []
        for item in top:
            p = item.chunk.payload or {}
            results.append(
                {
                    "text": _payload_text(p),
                    "fileName": _file_name(p),
                    "fileAssetId": p.get("fileAssetId"),
                    "sectionPath": _section_path(p),
                    "cloudinaryUrl": p.get("cloudinaryUrl") or p.get("sourceUrl"),
                    "score": round(item.reranker_score, 3),
                    "citation": _citation(p),
                }
            )
        return {
            "success": True,
            "operation": "search",
            "results": results,
            "message": None if results else "No relevant document chunks found.",
        }

    async def _run_search(
        self,
        queries: list[str],
        company_id: str,
        requester_user_id: Optional[str],
        requester_ai_role: Optional[str],
        file_asset_id: Optional[str],
        candidate_limit: int,
    ) -> list[SearchResult]:
        vectors = await self._embedder.embed_queries(queries)

        async def one(vec: list[float]) -> list[SearchResult]:
            groups = await self._store.search(
                VectorQuery(
                    company_id=company_id,
                    dense_vector=vec,
                    limit=candidate_limit,
                    requester_user_id=requester_user_id,
                    requester_ai_role=requester_ai_role,
                    retrieval_profile="file",
                    source_types=(SOURCE_TYPE_FILE,),
                    file_asset_id=file_asset_id,
                    include_personal=True,
                    include_shared=True,
                )
            )
            return [hit for group in groups for hit in group.hits]

        batches = await asyncio.gather(*(one(v) for v in vectors), return_exceptions=True)
        flat: list[SearchResult] = []
        for b in batches:
            if isinstance(b, Exception):
                logger.warning("document_rag semantic search branch failed: %s", b)
                continue
            flat.extend(b)
        return self._dedupe(flat)[:candidate_limit]

    @staticmethod
    def _dedupe(hits: list[SearchResult]) -> list[SearchResult]:
        best: dict[str, SearchResult] = {}
        for h in hits:
            prev = best.get(h.id)
            if prev is None or h.score > prev.score:
                best[h.id] = h
        return sorted(best.values(), key=lambda h: h.score, reverse=True)

    @staticmethod
    def _cosine_ranked(candidates: list[SearchResult]) -> list[RankedChunk]:
        ranked = [RankedChunk(chunk=c, reranker_score=c.score * 10.0) for c in candidates]
        ranked.sort(key=lambda r: r.reranker_score, reverse=True)
        return ranked

    async def _rank(self, query: str, candidates: list[SearchResult]) -> list[RankedChunk]:
        if not candidates:
            return []
        if not self._config.grading_enabled:
            return self._cosine_ranked(candidates)
        ranked = await self._reranker.rerank(query, candidates)
        # The reranker can filter every candidate below the relevance threshold —
        # but returning nothing when decent semantic matches exist is a worse
        # failure than surfacing the best ones. Fall back to cosine order.
        if not ranked:
            return self._cosine_ranked(candidates)
        return ranked

    # ── read_full ─────────────────────────────────────────────────────────────

    async def read_full(
        self,
        *,
        company_id: str,
        file_asset_id: str,
        requester_user_id: Optional[str] = None,
        requester_ai_role: Optional[str] = None,
    ) -> dict:
        """Reassemble a document from its indexed chunks (for exact-wording reads)."""
        if not self._config.full_read_enabled:
            return {"success": False, "operation": "readFull", "message": "Full read disabled."}
        # Pull every chunk for this file by issuing a broad search scoped to it.
        vec = await self._embedder.embed_query(" ")
        groups = await self._store.search(
            VectorQuery(
                company_id=company_id,
                dense_vector=vec,
                limit=25,
                candidate_limit=200,
                requester_user_id=requester_user_id,
                requester_ai_role=requester_ai_role,
                retrieval_profile="file",
                source_types=(SOURCE_TYPE_FILE,),
                file_asset_id=file_asset_id,
                group_size=10,
            )
        )
        hits = [hit for group in groups for hit in group.hits]
        hits.sort(key=lambda h: h.chunk_index)

        seen_parents: set[str] = set()
        parts: list[str] = []
        file_name = "document"
        for h in hits:
            p = h.payload or {}
            file_name = _file_name(p)
            parent = str(p.get("parentSectionId") or "")
            if parent and parent in seen_parents:
                continue
            if parent:
                seen_parents.add(parent)
            text = _payload_text(p)
            if text:
                parts.append(text)
        full = "\n\n".join(parts)[: self._config.full_read_max_chars]
        return {
            "success": bool(full),
            "operation": "readFull",
            "results": (
                [{"text": full, "fileName": file_name, "fileAssetId": file_asset_id, "citation": f"[{file_name}]"}]
                if full
                else []
            ),
            "message": None if full else "No indexed content for that document.",
        }

    # ── list_files ────────────────────────────────────────────────────────────

    async def list_files(
        self,
        *,
        company_id: str,
        requester_user_id: Optional[str] = None,
        requester_ai_role: Optional[str] = None,
    ) -> dict:
        """List indexed files visible to the requester (best-effort, via search scan)."""
        vec = await self._embedder.embed_query(" ")
        groups = await self._store.search(
            VectorQuery(
                company_id=company_id,
                dense_vector=vec,
                limit=25,
                candidate_limit=200,
                requester_user_id=requester_user_id,
                requester_ai_role=requester_ai_role,
                retrieval_profile="file",
                source_types=(SOURCE_TYPE_FILE,),
                group_size=1,
            )
        )
        files: dict[str, dict] = {}
        for group in groups:
            for hit in group.hits:
                p = hit.payload or {}
                fid = str(p.get("fileAssetId") or hit.source_id or "")
                if fid and fid not in files:
                    files[fid] = {"fileAssetId": fid, "fileName": _file_name(p)}
        items = list(files.values())
        return {
            "success": True,
            "operation": "listFiles",
            "results": items,
            "totalFiles": len(items),
        }
