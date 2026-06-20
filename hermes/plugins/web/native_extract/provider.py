"""Built-in (free) web content extractor — plugin form.

The free search providers (serper, ddgs, searxng, brave-free) are search-only,
which left the second half of the standard two-step web flow — search → extract
— working ONLY for users with a paid extract backend (firecrawl / tavily / exa /
parallel). This provider closes that gap: it fetches each URL directly and
extracts clean main-text with **trafilatura** (regex fallback), so ``web_extract``
works with no API key at all.

Extract-only — pair with any search provider. Requires no env var; it is always
available (httpx + trafilatura are core deps), so it serves as the default free
extract backend when nothing paid is configured.

Config keys this provider responds to::

    web:
      extract_backend: "native"    # explicit per-capability
      backend: "native"            # shared fallback
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List

from agent.web_search_provider import WebSearchProvider

logger = logging.getLogger(__name__)

# Per-URL fetch timeout (generous — extract is an explicit, on-demand read).
_EXTRACT_TIMEOUT = 15.0
_MAX_WORKERS = 6


class NativeExtractProvider(WebSearchProvider):
    """Free, dependency-light URL content extractor (httpx + trafilatura)."""

    @property
    def name(self) -> str:
        return "native"

    @property
    def display_name(self) -> str:
        return "Built-in extractor (free)"

    def is_available(self) -> bool:
        # No credentials needed; httpx is a core dep and the extractor degrades
        # to a regex fallback if trafilatura is somehow absent.
        return True

    def supports_search(self) -> bool:
        return False

    def supports_extract(self) -> bool:
        return True

    def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
        """Fetch and extract clean main-text for each URL, concurrently.

        Returns the list shape the ``web_extract_tool`` post-processing pipeline
        expects: ``{url, title, content, raw_content, metadata}`` per URL, with
        a per-URL ``error`` string when a fetch/extract fails (never raises).
        """
        if not urls:
            return []

        from tools.web_quality import fetch_page_content

        def _one(url: str) -> Dict[str, Any]:
            try:
                # max_chars=0 → full extracted text; web_extract_tool applies
                # its own length cap / LLM summarization downstream.
                payload = fetch_page_content(url, timeout=_EXTRACT_TIMEOUT, max_chars=0)
            except Exception as exc:  # noqa: BLE001 — never let one URL kill the batch
                logger.debug("native extract failed for %s: %s", url, exc)
                payload = None

            if not payload or not payload.get("content"):
                return {
                    "url": url,
                    "title": "",
                    "content": "",
                    "raw_content": "",
                    "error": "Could not fetch or extract readable content from this URL",
                }

            content = payload["content"]
            return {
                "url": url,
                "title": payload.get("title", ""),
                "content": content,
                "raw_content": content,
                "metadata": {
                    "sourceURL": url,
                    "title": payload.get("title", ""),
                    **(
                        {"description": payload["meta_description"]}
                        if payload.get("meta_description")
                        else {}
                    ),
                },
            }

        workers = min(len(urls), _MAX_WORKERS)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(_one, urls))

        logger.info(
            "Native extract: %d/%d URL(s) yielded content",
            sum(1 for r in results if r.get("content")),
            len(urls),
        )
        return results

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "Built-in extractor (free)",
            "badge": "free · no key",
            "tag": "Reads page content directly (httpx + trafilatura) — no API key. "
            "Pairs with any search backend for the search → extract flow.",
            "env_vars": [],
        }
