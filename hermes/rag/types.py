"""Shared constants + dataclasses for the RAG subsystem.

These mirror ``advance-backend/src/infrastructure/ai/vector/types.ts`` so that
points written/queried by Hermes are byte-compatible with the existing
``retrieval_v3`` collection (same schema version, same named vectors, same
retrieval-profile tuning).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

# ── Vector / schema identity ────────────────────────────────────────────────
# Hermes owns its own retrieval schema — this is deliberately NOT the legacy
# advance-backend value ("retrieval-v3"). Hermes never reads/writes the legacy
# collection; it indexes into its own store (pgvector on Hermes Postgres by
# default), so the schema identity is Hermes's own.
ACTIVE_EMBEDDING_SCHEMA_VERSION = "hermes-rag-v1"
PRIMARY_TEXT_VECTOR_NAME = "dense_text_v2"
MULTIMODAL_VECTOR_NAME = "dense_mm_v1"
MULTIMODAL_VECTOR_SIZE = 3072

# Source types stored on each point's payload (subset we read/write).
SOURCE_TYPE_FILE = "file_document"
SOURCE_TYPE_CHAT = "chat_turn"
ZOHO_SOURCE_TYPES = (
    "zoho_lead",
    "zoho_contact",
    "zoho_account",
    "zoho_deal",
    "zoho_ticket",
)


@dataclass(frozen=True)
class RetrievalProfile:
    """Per-profile candidate-pool + rerank tuning (mirrors RETRIEVAL_PROFILE_CONFIG)."""

    branch_limit: int
    group_limit: int
    group_size: int
    rerank_top_n: int
    final_top_k: int
    rerank_required: bool
    use_multimodal: bool


RETRIEVAL_PROFILES: dict[str, RetrievalProfile] = {
    "zoho": RetrievalProfile(24, 8, 3, 24, 6, True, False),
    "file": RetrievalProfile(24, 6, 3, 24, 6, True, True),
    "chat": RetrievalProfile(12, 6, 3, 12, 4, False, False),
}


@dataclass
class SearchResult:
    """One Qdrant hit, normalized for the broker."""

    id: str
    score: float
    source_type: str
    source_id: str
    chunk_index: int
    visibility: str
    payload: dict[str, Any] = field(default_factory=dict)
    document_key: Optional[str] = None
    owner_user_id: Optional[str] = None
    conversation_key: Optional[str] = None
    allowed_roles: Optional[list[str]] = None


@dataclass
class SearchGroup:
    """A group of hits sharing one ``group_by`` value (default documentKey)."""

    group_value: str
    hits: list[SearchResult] = field(default_factory=list)


@dataclass
class VectorQuery:
    """Inputs to :meth:`rag.vector_store.QdrantStore.search` (mirrors VectorSearchQuery)."""

    company_id: str
    dense_vector: list[float]
    limit: int = 6
    requester_user_id: Optional[str] = None
    requester_email: Optional[str] = None
    requester_ai_role: Optional[str] = None
    candidate_limit: Optional[int] = None
    schema_version: str = ACTIVE_EMBEDDING_SCHEMA_VERSION
    retrieval_profile: Optional[str] = None
    query_mode: str = "text"  # 'text' | 'multimodal' | 'hybrid_text_mm'
    file_asset_id: Optional[str] = None
    conversation_key: Optional[str] = None
    use_multimodal: bool = False
    fusion: str = "dbsf"  # 'dbsf' | 'rrf'
    group_by_field: str = "documentKey"
    group_size: int = 3
    score_threshold: Optional[float] = None
    source_types: tuple[str, ...] = ()
    include_personal: bool = True
    include_shared: bool = True
    include_public: bool = True
    enforce_email_match: bool = False
    date_from: Optional[str] = None
    date_to: Optional[str] = None


@dataclass
class UpsertRecord:
    """One chunk to write (mirrors VectorUpsertInput; the fields ingestion fills)."""

    company_id: str
    source_type: str
    source_id: str
    chunk_index: int
    content_hash: str
    dense_embedding: list[float]
    visibility: str = "shared"
    document_key: Optional[str] = None
    owner_user_id: Optional[str] = None
    conversation_key: Optional[str] = None
    file_asset_id: Optional[str] = None
    connection_id: Optional[str] = None
    reference_emails: Optional[list[str]] = None
    allowed_roles: Optional[list[str]] = None
    title: Optional[str] = None
    content: Optional[str] = None
    source_updated_at: Optional[str] = None
    embedding_schema_version: str = ACTIVE_EMBEDDING_SCHEMA_VERSION
    retrieval_profile: Optional[str] = None
    multimodal_embedding: Optional[list[float]] = None
    payload: dict[str, Any] = field(default_factory=dict)
