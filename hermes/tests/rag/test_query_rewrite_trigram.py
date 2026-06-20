"""Pure-function tests for query rewriting + trigram filename matching."""

from rag.query_rewrite import (
    broaden_document_search_query,
    build_document_search_queries,
    looks_like_exact_document_query,
)
from rag.trigram import (
    TRIGRAM_STRONG_THRESHOLD,
    rank_by_trigram,
    trigram_similarity,
)


def test_expansion_focuses_and_adds_exact_variants():
    out = build_document_search_queries("exact refund clause")
    assert out, "should produce variants"
    assert out[0] == "exact refund clause"  # raw normalized query is first (legacy Set order)
    joined = " | ".join(out).lower()
    assert "section" in joined and "policy" in joined  # exact-intent variants appended
    assert len(out) <= 6


def test_expansion_dedupes_and_caps():
    out = build_document_search_queries("policy policy policy compliance rule")
    assert len(out) == len(set(q.lower() for q in out))


def test_exact_document_query_detection():
    assert looks_like_exact_document_query("give me the exact cancellation clause")
    assert looks_like_exact_document_query("show me section 3 verbatim")
    assert not looks_like_exact_document_query("what is our refund policy")


def test_broaden_strips_exactness_markers():
    broad = broaden_document_search_query("exact verbatim termination clause wording details")
    low = broad.lower()
    assert "exact" not in low and "verbatim" not in low and "wording" not in low
    assert "termination" in low  # content kept
    assert "section" in low  # clause → section rewrite (legacy parity)


def test_trigram_strong_token_containment():
    score = trigram_similarity("mr market", "Mr. Market Functional Doc.pdf")
    assert score >= TRIGRAM_STRONG_THRESHOLD


def test_trigram_ignores_file_type_words():
    score = trigram_similarity("the html file", "conscious_product_demo.html")
    # "html"/"file"/"the" are filtered → no meaningful tokens overlap → weak.
    assert score < TRIGRAM_STRONG_THRESHOLD


def test_rank_by_trigram_sorts_and_filters():
    ranked = rank_by_trigram(
        "sales report",
        ["Q3 Sales Report.pdf", "random notes.txt", "Sales Report 2024.xlsx"],
    )
    assert ranked[0][1] >= ranked[-1][1]
    assert all(score >= 0.2 for _name, score in ranked)
    assert "random notes.txt" not in [name for name, _ in ranked]
