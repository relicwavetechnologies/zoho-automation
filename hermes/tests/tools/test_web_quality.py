"""Unit tests for the web search quality layer (tools.web_quality).

All offline — no network. Enrichment is exercised with ``enrich=False`` (the
fetch path is integration-tested via scripts/eval_web_search.py); extraction is
tested against inline HTML.
"""

from __future__ import annotations

from tools.web_quality import (
    dedupe_web_results,
    enhance_search_results,
    extract_main_text,
    normalize_url,
    rerank_results,
)


class TestNormalizeUrl:
    def test_strips_tracking_params(self) -> None:
        url = "https://example.com/post?utm_source=x&id=42&fbclid=abc&ref=home"
        # id is content-bearing and kept; utm_/fbclid/ref are dropped.
        assert normalize_url(url) == "https://example.com/post?id=42"

    def test_strips_www_fragment_and_trailing_slash(self) -> None:
        assert (
            normalize_url("https://www.Example.com/Path/#section")
            == "https://example.com/Path"
        )

    def test_strips_default_port_keeps_custom(self) -> None:
        assert normalize_url("http://example.com:80/a") == "http://example.com/a"
        assert normalize_url("http://example.com:8080/a") == "http://example.com:8080/a"

    def test_non_url_passthrough(self) -> None:
        assert normalize_url("not a url") == "not a url"
        assert normalize_url("") == ""


class TestDedupe:
    def test_dedupes_by_canonical_url_keeps_first(self) -> None:
        results = [
            {"title": "A", "url": "https://example.com/x?utm_source=g", "position": 1},
            {"title": "B", "url": "https://www.example.com/x/", "position": 2},  # dup
            {"title": "C", "url": "https://other.com/y", "position": 3},
        ]
        out = dedupe_web_results(results)
        assert [r["title"] for r in out] == ["A", "C"]
        assert [r["position"] for r in out] == [1, 2]


class TestExtract:
    def test_regex_fallback_extracts_title_meta_and_body(self) -> None:
        html = """
        <html><head><title>My Title</title>
        <meta name="description" content="A short summary."></head>
        <body><nav>menu home about</nav>
        <main><p>First real paragraph of content.</p>
        <p>Second paragraph here.</p></main>
        <footer>copyright junk</footer></body></html>
        """
        title, meta, excerpt = extract_main_text(html, max_chars=500)
        assert title == "My Title"
        assert meta == "A short summary."
        assert "First real paragraph" in excerpt
        # Chrome (nav/footer) is dropped by the regex extractor.
        assert "copyright junk" not in excerpt
        assert "menu home about" not in excerpt

    def test_truncates_on_word_boundary(self) -> None:
        html = "<html><body><main>" + ("word " * 200) + "</main></body></html>"
        _, _, excerpt = extract_main_text(html, max_chars=50)
        assert len(excerpt) <= 60  # max_chars + ellipsis slack
        assert excerpt.endswith("…")

    def test_empty_html(self) -> None:
        assert extract_main_text("", 100) == ("", "", "")


class TestRerankFusion:
    def test_engine_prior_dominates_keyword_dense_junk(self) -> None:
        """A keyword-dense page ranked low by the engine must NOT leapfrog the
        authoritative engine-#1 on lexical density alone (the regression that
        rank fusion fixes)."""
        query = "claude opus pricing release"
        results = [
            {
                "title": "Introducing Claude Opus — Anthropic",
                "url": "https://anthropic.com/opus",
                "description": "Claude Opus pricing and release info.",
                "position": 1,
            },
            {
                "title": "SEO spam",
                "url": "https://spam.example/claude",
                "description": "",
                # Junk page stuffed with query terms in its body.
                "content": "claude opus pricing release " * 30,
                "position": 5,
            },
        ]
        out = rerank_results(query, results)
        assert out[0]["url"] == "https://anthropic.com/opus"

    def test_refines_tail_without_unseating_engine_top(self) -> None:
        """Fusion refines the tail: a relevant lower result overtakes an
        irrelevant higher one — while the engine's trusted #1 stays #1
        (we fully trust the upstream top pick; lexical only reorders 2..N)."""
        query = "postgres connection pooling node"
        results = [
            {
                "title": "Postgres pooling guide",
                "url": "https://top.example",
                "description": "postgres connection pooling node overview",
                "position": 1,
            },
            {
                "title": "Unrelated weather page",
                "url": "https://mid.example",
                "description": "today's forecast",
                "position": 2,
            },
            {
                "title": "Deep dive: Node.js postgres connection pooling",
                "url": "https://low.example",
                "description": "configure a postgres connection pool in node",
                "content": "postgres connection pooling node best practices guide",
                "position": 3,
            },
        ]
        out = rerank_results(query, results)
        # Engine #1 protected; the relevant pos-3 overtakes the irrelevant pos-2.
        assert out[0]["url"] == "https://top.example"
        assert out[1]["url"] == "https://low.example"
        assert out[2]["url"] == "https://mid.example"

    def test_noop_on_single_result(self) -> None:
        results = [{"title": "x", "url": "https://a.example", "position": 1}]
        assert rerank_results("anything", results) == results


class TestEnhanceOrchestrator:
    def test_noop_on_error_response(self) -> None:
        resp = {"success": False, "error": "boom"}
        assert enhance_search_results("q", resp) == resp

    def test_noop_on_empty_web(self) -> None:
        resp = {"success": True, "data": {"web": []}}
        assert enhance_search_results("q", resp) == resp

    def test_dedupes_without_enrich(self) -> None:
        resp = {
            "success": True,
            "data": {
                "web": [
                    {"title": "A", "url": "https://x.example/p?utm_source=g", "description": "alpha", "position": 1},
                    {"title": "B", "url": "https://www.x.example/p/", "description": "beta", "position": 2},
                    {"title": "C", "url": "https://y.example/q", "description": "gamma", "position": 3},
                ]
            },
        }
        out = enhance_search_results("q", resp, enrich=False, rerank=False)
        urls = [r["url"] for r in out["data"]["web"]]
        assert len(urls) == 2  # the dup was removed
