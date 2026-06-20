"""Embedding providers + service — Python port of ``infrastructure/ai/embedding``.

Three providers, selected by config (mirrors the legacy provider-selection):

  * :class:`GeminiEmbeddingProvider` — REST ``batchEmbedContents`` against
    ``gemini-embedding-001`` (3072-dim), ``RETRIEVAL_DOCUMENT`` /
    ``RETRIEVAL_QUERY`` task types. This is what populates ``retrieval_v3``, so
    queries must use the same model to align with stored vectors.
  * :class:`OpenAIEmbeddingProvider` — REST ``/v1/embeddings``; pads/truncates
    to the model's nominal dimension.
  * :class:`FallbackEmbeddingProvider` — deterministic SHA-256 vectors; never
    makes a network call and never raises, so a provider outage degrades
    instead of breaking the pipeline.

:class:`EmbeddingService` batches inputs (16/req, as legacy) and substitutes a
per-item deterministic vector when a whole batch fails — identical resilience
semantics to the TypeScript service.

All HTTP goes through an injected async client (default: a fresh
``httpx.AsyncClient`` per call) so tests stay hermetic — the suite strips every
``_API_KEY`` env var, so nothing here may depend on ambient credentials.
"""

from __future__ import annotations

import base64
import hashlib
import logging
from typing import Optional, Protocol, Sequence

import httpx

from rag.config import RagConfig

logger = logging.getLogger(__name__)

GEMINI_DIMENSION = 3072
FALLBACK_DIMENSION = 1536
_EMBED_BATCH_SIZE = 16

# Nominal output dimensions per OpenAI model (legacy parity).
_OPENAI_DIMS = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
}


def _deterministic_vector(text: str, dimension: int) -> list[float]:
    """SHA-256-seeded vector in [0, 1]; empty text → zero vector (legacy parity)."""
    norm = " ".join((text or "").split()).lower()
    if not norm:
        return [0.0] * dimension
    out: list[float] = []
    # One digest yields 32 bytes; chain digests to fill the dimension.
    block = -1
    digest = b""
    for i in range(dimension):
        if i % 32 == 0:
            block += 1
            digest = hashlib.sha256(f"{block}:{norm}".encode("utf-8")).digest()
        out.append(digest[i % 32] / 255.0)
    return out


def _fit_dimension(vec: Sequence[float], dimension: int) -> list[float]:
    """Truncate or zero-pad ``vec`` to exactly ``dimension`` (legacy normalize)."""
    v = list(vec)
    if len(v) == dimension:
        return v
    if len(v) > dimension:
        return v[:dimension]
    return v + [0.0] * (dimension - len(v))


class EmbeddingProvider(Protocol):
    provider: str
    text_dimension: int

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]: ...
    async def embed_queries(self, texts: Sequence[str]) -> list[list[float]]: ...


# ── Gemini ──────────────────────────────────────────────────────────────────


class GeminiEmbeddingProvider:
    provider = "gemini"
    text_dimension = GEMINI_DIMENSION

    def __init__(
        self,
        *,
        api_key: str,
        text_model: str,
        timeout_ms: int = 30_000,
        http: Optional[httpx.AsyncClient] = None,
    ):
        if not api_key:
            raise ValueError("GEMINI_API_KEY is required for GeminiEmbeddingProvider")
        self._api_key = api_key
        self._text_model = text_model
        self._timeout = timeout_ms / 1000.0
        self._http = http

    def _url(self, model: str) -> str:
        from urllib.parse import quote

        return (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{quote(model)}:batchEmbedContents?key={quote(self._api_key)}"
        )

    async def _batch_embed(self, model: str, task_type: str, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        body = {
            "requests": [
                {
                    "model": f"models/{model}",
                    "content": {"parts": [{"text": text}]},
                    "taskType": task_type,
                    "outputDimensionality": self.text_dimension,
                }
                for text in texts
            ]
        }
        client = self._http or httpx.AsyncClient(timeout=self._timeout)
        owns = self._http is None
        try:
            res = await client.post(self._url(model), json=body)
        finally:
            if owns:
                await client.aclose()
        if res.status_code >= 400:
            raise RuntimeError(
                f"Gemini batchEmbedContents failed for {model}: HTTP {res.status_code} — {res.text[:300]}"
            )
        payload = res.json()
        return [
            _fit_dimension(e.get("values") or [], self.text_dimension)
            for e in (payload.get("embeddings") or [])
        ]

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._batch_embed(self._text_model, "RETRIEVAL_DOCUMENT", texts)

    async def embed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._batch_embed(self._text_model, "RETRIEVAL_QUERY", texts)


# ── OpenAI ──────────────────────────────────────────────────────────────────


class OpenAIEmbeddingProvider:
    provider = "openai"

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        timeout_ms: int = 30_000,
        http: Optional[httpx.AsyncClient] = None,
    ):
        if not api_key:
            raise ValueError("OPENAI_API_KEY is required for OpenAiEmbeddingProvider")
        self._api_key = api_key
        self._model = model
        self.text_dimension = _OPENAI_DIMS.get(model, 1536)
        self._timeout = timeout_ms / 1000.0
        self._http = http

    async def _embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        client = self._http or httpx.AsyncClient(timeout=self._timeout)
        owns = self._http is None
        try:
            res = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={"model": self._model, "input": list(texts)},
            )
        finally:
            if owns:
                await client.aclose()
        if res.status_code >= 400:
            raise RuntimeError(
                f"OpenAI embeddings failed for {self._model}: HTTP {res.status_code} — {res.text[:300]}"
            )
        payload = res.json()
        rows = sorted(payload.get("data") or [], key=lambda d: d.get("index", 0))
        return [_fit_dimension(row.get("embedding") or [], self.text_dimension) for row in rows]

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._embed(texts)

    async def embed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._embed(texts)


