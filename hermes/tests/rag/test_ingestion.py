"""Ingestion tests — classify, chunk, extract, and the embed→upsert service."""

import pytest

from rag.config import RagConfig
from rag.ingestion.chunking import (
    build_indexed_chunks,
    choose_chunking_plan,
    classify_file_document,
)
from rag.ingestion.extract import ExtractedDocument, extract_from_buffer
from rag.ingestion.ingest import IngestionService
from rag.vector_store import build_point_id


def _cfg() -> RagConfig:
    return RagConfig(
        vector_backend="qdrant", qdrant_url="https://q", qdrant_api_key="k", qdrant_collection="hermes_documents_v1",
        qdrant_timeout_ms=10000, embedding_provider="fallback", gemini_api_key=None,
        gemini_embedding_model="m", gemini_multimodal_model="mm", gemini_vision_model="v",
        openai_api_key=None, openai_embedding_model="text-embedding-3-small", groq_api_key=None,
        groq_rerank_model="llama-3.1-8b-instant", grade_threshold=3, full_read_max_chars=18000,
        max_rewrites=1, rewrite_enabled=True, grading_enabled=True, chunk_search_enabled=True,
        full_read_enabled=True, multimodal_enabled=True, doc_extract_max_words=100000, doc_upload_max_mb=24,
    )


def test_classification_matches_legacy_keywords():
    assert classify_file_document(file_name="Leave Policy.pdf", mime_type="application/pdf", text="leave policy") == "policy"
    assert classify_file_document(file_name="MSA.pdf", mime_type="application/pdf", text="this agreement msa") == "contract"
    assert classify_file_document(file_name="pic.png", mime_type="image/png", text="") == "media_summary"
    assert classify_file_document(file_name="notes.txt", mime_type="text/plain", text="hello") == "generic_text"


def test_plan_selection_by_class():
    policy = choose_chunking_plan(file_name="Policy.pdf", mime_type="application/pdf", text="refund policy")
    assert policy.strategy == "hybrid_structured" and policy.hierarchical and policy.child_target_tokens == 480
    generic = choose_chunking_plan(file_name="n.txt", mime_type="text/plain", text="x")
    assert generic.strategy == "semantic_heading" and generic.child_target_tokens == 720


def test_chunking_sections_and_context_prefix():
    text = (
        "# Refund Policy\n\n"
        "Customers may request a refund within 30 days of purchase.\n\n"
        "## Exceptions\n\n"
        "Digital goods are non-refundable once downloaded."
    )
    plan = choose_chunking_plan(file_name="Refund Policy.md", mime_type="text/markdown", text=text)
    chunks = build_indexed_chunks(
        company_id="c1", file_asset_id="f1", file_name="Refund Policy.md",
        mime_type="text/markdown", source_url="http://x", uploader_user_id="u1", text=text, plan=plan,
    )
    assert chunks, "should produce chunks"
    # Section path captured + contextual prefix prepended to indexed (embedded) text.
    assert any(c.section_path for c in chunks)
    enriched = [c for c in chunks if c.payload["contextualEnrichmentApplied"]]
    assert enriched and enriched[0].indexed_text.startswith('Document "Refund Policy.md"')
    # Raw text preserved separately from indexed text (for citations).
    assert enriched[0].raw_chunk_text in (
        "Customers may request a refund within 30 days of purchase.",
        "Digital goods are non-refundable once downloaded.",
    )


def test_chunk_id_matches_point_id_scheme_inputs():
    # The chunk id is content-stable; the Qdrant point id is computed from the
    # compound key. Both must be deterministic for idempotent re-ingest.
    text = "Some plain body text that is short."
    plan = choose_chunking_plan(file_name="a.txt", mime_type="text/plain", text=text)
    a = build_indexed_chunks(company_id="c1", file_asset_id="f1", file_name="a.txt", mime_type="text/plain", source_url="", uploader_user_id=None, text=text, plan=plan)
    b = build_indexed_chunks(company_id="c1", file_asset_id="f1", file_name="a.txt", mime_type="text/plain", source_url="", uploader_user_id=None, text=text, plan=plan)
    assert [c.id for c in a] == [c.id for c in b]  # deterministic
    pid = build_point_id("c1", "file_document", "f1", a[0].chunk_index)
    assert pid and pid != a[0].id  # different schemes, both stable


def test_extract_html_and_csv():
    html = extract_from_buffer(buffer=b"<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>", mime_type="text/html")
    assert "Title" in html.text and "Hello" in html.text and "<" not in html.text
    csv_doc = extract_from_buffer(buffer=b"name,email\nAda,ada@x.com", mime_type="text/csv")
    assert "name | email" in csv_doc.text and "Ada | ada@x.com" in csv_doc.text


def test_extract_image_returns_empty_text_hook():
    doc = extract_from_buffer(buffer=b"\x89PNG", mime_type="image/png", file_name="x.png")
    assert isinstance(doc, ExtractedDocument) and doc.modality == "image" and doc.text == ""


class _FakeStore:
    def __init__(self):
        self.records = None

    async def upsert_vectors(self, records):
        self.records = records


class _FakeEmbedder:
    dimension = 8

    async def embed_documents(self, texts):
        return [[0.1] * 8 for _ in texts]


@pytest.mark.asyncio
async def test_ingest_text_embeds_and_upserts():
    store = _FakeStore()
    svc = IngestionService(embedder=_FakeEmbedder(), store=store, config=_cfg())
    text = "# Heading\n\n" + " ".join(["word"] * 50)
    result = await svc.ingest_text(company_id="c1", file_name="doc.md", text=text, mime_type="text/markdown")
    assert result.success and result.chunks_indexed >= 1
    assert store.records is not None
    rec = store.records[0]
    assert rec.source_type == "file_document" and rec.company_id == "c1"
    assert len(rec.dense_embedding) == 8
    assert rec.payload["embeddingSchemaVersion"] == "hermes-rag-v1"
