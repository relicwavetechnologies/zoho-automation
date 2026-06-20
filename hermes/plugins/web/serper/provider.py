"""Serper (Google SERP) search — plugin form.

Subclasses :class:`agent.web_search_provider.WebSearchProvider`. Serper.dev
proxies Google Search and returns rich SERP JSON (organic results plus an
``answerBox`` / ``knowledgeGraph`` when Google surfaces a direct answer). It is
the provider the legacy ``advance-backend`` runtime used; ported here so the
same generous free tier (~2,500 queries/month) is available as a high-quality
search source — and so its raw output can be compared head-to-head against the
free providers + quality layer.

Search-only — Serper returns SERP metadata, not full page content. Pair with
the web_search quality layer (top-N page enrichment) or a dedicated extract
backend (firecrawl / tavily / exa) for ``web_extract``.

Config keys this provider responds to::

    web:
      search_backend: "serper"     # explicit per-capability
      backend: "serper"            # shared fallback

Auth env var::

    SERPER_API_KEY=...    # https://serper.dev (free tier ~2.5k queries/month)

Optional tuning env vars::

    SERPER_GL=us          # Google country code
    SERPER_HL=en          # interface language
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

from agent.web_search_provider import WebSearchProvider

logger = logging.getLogger(__name__)

_SERPER_ENDPOINT = "https://google.serper.dev/search"


class SerperWebSearchProvider(WebSearchProvider):
    """Search-only Serper (Google SERP) provider."""

    @property
    def name(self) -> str:
        return "serper"

    @property
    def display_name(self) -> str:
        return "Serper (Google)"

    def is_available(self) -> bool:
        """Return True when ``SERPER_API_KEY`` is set to a non-empty value."""
        return bool(os.getenv("SERPER_API_KEY", "").strip())

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        """Execute a Google search via Serper.

        Returns the canonical
        ``{"success": True, "data": {"web": [...]}}`` shape. When Google
        surfaces a direct answer, its text is also exposed as
        ``data["answer"]`` (and folded into the first result's description) so
        the high-value answer-box signal is not lost.
        """
        import httpx

        api_key = os.getenv("SERPER_API_KEY", "").strip()
        if not api_key:
            return {"success": False, "error": "SERPER_API_KEY is not set"}

        # Serper caps num at 100; request a few extra so dedupe/rerank in the
        # quality layer has headroom, then trim to `limit` below.
        num = max(1, min(int(limit), 100))

        try:
            resp = httpx.post(
                _SERPER_ENDPOINT,
                headers={
                    "X-API-KEY": api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "q": query,
                    "num": num,
                    "gl": os.getenv("SERPER_GL", "us").strip() or "us",
                    "hl": os.getenv("SERPER_HL", "en").strip() or "en",
                    "autocorrect": True,
                },
                timeout=15,
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.warning("Serper HTTP error: %s", exc)
            return {
                "success": False,
                "error": f"Serper returned HTTP {exc.response.status_code}",
            }
        except httpx.RequestError as exc:
            logger.warning("Serper request error: %s", exc)
            return {"success": False, "error": f"Could not reach Serper: {exc}"}

        try:
            data = resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Serper response parse error: %s", exc)
            return {"success": False, "error": "Serper returned invalid JSON"}

        organic = data.get("organic") or []
        truncated = organic[:limit]

        web_results: List[Dict[str, Any]] = [
            {
                "title": str(r.get("title", "")),
                "url": str(r.get("link", "")),
                "description": str(r.get("snippet", "")),
                "position": i + 1,
                **({"date": str(r["date"])} if r.get("date") else {}),
            }
            for i, r in enumerate(truncated)
        ]

        result: Dict[str, Any] = {"success": True, "data": {"web": web_results}}

        # Surface Google's direct answer (answerBox / knowledgeGraph) — Serper's
        # main quality edge over plain organic snippets.
        answer = _extract_answer(data)
        if answer:
            result["data"]["answer"] = answer
            if web_results:
                snippet = web_results[0].get("description", "")
                if answer not in snippet:
                    web_results[0]["description"] = (
                        f"{answer}\n\n{snippet}".strip()
                    )

        logger.info(
            "Serper search '%s': %d results (from %d organic, limit %d, answer=%s)",
            query,
            len(web_results),
            len(organic),
            limit,
            bool(answer),
        )

        return result

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "Serper (Google)",
            "badge": "free tier",
            "tag": "Google SERP via serper.dev — ~2.5k queries/mo free, search only.",
            "env_vars": [
                {
                    "key": "SERPER_API_KEY",
                    "prompt": "Serper API key (free tier at serper.dev)",
                    "url": "https://serper.dev",
                },
            ],
        }


def _extract_answer(data: Dict[str, Any]) -> str:
    """Pull a concise direct answer from Serper's answerBox / knowledgeGraph."""
    box = data.get("answerBox") or {}
    if isinstance(box, dict):
        for key in ("answer", "snippet", "snippetHighlighted", "title"):
            val = box.get(key)
            if isinstance(val, list):
                val = " ".join(str(v) for v in val)
            if isinstance(val, str) and val.strip():
                return val.strip()

    kg = data.get("knowledgeGraph") or {}
    if isinstance(kg, dict):
        desc = kg.get("description")
        if isinstance(desc, str) and desc.strip():
            title = str(kg.get("title", "")).strip()
            return f"{title}: {desc.strip()}" if title else desc.strip()

    return ""
