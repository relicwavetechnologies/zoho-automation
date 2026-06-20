"""Reranker tests + DocumentRagBroker end-to-end with injected fakes."""

import pytest

from rag.config import RagConfig
from rag.document_rag import DocumentRagBroker
from rag.reranker import GroqReranker, _score_sort_fallback
from rag.types import SOURCE_TYPE_FILE, SearchGroup, SearchResult
from tests.rag.fakes import FakeAsyncClient, FakeResponse


def _result(rid, score, text, name="Doc.pdf"):
    return SearchResult(
        id=rid,
        score=score,
        source_type=SOURCE_TYPE_FILE,
        source_id="f1",
        chunk_index=0,
        visibility="shared",
        payload={"chunkText": text, "fileName": name, "fileAssetId": "f1", "sectionPath": ["3", "Refunds"]},
    )


def _cfg(**over) -> RagConfig:
    base = dict(
        vector_backend="qdrant", qdrant_url="https://q", qdrant_api_key="k", qdrant_collection="hermes_documents_v1",
        qdrant_timeout_ms=10000, embedding_provider="fallback", gemini_api_key=None,
        gemini_embedding_model="m", gemini_multimodal_model="mm", gemini_vision_model="v",
        openai_api_key=None, openai_embedding_model="text-embedding-3-small", groq_api_key=None,
        groq_rerank_model="llama-3.1-8b-instant", grade_threshold=3, full_read_max_chars=18000,
        max_rewrites=1, rewrite_enabled=True, grading_enabled=True, chunk_search_enabled=True,
        full_read_enabled=True, multimodal_enabled=True, doc_extract_max_words=100000, doc_upload_max_mb=24,
    )
    base.update(over)
    return RagConfig(**base)


@pytest.mark.asyncio
async def test_reranker_filters_by_threshold_and_sorts():
    http = FakeAsyncClient(
        handler=lambda m, u, j: FakeResponse(
            200, {"choices": [{"message": {"content": "[9, 1, 5]"}}]}
        )
    )
    rr = GroqReranker(api_key="g", threshold=3, http=http)
    chunks = [_result("a", 0.5, "x"), _result("b", 0.5, "y"), _result("c", 0.5, "z")]
    ranked = await rr.rerank("q", chunks)
    assert [r.chunk.id for r in ranked] == ["a", "c"]  # 1 dropped (<3), sorted desc


@pytest.mark.asyncio
async def test_reranker_falls_back_on_bad_json():
    http = FakeAsyncClient(handler=lambda m, u, j: FakeResponse(200, {"choices": [{"message": {"content": "nope"}}]}))
    rr = GroqReranker(api_key="g", http=http)
    chunks = [_result("a", 0.9, "x"), _result("b", 0.2, "y")]
    ranked = await rr.rerank("q", chunks)
    assert [r.chunk.id for r in ranked] == ["a", "b"]  # score-sort fallback keeps all


@pytest.mark.asyncio
async def test_reranker_no_key_uses_score_sort():
    rr = GroqReranker(api_key=None)
    ranked = await rr.rerank("q", [_result("a", 0.3, "x"), _result("b", 0.8, "y")])
    assert [r.chunk.id for r in ranked] == ["b", "a"]


class _FakeEmbedder:
    dimension = 8

    async def embed_queries(self, texts):
        return [[0.1] * 8 for _ in texts]

    async def embed_query(self, text):
        return [0.1] * 8


class _FakeStore:
    def __init__(self, groups):
        self._groups = groups
        self.searches = 0

    async def search(self, query):
        self.searches += 1
        return self._groups


class _FakeReranker:
    async def rerank(self, query, chunks):
        from rag.reranker import RankedChunk

        ranked = [RankedChunk(chunk=c, reranker_score=c.score * 10) for c in chunks]
        ranked.sort(key=lambda r: r.reranker_score, reverse=True)
        return ranked


@pytest.mark.asyncio
async def test_broker_search_returns_cited_results():
    groups = [SearchGroup("g", [_result("a", 0.9, "Refunds are within 30 days."), _result("b", 0.7, "Other")])]
    broker = DocumentRagBroker(
        embedder=_FakeEmbedder(), store=_FakeStore(groups), reranker=_FakeReranker(), config=_cfg()
    )
    out = await broker.search(query="refund policy", company_id="c1", limit=6)
    assert out["success"] and out["operation"] == "search"
    assert out["results"][0]["fileName"] == "Doc.pdf"
    assert out["results"][0]["citation"] == "[Doc.pdf § 3 > Refunds]"
    assert out["results"][0]["score"] == pytest.approx(9.0)


@pytest.mark.asyncio
async def test_broker_search_empty_message():
    broker = DocumentRagBroker(
        embedder=_FakeEmbedder(), store=_FakeStore([]), reranker=_FakeReranker(), config=_cfg()
    )
    out = await broker.search(query="anything", company_id="c1")
    assert out["success"] and out["results"] == []
    assert "No relevant" in out["message"]


@pytest.mark.asyncio
async def test_broker_corrective_retry_when_thin():
    # grading on, fewer than 2 results first pass → broaden + re-search.
    groups = [SearchGroup("g", [_result("a", 0.9, "only one")])]
    store = _FakeStore(groups)
    broker = DocumentRagBroker(
        embedder=_FakeEmbedder(), store=store, reranker=_FakeReranker(), config=_cfg()
    )
    await broker.search(query="exact verbatim termination clause", company_id="c1")
    # first pass (>=1 expanded variant) + at least one broadened retry search
    assert store.searches >= 2
