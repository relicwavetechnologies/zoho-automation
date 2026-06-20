"""Unit tests for the Serper (Google SERP) web search provider. Offline —
``httpx.post`` is monkeypatched; no network."""

from __future__ import annotations

import httpx
import pytest

from plugins.web.serper.provider import SerperWebSearchProvider


class _FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "err", request=None, response=self  # type: ignore[arg-type]
            )

    def json(self) -> dict:
        return self._payload


def _patch_post(monkeypatch, payload: dict) -> dict:
    captured: dict = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        captured["headers"] = kwargs.get("headers")
        return _FakeResponse(payload)

    monkeypatch.setattr(httpx, "post", fake_post)
    return captured


class TestSerperProvider:
    def test_metadata(self) -> None:
        p = SerperWebSearchProvider()
        assert p.name == "serper"
        assert p.supports_search() is True
        assert p.supports_extract() is False

    def test_requires_api_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("SERPER_API_KEY", raising=False)
        p = SerperWebSearchProvider()
        assert p.is_available() is False
        out = p.search("hello", 3)
        assert out["success"] is False
        assert "SERPER_API_KEY" in out["error"]

    def test_maps_organic_results(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SERPER_API_KEY", "k")
        captured = _patch_post(
            monkeypatch,
            {
                "organic": [
                    {"title": "T1", "link": "https://a.example", "snippet": "s1", "position": 1},
                    {"title": "T2", "link": "https://b.example", "snippet": "s2", "date": "Nov 24, 2025"},
                ]
            },
        )
        out = SerperWebSearchProvider().search("q", 5)
        assert out["success"] is True
        web = out["data"]["web"]
        assert [r["url"] for r in web] == ["https://a.example", "https://b.example"]
        assert [r["position"] for r in web] == [1, 2]
        assert web[1]["date"] == "Nov 24, 2025"
        # Request shape mirrors advance-backend's client.
        assert captured["url"] == "https://google.serper.dev/search"
        assert captured["headers"]["X-API-KEY"] == "k"
        assert captured["json"]["q"] == "q"

    def test_surfaces_answer_box(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SERPER_API_KEY", "k")
        _patch_post(
            monkeypatch,
            {
                "answerBox": {"answer": "Canberra"},
                "organic": [
                    {"title": "Canberra - Wikipedia", "link": "https://en.wikipedia.org/wiki/Canberra", "snippet": "capital city"},
                ],
            },
        )
        out = SerperWebSearchProvider().search("capital of australia", 5)
        assert out["data"]["answer"] == "Canberra"
        # The answer is folded into the top result's description.
        assert "Canberra" in out["data"]["web"][0]["description"]

    def test_knowledge_graph_fallback_answer(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SERPER_API_KEY", "k")
        _patch_post(
            monkeypatch,
            {
                "knowledgeGraph": {"title": "Canberra", "description": "Capital of Australia"},
                "organic": [{"title": "x", "link": "https://x.example", "snippet": "y"}],
            },
        )
        out = SerperWebSearchProvider().search("canberra", 5)
        assert "Capital of Australia" in out["data"]["answer"]

    def test_truncates_to_limit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SERPER_API_KEY", "k")
        _patch_post(
            monkeypatch,
            {"organic": [{"title": f"T{i}", "link": f"https://e{i}.example", "snippet": "s"} for i in range(10)]},
        )
        out = SerperWebSearchProvider().search("q", 3)
        assert len(out["data"]["web"]) == 3
