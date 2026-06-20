"""IngestionService — orchestrates extract → classify → chunk → embed → upsert.

Port of the core of ``ingestion/ingestion.service.ts`` (minus CDN upload + the
BullMQ worker, which are infra concerns wired separately). Given a document
buffer (or already-extracted text) it produces ``retrieval_v3``-compatible points
in the shared Qdrant collection, addressable by the same deterministic IDs the
legacy backend uses — so re-ingesting the same file overwrites in place.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from typing import Optional

from rag.config import RagConfig
from rag.embeddings import EmbeddingService, make_embedding_service
from rag.ingestion.chunking import build_indexed_chunks, choose_chunking_plan
from rag.ingestion.extract import extract_from_buffer
from rag.types import SOURCE_TYPE_FILE, UpsertRecord

logger = logging.getLogger(__name__)


@dataclass
class IngestionResult:
    success: bool
    file_asset_id: str
    chunks_indexed: int
    document_class: str
    strategy: str
    message: Optional[str] = None


def _file_asset_id(company_id: str, buffer: bytes) -> str:
    return f"{company_id}_{hashlib.sha256(buffer).hexdigest()[:12]}"


class IngestionService:
    def __init__(
        self,
        *,
        embedder: EmbeddingService,
        store: QdrantStore,
        config: RagConfig,
    ):
        self._embedder = embedder
        self._store = store
        self._config = config

    async def ingest_text(
        self,
        *,
        company_id: str,
        file_name: str,
        text: str,
        mime_type: str = "text/plain",
        file_asset_id: Optional[str] = None,
        uploader_user_id: Optional[str] = None,
        visibility: str = "shared",
        allowed_roles: Optional[list[str]] = None,
        source_url: str = "",
        metadata: Optional[dict] = None,
        source_updated_at: Optional[str] = None,
    ) -> IngestionResult:
        fid = file_asset_id or _file_asset_id(company_id, text.encode("utf-8"))
        plan = choose_chunking_plan(
            file_name=file_name,
            mime_type=mime_type,
            text=text,
            advanced_chunking_enabled=self._config.chunk_search_enabled,
            contextual_enrichment_enabled=self._config.chunk_search_enabled,
        )
        chunks = build_indexed_chunks(
            company_id=company_id,
            file_asset_id=fid,
            file_name=file_name,
            mime_type=mime_type,
            source_url=source_url,
            uploader_user_id=uploader_user_id,
            text=text,
            plan=plan,
            visibility=visibility,
            allowed_roles=allowed_roles,
            metadata=metadata,
            source_updated_at=source_updated_at,
        )
        if not chunks:
            return IngestionResult(False, fid, 0, plan.document_class, plan.strategy, "No extractable content.")

        embeddings = await self._embedder.embed_documents([c.indexed_text for c in chunks])
        records: list[UpsertRecord] = []
        for chunk, vec in zip(chunks, embeddings):
            records.append(
                UpsertRecord(
                    company_id=company_id,
                    source_type=SOURCE_TYPE_FILE,
                    source_id=chunk.source_id,
                    chunk_index=chunk.chunk_index,
                    content_hash=hashlib.sha256(chunk.raw_chunk_text.encode("utf-8")).hexdigest(),
                    dense_embedding=vec,
                    visibility=chunk.visibility,
                    document_key=chunk.document_key,
                    owner_user_id=chunk.owner_user_id,
                    file_asset_id=chunk.file_asset_id,
                    allowed_roles=allowed_roles,
                    title=chunk.title,
                    content=chunk.indexed_text,
                    source_updated_at=chunk.source_updated_at,
                    retrieval_profile="file",
                    payload=chunk.payload,
                )
            )
        await self._store.upsert_vectors(records)
        logger.info(
            "rag.ingest file=%s class=%s strategy=%s chunks=%d",
            file_name, plan.document_class, plan.strategy, len(records),
        )
        return IngestionResult(True, fid, len(records), plan.document_class, plan.strategy)

    async def ingest_buffer(
        self,
        *,
        company_id: str,
        file_name: str,
        buffer: bytes,
        mime_type: str,
        **kwargs,
    ) -> IngestionResult:
        extracted = extract_from_buffer(buffer=buffer, mime_type=mime_type, file_name=file_name)
        fid = kwargs.pop("file_asset_id", None) or _file_asset_id(company_id, buffer)
        return await self.ingest_text(
            company_id=company_id,
            file_name=file_name,
            text=extracted.text,
            mime_type=mime_type,
            file_asset_id=fid,
            **kwargs,
        )

    async def delete_file(self, *, company_id: str, file_asset_id: str) -> None:
        await self._store.delete_by_source(
            company_id=company_id, source_type=SOURCE_TYPE_FILE, source_id=file_asset_id
        )


def build_ingestion_service(
    config: Optional[RagConfig] = None, *, http=None
) -> IngestionService:
    from rag.factory import build_vector_store

    cfg = config or RagConfig.from_env()
    embedder = make_embedding_service(cfg, http=http)
    store = build_vector_store(cfg, primary_vector_size=embedder.dimension, http=http)
    return IngestionService(embedder=embedder, store=store, config=cfg)
