"""Groq listwise reranker — port of ``application/retrieval/llm-reranker.service.ts``.

Scores each candidate chunk 0–10 for relevance in a single listwise call to a
fast Groq model, filters by a threshold, and sorts. On any failure (no key,
bad JSON, wrong length, API error) it falls back to score-sort (``score * 10``,
no threshold) so reranking never drops the result set to empty.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Optional, Sequence

import httpx

from rag.types import SearchResult

logger = logging.getLogger(__name__)

_CHUNK_PREVIEW_LEN = 600
_SYSTEM_PROMPT = (
    "You are a retrieval quality judge. Given a user query and a list of document "
    "chunks, score each chunk 0-10 for relevance (10=perfectly relevant, 0=irrelevant). "
    "Reply ONLY with a JSON array of numbers, one per chunk, e.g.: [8,2,9,1,7]"
)


@dataclass
class RankedChunk:
    chunk: SearchResult
    reranker_score: float  # 0–10


def _chunk_text(chunk: SearchResult) -> str:
    p = chunk.payload or {}
    text = p.get("rawChunkText") or p.get("chunkText") or p.get("text") or ""
    return str(text)[:_CHUNK_PREVIEW_LEN]


def _score_sort_fallback(chunks: Sequence[SearchResult]) -> list[RankedChunk]:
    ranked = [RankedChunk(chunk=c, reranker_score=float(c.score) * 10.0) for c in chunks]
    ranked.sort(key=lambda r: r.reranker_score, reverse=True)
    return ranked


def _parse_scores(content: str, expected: int) -> Optional[list[float]]:
    match = re.search(r"\[[^\]]*\]", content)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except (ValueError, TypeError):
        return None
    if not isinstance(data, list) or len(data) != expected:
        return None
    try:
        scores = [float(x) for x in data]
    except (ValueError, TypeError):
        return None
    # Models frequently ignore the "0-10" instruction and return a 0-1 scale;
    # rescale so the integer threshold still discriminates instead of nuking all.
    if scores and max(scores) <= 1.0:
        scores = [s * 10.0 for s in scores]
    return scores


class GroqReranker:
    def __init__(
        self,
        *,
        api_key: Optional[str],
        model: str = "llama-3.1-8b-instant",
        threshold: int = 3,
        max_chunks: int = 24,
        timeout_ms: int = 15_000,
        http: Optional[httpx.AsyncClient] = None,
    ):
        self._api_key = api_key
        self._model = model
        self._threshold = threshold
        self._max_chunks = max_chunks
        self._timeout = timeout_ms / 1000.0
        self._http = http

    async def rerank(self, query: str, chunks: Sequence[SearchResult]) -> list[RankedChunk]:
        if not chunks:
            return []
        if not self._api_key:
            return _score_sort_fallback(chunks)

        # Cap the listwise window (profile rerank_top_n) so the score array fits
        # the response budget; anything beyond falls back to its cosine order.
        head = list(chunks[: self._max_chunks])
        tail = list(chunks[self._max_chunks :])

        listing = "\n".join(f"[{i}] {_chunk_text(c)}" for i, c in enumerate(head))
        user_prompt = f'Query: "{query}"\n\nChunks:\n{listing}\n\nJSON scores:'
        body = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0,
            # Scale the token budget to the chunk count (~6 tokens/number) so the
            # array never truncates mid-output — the prime cause of fallbacks.
            "max_tokens": max(128, len(head) * 6),
        }
        try:
            client = self._http or httpx.AsyncClient(timeout=self._timeout)
            owns = self._http is None
            try:
                res = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    json=body,
                )
            finally:
                if owns:
                    await client.aclose()
            if res.status_code >= 400:
                raise RuntimeError(f"Groq HTTP {res.status_code}: {res.text[:200]}")
            content = (
                (res.json().get("choices") or [{}])[0].get("message", {}).get("content") or ""
            )
            scores = _parse_scores(content, len(head))
            if scores is None:
                raise RuntimeError("Groq reranker returned unparseable scores")
        except Exception as exc:  # noqa: BLE001 — reranker must never block retrieval
            logger.warning("rerank fallback (score-sort): %s", exc)
            return _score_sort_fallback(chunks)

        ranked = [
            RankedChunk(chunk=c, reranker_score=s)
            for c, s in zip(head, scores)
            if s >= self._threshold
        ]
        ranked.sort(key=lambda r: r.reranker_score, reverse=True)
        # Append any beyond-window chunks below the reranked head (cosine order).
        ranked.extend(_score_sort_fallback(tail))
        return ranked
