"""ContextSearchBroker — port of ``application/context-search/context-search.broker.ts``.

Unified, citation-first meta-search across multiple sources run concurrently with
a per-source timeout, then deduped and ranked with the legacy weighted formula:

    effective = score * sourceWeight + authorityBoost - resultIndex * 0.0001

Sources wired for Hermes:
  * ``files``        — the RAG document broker (the source that previously made
                       this tool unportable). Authority: documentary.
  * ``zoho_crm``     — the native ``zoho_crm`` connector tool. Authority: authoritative.
  * ``lark_contacts``— the native ``lark_contacts`` connector. Authority: contextual.
  * ``web``          — the ``web_search`` tool (Serper-backed). Authority: public.

Connector tools are dispatched in a worker thread (``asyncio.to_thread``) because
``registry.dispatch`` bridges async tools via its own event loop; calling it
inline from this already-async broker would nest loops. The dispatcher is
injectable so tests stay hermetic.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

DEFAULT_LIMIT = 5
MAX_LIMIT = 10
EXCERPT_MAX_CHARS = 800
DEFAULT_TIMEOUT_S = 8.0

# Source priority weights (subset of legacy DEFAULT_WEIGHTS).
DEFAULT_WEIGHTS: dict[str, float] = {
    "zoho_crm": 1.5,
    "files": 1.15,
    "lark_contacts": 0.75,
    "web": 0.75,
}
AUTHORITATIVE_SCOPES = {"zoho_books", "zoho_crm", "files", "workspace"}

# Source defaults mirror legacy: files + zoho_crm + lark_contacts on, web off.
DEFAULT_SOURCES = {
    "files": True,
    "zoho_crm": True,
    "lark_contacts": True,
    "web": False,
}


def _authority_level(scope: str) -> str:
    if scope in ("zoho_books", "zoho_crm"):
        return "authoritative"
    if scope in ("files", "workspace"):
        return "documentary"
    if scope in ("personal_history", "lark_contacts"):
        return "contextual"
    if scope == "web":
        return "public"
    return "contextual"


@dataclass
class ContextHit:
    scope: str
    source_type: str
    source_label: str
    excerpt: str
    score: float
    chunk_ref: str
    authority_level: str
    url: Optional[str] = None
    file_name: Optional[str] = None
    title: Optional[str] = None

    def effective(self, index: int) -> float:
        weight = DEFAULT_WEIGHTS.get(self.scope, 1.0)
        auth_boost = 0.1 if self.scope in AUTHORITATIVE_SCOPES else 0.0
        return (self.score * weight) + auth_boost - (index * 0.0001)


def _excerpt(text: Any) -> str:
    return str(text or "")[:EXCERPT_MAX_CHARS]


def _coerce_items(parsed: Any) -> list[dict]:
    """Pull a result list out of a connector tool's JSON envelope, leniently."""
    if isinstance(parsed, list):
        return [x for x in parsed if isinstance(x, dict)]
    if isinstance(parsed, dict):
        for key in ("results", "data", "items", "records", "contacts"):
            val = parsed.get(key)
            if isinstance(val, list):
                return [x for x in val if isinstance(x, dict)]
    return []


