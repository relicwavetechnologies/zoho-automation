"""Query expansion/rewriting — faithful port of ``application/retrieval/query-rewriter.ts``.

Pure functions (no I/O): expand a user query into retrieval variants (the raw
query first, then a stopword-focused phrase, then intent-specific variants),
detect "give me the exact text" intent, and broaden a query for a corrective
retry. Insertion order + dedupe match the legacy ``Set`` semantics.
"""

from __future__ import annotations

import re

_STOPWORD_PATTERN = re.compile(
    r"\b(what|is|are|the|a|an|please|show|me|our|this|that|for|with|from|about|tell|give|latest|current|today|now)\b",
    re.IGNORECASE,
)
_EXACT_INTENT_PATTERN = re.compile(
    r"\b(exact|verbatim|quote|wording|clause|definition|exception|exceptions|section)\b",
    re.IGNORECASE,
)
_MULTI_INTENT_PATTERN = re.compile(
    r"\b(compare|across|between|impact|connected|relationship|related|versus|vs)\b",
    re.IGNORECASE,
)
_AND_PATTERN = re.compile(r"\band\b", re.IGNORECASE)
_POLICY_PATTERN = re.compile(r"\bpolicy|handbook\b", re.IGNORECASE)
_CONTRACT_PATTERN = re.compile(r"\bcontract|agreement\b", re.IGNORECASE)
_SPLIT_PATTERN = re.compile(
    r"\bcompare\b|\bversus\b|\bvs\b|\bacross\b|\bbetween\b|\band\b|,", re.IGNORECASE
)

EXACT_DOC_KEYWORDS = re.compile(
    r"\b(exact|verbatim|quote|full text|full document|entire document|whole document|"
    r"every word|precise wording|exact clause|give me the clause|cancellation clause|"
    r"exact wording|exact phrase|section \d|article \d)\b",
    re.IGNORECASE,
)


def _normalize(query: str) -> str:
    return " ".join((query or "").split())


def _focus_doc_phrase(query: str) -> str:
    """Strip stopwords + ``?"`` punctuation only (exact-intent words are kept)."""
    normalized = _normalize(query)
    stripped = _STOPWORD_PATTERN.sub(" ", normalized)
    stripped = re.sub(r'[?"]', " ", stripped)
    stripped = " ".join(stripped.split())
    return stripped if stripped else normalized


def looks_like_exact_document_query(query: str) -> bool:
    """True when the user wants the document's exact text (→ prefer read_full)."""
    return bool(EXACT_DOC_KEYWORDS.search(query or ""))


def _split_broad_query(query: str) -> list[str]:
    normalized = _normalize(query)
    if (
        not _MULTI_INTENT_PATTERN.search(normalized)
        and not _AND_PATTERN.search(normalized)
        and "," not in normalized
    ):
        return []
    return [
        phrase
        for phrase in (_focus_doc_phrase(part) for part in _SPLIT_PATTERN.split(normalized))
        if len(phrase) >= 8
    ]


def build_document_search_queries(query: str) -> list[str]:
    """Expand a query into up to 6 deduped retrieval variants (legacy parity).

    Ordering mirrors the legacy ``Set``: the raw normalized query is first, then
    the stopword-focused phrase, then intent-specific variants.
    """
    normalized = _normalize(query)
    if not normalized:
        return []

    queries: list[str] = []
    seen: set[str] = set()

    def add(value: str) -> None:
        key = value.lower()
        if value and key not in seen:
            seen.add(key)
            queries.append(value)

    add(normalized)
    focused = _focus_doc_phrase(normalized)
    wants_expansion = len(normalized.split()) <= 8 or bool(_EXACT_INTENT_PATTERN.search(normalized))
    if wants_expansion:
        add(focused)
        if _EXACT_INTENT_PATTERN.search(normalized):
            add(f"{focused} clause")
            add(f"{focused} section")
            add(f"{focused} policy")
        if _POLICY_PATTERN.search(normalized):
            add(f"{focused} rule")
            add(f"{focused} guidance")
        if _CONTRACT_PATTERN.search(normalized):
            add(f"{focused} agreement terms")

    if (
        _MULTI_INTENT_PATTERN.search(normalized)
        or _AND_PATTERN.search(normalized)
        or "," in normalized
    ):
        for part in _split_broad_query(normalized):
            add(part)

    return queries[:6]


def broaden_document_search_query(query: str) -> str:
    """Relax a query for a corrective retry — strip exactness markers (legacy parity)."""
    broadened = _normalize(query)
    broadened = re.sub(
        r"\b(exact|verbatim|quote|wording|latest|current|today|now|please)\b",
        " ",
        broadened,
        flags=re.IGNORECASE,
    )
    broadened = re.sub(
        r"\b(clause|definition|exception|exceptions)\b", " section ", broadened, flags=re.IGNORECASE
    )
    broadened = " ".join(broadened.split())
    return broadened if broadened else _normalize(query)
