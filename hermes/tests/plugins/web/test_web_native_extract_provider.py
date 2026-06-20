"""Unit tests for the free built-in 'native' extract provider. Offline —
``tools.web_quality.fetch_page_content`` is monkeypatched; no network."""

from __future__ import annotations

import pytest

from plugins.web.native_extract.provider import NativeExtractProvider


class TestNativeExtractProvider:
    def test_metadata_and_capabilities(self) -> None:
        p = NativeExtractProvider()
        assert p.name == "native"
        assert p.supports_search() is False
        assert p.supports_extract() is True
        # No credentials needed — always available as the free extract fallback.
        assert p.is_available() is True

    def test_extract_returns_content(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            "tools.web_quality.fetch_page_content",
            lambda url, **kw: {
                "title": "Canberra - Wikipedia",
                "meta_description": "Capital of Australia",
                "content": "Canberra is the capital city of Australia.",
            },
        )
        out = NativeExtractProvider().extract(["https://en.wikipedia.org/wiki/Canberra"])
        assert len(out) == 1
        r = out[0]
        assert r["url"] == "https://en.wikipedia.org/wiki/Canberra"
        assert r["title"] == "Canberra - Wikipedia"
        assert "capital city of Australia" in r["content"]
        # raw_content mirrors content; metadata carries the meta description.
        assert r["raw_content"] == r["content"]
        assert r["metadata"]["description"] == "Capital of Australia"
        assert "error" not in r

    def test_extract_reports_per_url_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            "tools.web_quality.fetch_page_content", lambda url, **kw: None
        )
        out = NativeExtractProvider().extract(["https://blocked.example"])
        assert len(out) == 1
        assert out[0]["content"] == ""
        assert "error" in out[0]

    def test_extract_empty_list(self) -> None:
        assert NativeExtractProvider().extract([]) == []

    def test_extract_mixed_results(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def fake(url, **kw):
            if "good" in url:
                return {"title": "Good", "meta_description": "", "content": "good content"}
            return None

        monkeypatch.setattr("tools.web_quality.fetch_page_content", fake)
        out = NativeExtractProvider().extract(
            ["https://good.example", "https://bad.example"]
        )
        by_url = {r["url"]: r for r in out}
        assert by_url["https://good.example"]["content"] == "good content"
        assert "error" in by_url["https://bad.example"]