class ContextSearchBroker:
    def __init__(
        self,
        *,
        document_broker,
        dispatch: Optional[Callable[[str, dict], str]] = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ):
        self._docs = document_broker
        self._dispatch = dispatch
        self._timeout = timeout_s

    # ── public ────────────────────────────────────────────────────────────────

    async def search(
        self,
        *,
        query: str,
        company_id: str,
        requester_user_id: Optional[str] = None,
        requester_ai_role: Optional[str] = None,
        sources: Optional[dict[str, bool]] = None,
        limit: int = DEFAULT_LIMIT,
    ) -> dict:
        limit = max(1, min(limit, MAX_LIMIT))
        enabled = {**DEFAULT_SOURCES, **(sources or {})}

        runners: list[tuple[str, Any]] = []
        if enabled.get("files"):
            runners.append(("files", self._run_files(query, company_id, requester_user_id, requester_ai_role)))
        if enabled.get("zoho_crm"):
            runners.append(("zoho_crm", self._run_connector("zoho_crm", {"op": "search_text", "query": query, "limit": limit}, "zoho_crm", "zoho_record")))
        if enabled.get("lark_contacts"):
            runners.append(("lark_contacts", self._run_connector("lark_contacts", {"op": "search", "query": query}, "lark_contacts", "lark_contact")))
        if enabled.get("web"):
            runners.append(("web", self._run_connector("web_search", {"query": query, "limit": limit}, "web", "web_result")))

        gathered = await asyncio.gather(
            *(self._guarded(name, coro) for name, coro in runners), return_exceptions=False
        )
        hits: list[ContextHit] = [h for batch in gathered for h in batch]

        ranked = self._rank(hits)[:limit]
        results = [
            {
                "scope": h.scope,
                "sourceType": h.source_type,
                "sourceLabel": h.source_label,
                "excerpt": h.excerpt,
                "score": round(h.score, 4),
                "chunkRef": h.chunk_ref,
                "authorityLevel": h.authority_level,
                **({"url": h.url} if h.url else {}),
                **({"fileName": h.file_name} if h.file_name else {}),
                **({"title": h.title} if h.title else {}),
            }
            for h in ranked
        ]
        citations = [
            {"index": i, "chunkRef": h.chunk_ref, "sourceLabel": h.source_label, "excerpt": h.excerpt, "score": round(h.score, 4)}
            for i, h in enumerate(ranked)
        ]
        return {
            "success": True,
            "resultCount": len(results),
            "searchSummary": f"{len(results)} result(s) across {len({h.scope for h in ranked})} source(s).",
            "results": results,
            "citations": citations,
        }

    # ── ranking ────────────────────────────────────────────────────────────────

    def _rank(self, hits: list[ContextHit]) -> list[ContextHit]:
        # Dedupe by (scope, chunk_ref), keeping the highest raw score.
        best: dict[tuple[str, str], ContextHit] = {}
        for h in hits:
            key = (h.scope, h.chunk_ref)
            prev = best.get(key)
            if prev is None or h.score > prev.score:
                best[key] = h
        deduped = list(best.values())
        # Stable index for the tie-breaker, then sort by effective score.
        indexed = list(enumerate(deduped))
        indexed.sort(key=lambda pair: pair[1].effective(pair[0]), reverse=True)
        return [h for _i, h in indexed]

    # ── source runners ──────────────────────────────────────────────────────────

    async def _guarded(self, name: str, coro) -> list[ContextHit]:
        try:
            return await asyncio.wait_for(coro, timeout=self._timeout)
        except asyncio.TimeoutError:
            logger.warning("context_search source %s timed out", name)
        except Exception as exc:  # noqa: BLE001 — one bad source must not sink the search
            logger.warning("context_search source %s failed: %s", name, exc)
        return []

    async def _run_files(
        self, query: str, company_id: str, user_id: Optional[str], ai_role: Optional[str]
    ) -> list[ContextHit]:
        out = await self._docs.search(
            query=query,
            company_id=company_id,
            requester_user_id=user_id,
            requester_ai_role=ai_role,
            limit=6,
        )
        hits: list[ContextHit] = []
        for r in out.get("results") or []:
            fid = r.get("fileAssetId") or r.get("fileName") or ""
            hits.append(
                ContextHit(
                    scope="files",
                    source_type="file_document",
                    source_label=str(r.get("fileName") or "document"),
                    excerpt=_excerpt(r.get("text")),
                    # reranker score is 0–10; normalize to 0–1 for the weighted formula.
                    score=float(r.get("score") or 0.0) / 10.0,
                    chunk_ref=f"file:{fid}",
                    authority_level=_authority_level("files"),
                    file_name=r.get("fileName"),
                    url=r.get("cloudinaryUrl"),
                )
            )
        return hits

    async def _run_connector(
        self, tool_name: str, args: dict, scope: str, source_type: str
    ) -> list[ContextHit]:
        dispatch = self._dispatch or _default_dispatch
        if dispatch is _default_dispatch and not _tool_available(tool_name):
            return []
        raw = await asyncio.to_thread(dispatch, tool_name, args)
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
        except (ValueError, TypeError):
            return []
        if isinstance(parsed, dict) and parsed.get("error"):
            return []
        items = _coerce_items(parsed)
        hits: list[ContextHit] = []
        for idx, item in enumerate(items):
            label = str(
                item.get("title")
                or item.get("name")
                or item.get("fileName")
                or item.get("subject")
                or item.get("id")
                or tool_name
            )
            excerpt = _excerpt(
                item.get("excerpt")
                or item.get("snippet")
                or item.get("description")
                or item.get("text")
                or item.get("summary")
                or json.dumps(item, ensure_ascii=False)
            )
            ref = str(item.get("id") or item.get("url") or item.get("recordId") or f"{scope}:{idx}")
            # Position-decayed base score; weighting/authority applied at rank time.
            base = max(0.1, 1.0 - idx * 0.08)
            hits.append(
                ContextHit(
                    scope=scope,
                    source_type=source_type,
                    source_label=label,
                    excerpt=excerpt,
                    score=base,
                    chunk_ref=f"{scope}:{ref}",
                    authority_level=_authority_level(scope),
                    url=item.get("url"),
                    title=item.get("title"),
                )
            )
        return hits


def _default_dispatch(tool_name: str, args: dict) -> str:
    from tools.registry import registry

    return registry.dispatch(tool_name, args)


def _tool_available(tool_name: str) -> bool:
    try:
        from tools.registry import registry

        return registry.get_entry(tool_name) is not None
    except Exception:
        return False
