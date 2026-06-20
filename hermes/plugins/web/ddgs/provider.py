"""DuckDuckGo search — plugin form (via the ``ddgs`` package).

Subclasses the plugin-facing :class:`agent.web_search_provider.WebSearchProvider`.
The legacy in-tree module ``tools.web_providers.ddgs`` was removed in the
same commit that moved this code under ``plugins/``; this file is now the
canonical implementation.

The ``ddgs`` package is an optional dependency. ``is_available()`` reflects
whether the package is importable; the plugin still registers either way so
``hermes tools`` can prompt the user to install it.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

from agent.web_search_provider import WebSearchProvider

logger = logging.getLogger(__name__)

# ``ddgs`` 9.x is a multi-engine metasearcher. Its default ``backend="auto"``
# probes engines in a slow order (~6-7s/query). We instead try a curated chain
# of fast, reliable, key-free engines and take the first that returns results.
# Benchmarked latency (single query): brave ~0.5s, duckduckgo ~1.4s,
# mojeek/startpage ~2s, vs auto/bing ~6s; google/yahoo frequently empty.
_DEFAULT_BACKENDS = ("brave", "duckduckgo", "mojeek", "startpage")


def _backend_chain() -> List[str]:
    """Resolved engine fallback order — override via ``HERMES_DDGS_BACKENDS``
    (comma-separated, e.g. ``"brave,duckduckgo"``)."""
    raw = os.getenv("HERMES_DDGS_BACKENDS", "").strip()
    if raw:
        chain = [b.strip() for b in raw.split(",") if b.strip()]
        if chain:
            return chain
    return list(_DEFAULT_BACKENDS)


class DDGSWebSearchProvider(WebSearchProvider):
    """Key-free metasearch via the ``ddgs`` package (brave/ddg/mojeek/startpage).

    No API key needed. Tries a fast engine fallback chain and returns the first
    that yields results; surfaces ddgs errors as ``{"success": False, ...}``
    rather than raising.
    """

    @property
    def name(self) -> str:
        return "ddgs"

    @property
    def display_name(self) -> str:
        return "DuckDuckGo (ddgs)"

    def is_available(self) -> bool:
        """Return True when the ``ddgs`` package is importable.

        Probes the import once; cheap because Python caches the import. Must
        NOT perform network I/O — runs at tool-registration time and on every
        ``hermes tools`` paint.
        """
        try:
            import ddgs  # noqa: F401

            return True
        except ImportError:
            return False

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        """Search via the fast engine fallback chain; return normalized results.

        Walks :func:`_backend_chain` in order, querying one engine at a time,
        and returns the first that yields results. An engine that errors or
        comes back empty is skipped — so a single slow/blocked engine never
        sinks the request (this is what makes the free path both fast and
        reliable). Returns an error only if *every* engine fails.
        """
        try:
            from ddgs import DDGS  # type: ignore
        except ImportError:
            return {
                "success": False,
                "error": "ddgs package is not installed — run `pip install ddgs`",
            }

        # DDGS().text yields at most `max_results` items; we cap defensively
        # in case the package ignores the hint.
        safe_limit = max(1, int(limit))
        region = os.getenv("HERMES_DDGS_REGION", "us-en").strip() or "us-en"
        last_error: str = ""
        reached_engine = False  # at least one engine responded without erroring

        for backend in _backend_chain():
            try:
                hits = []
                with DDGS() as client:
                    for hit in client.text(
                        query,
                        region=region,
                        safesearch="moderate",
                        max_results=safe_limit,
                        backend=backend,
                    ):
                        hits.append(hit)
                        if len(hits) >= safe_limit:
                            break
            except Exception as exc:  # noqa: BLE001 — try the next engine
                last_error = f"{backend}: {exc}"
                logger.debug("ddgs backend %s failed: %s", backend, exc)
                continue

            reached_engine = True
            if not hits:
                continue  # genuinely empty — try the next engine

            web_results = [
                {
                    "title": str(hit.get("title", "")),
                    "url": str(hit.get("href") or hit.get("url") or ""),
                    "description": str(hit.get("body", "")),
                    "position": i + 1,
                }
                for i, hit in enumerate(hits)
            ]
            logger.info("ddgs '%s': %d results via %s", query, len(web_results), backend)
            return {"success": True, "data": {"web": web_results}, "backend": backend}

        # Reached at least one engine but nobody had results → legitimate empty.
        if reached_engine:
            logger.info("ddgs '%s': no results from any engine", query)
            return {"success": True, "data": {"web": []}}

        # Every engine raised → a real failure.
        logger.warning("ddgs search '%s' failed on all engines: %s", query, last_error)
        return {"success": False, "error": f"DuckDuckGo search failed: {last_error}"}

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "DuckDuckGo (ddgs)",
            "badge": "free · no key · search only",
            "tag": "Search via the ddgs Python package — no API key (pair with any extract provider)",
            "env_vars": [],
            # Trigger `_run_post_setup("ddgs")` after the user picks this row
            # so the ddgs Python package gets pip-installed on first selection.
            "post_setup": "ddgs",
        }
