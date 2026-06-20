"""Trigram filename matching — port of ``application/retrieval/trigram.ts``.

Fast, network-free filename similarity for the files-source "fast path": when a
filename matches strongly we can return its content directly without a semantic
search; weaker candidates are passed to an LLM filename resolver.
"""

from __future__ import annotations

import re

TRIGRAM_STRONG_THRESHOLD = 0.8
TRIGRAM_CANDIDATE_THRESHOLD = 0.2

# File-type words ignored during matching (so "html file" matches "demo.html").
_FILE_TYPE_WORDS = {
    "pdf", "doc", "docx", "word", "excel", "xls", "xlsx", "csv", "tsv",
    "html", "htm", "txt", "text", "ppt", "pptx", "file", "document", "image",
    "img", "png", "jpg", "jpeg", "gif", "webp",
}
_STOPWORDS = {"the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "my", "our"}


def _strip_extension(name: str) -> str:
    return re.sub(r"\.[a-z0-9]{1,5}$", "", name.strip(), flags=re.IGNORECASE)


def _normalize(text: str) -> str:
    return re.sub(r"[^\w\s]", " ", _strip_extension(text).lower())


def _meaningful_tokens(text: str) -> list[str]:
    return [
        t
        for t in _normalize(text).split()
        if t and t not in _FILE_TYPE_WORDS and t not in _STOPWORDS and len(t) > 1
    ]


def _trigrams(text: str) -> set[str]:
    s = f"  {re.sub(r'\\s+', ' ', _normalize(text)).strip()}  "
    return {s[i : i + 3] for i in range(len(s) - 2)} if len(s) >= 3 else set()


def trigram_similarity(query: str, filename: str) -> float:
    """Staged similarity in [0, 1] (token containment beats raw trigram Jaccard)."""
    query_tokens = _meaningful_tokens(query)
    file_norm = _normalize(filename)
    file_token_set = set(_normalize(filename).split())

    if query_tokens:
        found = [t for t in query_tokens if t in file_token_set or t in file_norm]
        if len(found) == len(query_tokens):
            return 0.95
        if len(found) / len(query_tokens) >= 0.6:
            return 0.75
        joined = " ".join(query_tokens)
        if joined and joined in file_norm:
            return 0.88

    full_query = _normalize(query).strip()
    if full_query and full_query in file_norm:
        return 0.85

    a, b = _trigrams(query), _trigrams(filename)
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def rank_by_trigram(query: str, filenames: list[str]) -> list[tuple[str, float]]:
    """Score + sort filenames desc, keeping only those above the candidate threshold."""
    scored = [(name, trigram_similarity(query, name)) for name in filenames]
    scored = [pair for pair in scored if pair[1] >= TRIGRAM_CANDIDATE_THRESHOLD]
    scored.sort(key=lambda p: p[1], reverse=True)
    return scored
