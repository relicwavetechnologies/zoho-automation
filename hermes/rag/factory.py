"""Construct a wired :class:`DocumentRagBroker` from environment config.

Centralizes embedder → store → reranker → broker wiring. The vector store is
selected by config: **pgvector on Hermes's own Postgres** by default (no external
service, no advance-backend dependency), or a dedicated Hermes-owned Qdrant when
``HERMES_RAG_QDRANT_URL`` is set. Both implement the same async store interface,
so the brokers/ingestion don't care which is active.
"""

from __future__ import annotations

import threading
from typing import Optional

import httpx

from rag.config import RagConfig
from rag.document_rag import DocumentRagBroker
from rag.embeddings import EmbeddingService, make_embedding_service
from rag.reranker import GroqReranker
from rag.types import RETRIEVAL_PROFILES

# One shared lock + connection for the pgvector store across the process (the
# enterprise psycopg connection is single-threaded).
_PG_LOCK = threading.Lock()


def build_vector_store(config: RagConfig, *, primary_vector_size: int, http: Optional[httpx.AsyncClient] = None):
    """Build the configured vector store (pgvector default, Qdrant opt-in)."""
    if config.vector_backend == "qdrant":
        from rag.vector_store import QdrantStore

        return QdrantStore(
            base_url=config.qdrant_url,
            collection=config.qdrant_collection,
            primary_vector_size=primary_vector_size,
            api_key=config.qdrant_api_key,
            timeout_ms=config.qdrant_timeout_ms,
            http=http,
        )
    # Default: pgvector on Hermes's own Postgres. Dedicated connection so concurrent
    # query-variant searches don't share the global enterprise connection.
    from enterprise.config import EnterprisePostgresConfig
    from enterprise.rag_repository import RagChunkRepository
    from rag.pgvector_store import PgVectorStore

    cfg = EnterprisePostgresConfig.from_env()
    if not cfg.enabled or not cfg.database_url:
        raise RuntimeError("pgvector backend requires Hermes enterprise Postgres")
    import psycopg
    from psycopg.rows import dict_row

    conn = psycopg.connect(cfg.database_url, autocommit=True, row_factory=dict_row)
    return PgVectorStore(RagChunkRepository(conn), lock=_PG_LOCK)


def build_document_rag_broker(
    config: Optional[RagConfig] = None,
    *,
    http: Optional[httpx.AsyncClient] = None,
) -> DocumentRagBroker:
    cfg = config or RagConfig.from_env()
    embedder: EmbeddingService = make_embedding_service(cfg, http=http)
    store = build_vector_store(cfg, primary_vector_size=embedder.dimension, http=http)
    reranker = GroqReranker(
        api_key=cfg.groq_api_key,
        model=cfg.groq_rerank_model,
        threshold=cfg.grade_threshold,
        max_chunks=RETRIEVAL_PROFILES["file"].rerank_top_n,
        http=http,
    )
    return DocumentRagBroker(embedder=embedder, store=store, reranker=reranker, config=cfg)


def build_context_search_broker(
    config: Optional[RagConfig] = None,
    *,
    http: Optional[httpx.AsyncClient] = None,
):
    """Wire the unified context-search broker over the RAG document broker."""
    from rag.context_search import ContextSearchBroker

    return ContextSearchBroker(document_broker=build_document_rag_broker(config, http=http))
