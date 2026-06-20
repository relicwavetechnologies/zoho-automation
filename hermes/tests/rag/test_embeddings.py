"""Embedding provider + service tests (hermetic, injected fake HTTP)."""

import pytest

from rag.embeddings import (
    EmbeddingService,
    FallbackEmbeddingProvider,
    GeminiEmbeddingProvider,
    GEMINI_DIMENSION,
    OpenAIEmbeddingProvider,
    make_embedding_provider,
)
from rag.config import RagConfig
from tests.rag.fakes import FakeAsyncClient, FakeResponse


def _cfg(**over) -> RagConfig:
    base = dict(
        vector_backend="qdrant", qdrant_url="https://q", qdrant_api_key="k", qdrant_collection="hermes_documents_v1",
        qdrant_timeout_ms=10000, embedding_provider="gemini", gemini_api_key="g",
        gemini_embedding_model="gemini-embedding-001",
        gemini_multimodal_model="gemini-embedding-2-preview",
        gemini_vision_model="gemini-3.1-flash-lite", openai_api_key=None,
        openai_embedding_model="text-embedding-3-small", groq_api_key=None,
        groq_rerank_model="llama-3.1-8b-instant", grade_threshold=3,
        full_read_max_chars=18000, max_rewrites=1, rewrite_enabled=True,
        grading_enabled=True, chunk_search_enabled=True, full_read_enabled=True,
        multimodal_enabled=True, doc_extract_max_words=100000, doc_upload_max_mb=24,
    )
    base.update(over)
    return RagConfig(**base)


def test_fallback_is_deterministic_and_sized():
    p = FallbackEmbeddingProvider(dimension=8)
    import asyncio

    a = asyncio.run(p.embed_queries(["hello world"]))
    b = asyncio.run(p.embed_queries(["hello world"]))
    assert a == b
    assert len(a[0]) == 8
    assert asyncio.run(p.embed_queries([""]))[0] == [0.0] * 8


@pytest.mark.asyncio
async def test_gemini_parses_batch_embeddings():
    http = FakeAsyncClient(
        handler=lambda m, u, j: FakeResponse(
            200, {"embeddings": [{"values": [0.1] * GEMINI_DIMENSION}]}
        )
    )
    p = GeminiEmbeddingProvider(api_key="g", text_model="gemini-embedding-001", http=http)
    out = await p.embed_queries(["q"])
    assert len(out) == 1 and len(out[0]) == GEMINI_DIMENSION
    # RETRIEVAL_QUERY task type is requested for queries.
    assert http.calls[-1]["json"]["requests"][0]["taskType"] == "RETRIEVAL_QUERY"


@pytest.mark.asyncio
async def test_gemini_pads_short_vectors_to_dimension():
    http = FakeAsyncClient(handler=lambda m, u, j: FakeResponse(200, {"embeddings": [{"values": [0.5, 0.6]}]}))
    p = GeminiEmbeddingProvider(api_key="g", text_model="m", http=http)
    out = await p.embed_documents(["d"])
    assert len(out[0]) == GEMINI_DIMENSION
    assert out[0][:2] == [0.5, 0.6]


@pytest.mark.asyncio
async def test_openai_sorts_by_index_and_fits_dimension():
    http = FakeAsyncClient(
        handler=lambda m, u, j: FakeResponse(
            200, {"data": [{"index": 1, "embedding": [9.0]}, {"index": 0, "embedding": [1.0]}]}
        )
    )
    p = OpenAIEmbeddingProvider(api_key="o", model="text-embedding-3-small", http=http)
    out = await p.embed_documents(["a", "b"])
    assert out[0][0] == 1.0 and out[1][0] == 9.0  # reordered by index
    assert len(out[0]) == 1536


@pytest.mark.asyncio
async def test_service_substitutes_on_batch_failure():
    http = FakeAsyncClient(handler=lambda m, u, j: FakeResponse(500, {}, text="boom"))
    provider = GeminiEmbeddingProvider(api_key="g", text_model="m", http=http)
    svc = EmbeddingService(provider, batch_size=2)
    out = await svc.embed_queries(["x", "y", "z"])
    assert len(out) == 3  # never drops items
    assert all(len(v) == GEMINI_DIMENSION for v in out)  # deterministic fill


def test_provider_selection_precedence():
    assert make_embedding_provider(_cfg(embedding_provider="fallback")).provider == "fallback"
    assert make_embedding_provider(_cfg(embedding_provider="gemini", gemini_api_key="g")).provider == "gemini"
    assert (
        make_embedding_provider(
            _cfg(embedding_provider="openai", gemini_api_key=None, openai_api_key="o")
        ).provider
        == "openai"
    )
    # No keys at all → fallback.
    assert make_embedding_provider(_cfg(gemini_api_key=None, openai_api_key=None)).provider == "fallback"