# ── Fallback ─────────────────────────────────────────────────────────────────


class FallbackEmbeddingProvider:
    provider = "fallback"

    def __init__(self, *, dimension: int = FALLBACK_DIMENSION):
        self.text_dimension = dimension

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return [_deterministic_vector(t, self.text_dimension) for t in texts]

    async def embed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        return [_deterministic_vector(t, self.text_dimension) for t in texts]


# ── Service wrapper ──────────────────────────────────────────────────────────


class EmbeddingService:
    """Batches embeds and substitutes deterministic vectors on per-batch failure."""

    def __init__(self, provider: EmbeddingProvider, *, batch_size: int = _EMBED_BATCH_SIZE):
        self._provider = provider
        self._batch_size = max(1, batch_size)

    @property
    def dimension(self) -> int:
        return self._provider.text_dimension

    @property
    def provider_name(self) -> str:
        return getattr(self._provider, "provider", "unknown")

    async def _run(self, texts: Sequence[str], *, query: bool) -> list[list[float]]:
        results: list[list[float]] = []
        items = list(texts)
        for start in range(0, len(items), self._batch_size):
            batch = items[start : start + self._batch_size]
            try:
                if query:
                    vecs = await self._provider.embed_queries(batch)
                else:
                    vecs = await self._provider.embed_documents(batch)
                if len(vecs) != len(batch):
                    raise RuntimeError(
                        f"provider returned {len(vecs)} vectors for {len(batch)} inputs"
                    )
                results.extend(vecs)
            except Exception as exc:  # never break the pipeline — degrade per item
                logger.warning(
                    "embedding batch failed (%s); substituting deterministic vectors: %s",
                    self.provider_name,
                    exc,
                )
                dim = self._provider.text_dimension
                results.extend(_deterministic_vector(t, dim) for t in batch)
        return results

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._run(texts, query=False)

    async def embed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._run(texts, query=True)

    async def embed_query(self, text: str) -> list[float]:
        out = await self._run([text], query=True)
        return out[0] if out else _deterministic_vector(text, self._provider.text_dimension)


def make_embedding_provider(
    config: RagConfig, *, http: Optional[httpx.AsyncClient] = None
) -> EmbeddingProvider:
    """Select a provider matching the legacy precedence (gemini → openai → fallback)."""
    if config.embedding_provider == "fallback":
        return FallbackEmbeddingProvider()
    if config.embedding_provider == "gemini" and config.gemini_api_key:
        return GeminiEmbeddingProvider(
            api_key=config.gemini_api_key,
            text_model=config.gemini_embedding_model,
            http=http,
        )
    if config.embedding_provider != "fallback" and config.openai_api_key:
        if config.embedding_provider == "openai" or not config.gemini_api_key:
            return OpenAIEmbeddingProvider(
                api_key=config.openai_api_key,
                model=config.openai_embedding_model,
                http=http,
            )
    if config.gemini_api_key:
        return GeminiEmbeddingProvider(
            api_key=config.gemini_api_key,
            text_model=config.gemini_embedding_model,
            http=http,
        )
    return FallbackEmbeddingProvider()


def make_embedding_service(
    config: RagConfig, *, http: Optional[httpx.AsyncClient] = None
) -> EmbeddingService:
    return EmbeddingService(make_embedding_provider(config, http=http))
