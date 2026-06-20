"""Environment-driven configuration for the RAG subsystem.

Reads the *same* env keys the legacy ``advance-backend`` uses (so wiring is a
copy-paste of values from ``advance-backend/.env``), plus the ``RAG_*`` /
``FILE_RAG_*`` tuning flags. Nothing here touches the network; it only resolves
config and answers :func:`rag_enabled`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_flag(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class RagConfig:
    """Resolved RAG configuration. Build with :meth:`from_env`."""

    # Vector store backend: 'pgvector' (Hermes-owned, default) | 'qdrant' (opt-in)
    vector_backend: str
    # Qdrant (only used when vector_backend == 'qdrant')
    qdrant_url: str
    qdrant_api_key: Optional[str]
    qdrant_collection: str
    qdrant_timeout_ms: int

    # Embeddings
    embedding_provider: str  # 'gemini' | 'openai' | 'fallback'
    gemini_api_key: Optional[str]
    gemini_embedding_model: str
    gemini_multimodal_model: str
    gemini_vision_model: str
    openai_api_key: Optional[str]
    openai_embedding_model: str

    # Reranker (Groq listwise judge)
    groq_api_key: Optional[str]
    groq_rerank_model: str

    # Retrieval tuning
    grade_threshold: int
    full_read_max_chars: int
    max_rewrites: int

    # Feature flags
    rewrite_enabled: bool
    grading_enabled: bool
    chunk_search_enabled: bool
    full_read_enabled: bool
    multimodal_enabled: bool

    # Document ingestion limits
    doc_extract_max_words: int
    doc_upload_max_mb: int

    @classmethod
    def from_env(cls) -> "RagConfig":
        # Hermes OWNS its retrieval store. It must NOT read/write the legacy
        # advance-backend collection (`retrieval_v3`) — that backend is a porting
        # source deleted at cutover, and the runtime owning its own data is the
        # whole point of the rewrite. So the collection defaults to a Hermes-owned
        # name and is never the legacy one; ingestion re-populates it.
        #
        # The cluster URL/key prefer Hermes-specific vars (so a dedicated Qdrant
        # deployment can be slotted in) and only fall back to the shared infra
        # credentials when Hermes-specific ones aren't set.
        collection = _env("HERMES_RAG_COLLECTION") or "hermes_documents_v1"
        # Qdrant is opt-in for a dedicated Hermes deployment; pgvector (on the
        # Postgres Hermes owns) is the default and needs no external service.
        qdrant_url = _env("HERMES_RAG_QDRANT_URL")
        qdrant_api_key = _env("HERMES_RAG_QDRANT_API_KEY")
        backend = (_env("HERMES_RAG_BACKEND") or ("qdrant" if qdrant_url else "pgvector")).lower()
        return cls(
            vector_backend=backend,
            qdrant_url=qdrant_url.rstrip("/"),
            qdrant_api_key=qdrant_api_key or None,
            qdrant_collection=collection,
            qdrant_timeout_ms=_env_int("QDRANT_TIMEOUT_MS", 10_000),
            embedding_provider=(_env("EMBEDDING_PROVIDER") or "gemini").lower(),
            gemini_api_key=(_env("GEMINI_API_KEY") or _env("GOOGLE_GENERATIVE_AI_API_KEY")) or None,
            gemini_embedding_model=_env("GEMINI_EMBEDDING_MODEL") or "gemini-embedding-001",
            gemini_multimodal_model=_env("GEMINI_MULTIMODAL_EMBEDDING_MODEL")
            or "gemini-embedding-2-preview",
            gemini_vision_model=_env("GEMINI_VISION_MODEL") or "gemini-3.1-flash-lite",
            openai_api_key=_env("OPENAI_API_KEY") or None,
            openai_embedding_model=_env("OPENAI_EMBEDDING_MODEL") or "text-embedding-3-small",
            groq_api_key=_env("GROQ_API_KEY") or None,
            # Legacy reranker hardcodes llama-3.1-8b-instant; allow override.
            groq_rerank_model=_env("GROQ_RERANK_MODEL") or "llama-3.1-8b-instant",
            grade_threshold=_env_int("RAG_GRADE_THRESHOLD", 3),
            full_read_max_chars=_env_int("RAG_FULL_READ_MAX_CHARS", 18_000),
            max_rewrites=_env_int("RAG_MAX_REWRITES", 1),
            rewrite_enabled=_env_flag("FILE_RAG_REWRITE_ENABLED", True),
            grading_enabled=_env_flag("FILE_RAG_GRADING_ENABLED", True),
            chunk_search_enabled=_env_flag("FILE_RAG_CHUNK_SEARCH_ENABLED", True),
            full_read_enabled=_env_flag("FILE_RAG_FULL_READ_ENABLED", True),
            multimodal_enabled=_env_flag("FILE_RAG_MULTIMODAL_ENABLED", True),
            doc_extract_max_words=_env_int("DOC_EXTRACT_MAX_WORDS", 100_000),
            doc_upload_max_mb=_env_int("DOC_UPLOAD_MAX_MB", 24),
        )

    # ── Capability gates ────────────────────────────────────────────────────

    def has_embedding_provider(self) -> bool:
        """True when at least one real embedding provider is configured.

        The deterministic fallback always exists, but it cannot match the
        vectors already stored in the shared cluster, so it does not count as a
        usable retrieval provider.
        """
        if self.embedding_provider == "gemini" and self.gemini_api_key:
            return True
        if self.embedding_provider == "openai" and self.openai_api_key:
            return True
        # Auto: any key present.
        return bool(self.gemini_api_key or self.openai_api_key)

    def vector_store_available(self) -> bool:
        """True when the selected vector backend is usable."""
        if self.vector_backend == "qdrant":
            return bool(self.qdrant_url)
        # pgvector: needs Hermes's enterprise Postgres.
        try:
            from enterprise.db import enterprise_postgres_enabled

            return enterprise_postgres_enabled()
        except Exception:
            return False

    def rag_enabled(self) -> bool:
        """True when retrieval can actually run (vector store + an embedder)."""
        return self.vector_store_available() and self.has_embedding_provider()
