"""Document classification + chunking — faithful port of ``ingestion/chunking/*.ts``.

Pure logic (no I/O, no deps). Produces ``IndexedChunk`` records whose ``id`` and
payload shape match the legacy ``buildIndexedFileChunks`` exactly, so chunks
written by Hermes are interchangeable with the legacy index:

  * ``classify_file_document`` → document class
  * ``choose_chunking_plan``   → strategy + token targets
  * ``build_indexed_chunks``   → list of chunk records ready for embed+upsert

The four strategies (canonical_simple, transcript_segment, semantic_heading,
hybrid_structured), section detection, overlap handling, and contextual-prefix
enrichment all mirror the TypeScript line-for-line.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from rag.types import ACTIVE_EMBEDDING_SCHEMA_VERSION

# ── classify ─────────────────────────────────────────────────────────────────

FILE_DOCUMENT_CLASSES = (
    "policy", "contract", "handbook", "sop", "finance_doc",
    "generic_text", "media_summary", "transcript",
)


def _has_keyword(haystack: str, entries: list[str]) -> bool:
    return any(entry in haystack for entry in entries)


def classify_file_document(*, file_name: str, mime_type: str, text: str) -> str:
    if mime_type.startswith("image/") or mime_type.startswith("video/"):
        return "media_summary"
    normalized = f"{file_name}\n{text[:6000]}".lower()
    if _has_keyword(normalized, ["transcript", "speaker", "meeting minutes", "[00:", "timestamp"]):
        return "transcript"
    if _has_keyword(normalized, ["contract", "agreement", "msa", "nda", "terms and conditions", "service level"]):
        return "contract"
    if _has_keyword(normalized, ["handbook", "employee manual", "employee guide"]):
        return "handbook"
    if _has_keyword(normalized, ["policy", "policies", "compliance", "leave policy", "refund policy"]):
        return "policy"
    if _has_keyword(normalized, ["sop", "runbook", "playbook", "procedure", "workflow", "onboarding guide"]):
        return "sop"
    if _has_keyword(
        normalized,
        ["invoice", "statement", "reconciliation", "balance", "ledger", "p&l", "profit and loss", "bank"],
    ):
        return "finance_doc"
    return "generic_text"


# ── plans ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ChunkingPlan:
    document_class: str
    strategy: str
    hierarchical: bool
    contextual_enrichment: bool
    child_target_tokens: int
    child_overlap_tokens: int
    parent_target_tokens: Optional[int] = None


def choose_chunking_plan(
    *,
    file_name: str,
    mime_type: str,
    text: str,
    advanced_chunking_enabled: bool = True,
    contextual_enrichment_enabled: bool = True,
) -> ChunkingPlan:
    document_class = classify_file_document(file_name=file_name, mime_type=mime_type, text=text)
    advanced = advanced_chunking_enabled
    contextual = contextual_enrichment_enabled

    if not advanced or document_class == "media_summary":
        return ChunkingPlan(document_class, "canonical_simple", False, False, 900, 180)
    if document_class == "transcript":
        return ChunkingPlan(document_class, "transcript_segment", False, False, 320, 48)
    if document_class in ("policy", "contract", "handbook", "sop"):
        return ChunkingPlan(document_class, "hybrid_structured", True, contextual, 480, 64, 1400)
    if document_class == "finance_doc":
        return ChunkingPlan(document_class, "semantic_heading", True, contextual, 560, 72, 1200)
    return ChunkingPlan(document_class, "semantic_heading", False, False, 720, 96)


# ── text helpers ─────────────────────────────────────────────────────────────


def _normalize_ws(value: str) -> str:
    value = value.replace("\r\n", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def _to_words(value: str) -> list[str]:
    return [w for w in (p.strip() for p in re.split(r"\s+", value)) if w]


def _join_words(words: list[str]) -> str:
    return " ".join(words).strip()


def _stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _estimate_tokens(value: str) -> int:
    import math

    return max(1, math.ceil(len(_to_words(value)) * 1.3))


def _split_paragraphs(value: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n{2,}", _normalize_ws(value)) if p.strip()]


def _split_sentences(value: str) -> list[str]:
    normalized = _normalize_ws(value)
    if not normalized:
        return []
    return [p.strip() for p in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", normalized) if p.strip()]


def _split_long_text(value: str, target_tokens: int) -> list[str]:
    words = _to_words(value)
    if len(words) <= target_tokens:
        return [_normalize_ws(value)]
    sentences = _split_sentences(value)
    if len(sentences) > 1:
        chunks: list[str] = []
        current: list[str] = []
        current_words = 0
        for sentence in sentences:
            wc = len(_to_words(sentence))
            if current_words > 0 and current_words + wc > target_tokens:
                chunks.append(_normalize_ws(" ".join(current)))
                current = [sentence]
                current_words = wc
            else:
                current.append(sentence)
                current_words += wc
        if current:
            chunks.append(_normalize_ws(" ".join(current)))
        return [c for c in chunks if c]
    return [_join_words(words[i : i + target_tokens]) for i in range(0, len(words), target_tokens)]


def _chunk_paragraphs(paragraphs: list[str], target_tokens: int, overlap_tokens: int) -> list[str]:
    if not paragraphs:
        return []
    expanded: list[str] = []
    for p in paragraphs:
        expanded.extend(_split_long_text(p, target_tokens))

    chunks: list[str] = []
    current: list[str] = []
    current_words = 0

    def flush() -> None:
        nonlocal current, current_words
        if not current:
            return
        chunks.append(_normalize_ws("\n\n".join(current)))
        trailing = _to_words(" ".join(current))
        if overlap_tokens > 0:
            current = [_join_words(trailing[max(0, len(trailing) - overlap_tokens):])]
        else:
            current = []
        current_words = len(_to_words(current[0])) if current else 0

    for para in expanded:
        wc = len(_to_words(para))
        if current_words > 0 and current_words + wc > target_tokens:
            flush()
        current.append(para)
        current_words += wc
    flush()
    return [c for c in chunks if c]


# ── section detection ────────────────────────────────────────────────────────


@dataclass
class _Section:
    id: str
    path: list[str]
    title: Optional[str]
    blocks: list[str] = field(default_factory=list)


def _infer_heading(block: str) -> Optional[tuple[int, str]]:
    trimmed = block.strip()
    if not trimmed:
        return None
    md = re.match(r"^(#{1,6})\s+(.+)$", trimmed)
    if md:
        return (len(md.group(1)), md.group(2).strip())
    section = re.match(r"^section\s+(\d+(?:\.\d+)*)[:.\-]?\s+(.+)$", trimmed, re.IGNORECASE)
    if section:
        level = min(6, len(section.group(1).split(".")) + 1)
        return (level, f"{section.group(1)} {section.group(2).strip()}")
    numbered = re.match(r"^(\d+(?:\.\d+){0,4}|[A-Z])[\).:\-]\s+(.+)$", trimmed)
    if numbered and len(_to_words(trimmed)) <= 18:
        level = min(6, len(numbered.group(1).split(".")) + 1)
        return (level, trimmed)
    all_caps = (
        len(trimmed) <= 80
        and bool(re.match(r"^[A-Z0-9 /&()\-]+$", trimmed))
        and not re.search(r"[.!?]$", trimmed)
    )
    if all_caps:
        return (2, trimmed)
    return None


def _build_sections(text: str) -> list[_Section]:
    blocks = [b.strip() for b in re.split(r"\n{2,}", text.replace("\r\n", "\n")) if b.strip()]
    sections: list[_Section] = []
    path: list[str] = []
    current: Optional[_Section] = None

    def ensure_section() -> None:
        nonlocal current
        if current is None:
            fallback = list(path) if path else ["Overview"]
            current = _Section(
                id=_stable_hash(f"section|{'>'.join(fallback)}"),
                path=fallback,
                title=fallback[-1] if fallback else "Overview",
                blocks=[],
            )
            sections.append(current)

    for block in blocks:
        heading = _infer_heading(block)
        if heading:
            level, title = heading
            del path[max(0, level - 1):]
            while len(path) < level:
                path.append("")
            path[level - 1] = title
            current = _Section(
                id=_stable_hash(f"section|{'>'.join(path)}"),
                path=list(path),
                title=title,
                blocks=[],
            )
            sections.append(current)
            continue
        ensure_section()
        assert current is not None
        current.blocks.append(block)

    return [s for s in sections if s.blocks]


# ── chunk records ────────────────────────────────────────────────────────────


@dataclass
class _ChunkRecord:
    chunk_text: str
    indexed_text: str
    chunk_index: int
    section_path: Optional[list[str]]
    parent_section_id: Optional[str]
    parent_section_text: Optional[str]
    context_prefix: Optional[str]


def _build_context_prefix(
    *, title: str, mime_type: str, plan: ChunkingPlan, section_path: Optional[list[str]]
) -> Optional[str]:
    if not plan.contextual_enrichment:
        return None
    parts = [f'Document "{title}"', f"type {plan.document_class.replace('_', ' ')}"]
    if section_path:
        parts.append(f"section {' > '.join(section_path)}")
    if mime_type == "text/csv":
        parts.append("tabular document")
    return f"{', '.join(parts)}."


def _build_chunk_records(*, text: str, title: str, mime_type: str, plan: ChunkingPlan) -> list[_ChunkRecord]:
    normalized = _normalize_ws(text)
    if not normalized:
        return []

    def simple(chunks: list[str]) -> list[_ChunkRecord]:
        return [
            _ChunkRecord(c, c, i, None, None, None, None) for i, c in enumerate(chunks)
        ]

    if plan.strategy == "canonical_simple":
        return simple(_chunk_paragraphs(_split_paragraphs(normalized), plan.child_target_tokens, plan.child_overlap_tokens))

    if plan.strategy == "transcript_segment":
        segments = [
            _normalize_ws(p)
            for p in re.split(r"\n(?=\[[0-9]{2}:[0-9]{2}|\w+:)", normalized)
            if _normalize_ws(p)
        ]
        return simple(_chunk_paragraphs(segments, plan.child_target_tokens, plan.child_overlap_tokens))

    # semantic_heading + hybrid_structured
    sections = _build_sections(normalized)
    if not sections:
        return simple(_chunk_paragraphs(_split_paragraphs(normalized), plan.child_target_tokens, plan.child_overlap_tokens))

    records: list[_ChunkRecord] = []
    next_index = 0
    for section in sections:
        parent_pieces = [p for p in ([section.title] + section.blocks) if p and p.strip()]
        parent_text = _normalize_ws("\n\n".join(parent_pieces))
        child_paragraphs = _chunk_paragraphs(section.blocks, plan.child_target_tokens, plan.child_overlap_tokens)
        for chunk_text in child_paragraphs:
            context_prefix = _build_context_prefix(
                title=title, mime_type=mime_type, plan=plan, section_path=section.path
            )
            indexed_text = _normalize_ws(
                "\n\n".join(
                    p
                    for p in [
                        context_prefix or "",
                        f"Section path: {' > '.join(section.path)}." if section.path else "",
                        chunk_text,
                    ]
                    if p
                )
            )
            records.append(
                _ChunkRecord(
                    chunk_text=chunk_text,
                    indexed_text=indexed_text,
                    chunk_index=next_index,
                    section_path=section.path,
                    parent_section_id=section.id if plan.hierarchical else None,
                    parent_section_text=parent_text if plan.hierarchical else None,
                    context_prefix=context_prefix,
                )
            )
            next_index += 1
    return records


# ── public chunk record ──────────────────────────────────────────────────────


@dataclass
class IndexedChunk:
    id: str
    source_id: str
    chunk_index: int
    document_key: str
    title: str
    indexed_text: str  # text to embed (may have context prefix)
    raw_chunk_text: str  # original text for citation
    token_count: int
    section_path: list[str]
    source_updated_at: str
    visibility: str
    owner_user_id: Optional[str]
    file_asset_id: str
    payload: dict


def build_indexed_chunks(
    *,
    company_id: str,
    file_asset_id: str,
    file_name: str,
    mime_type: str,
    source_url: str,
    uploader_user_id: Optional[str],
    text: str,
    plan: ChunkingPlan,
    visibility: str = "shared",
    allowed_roles: Optional[list[str]] = None,
    metadata: Optional[dict] = None,
    source_updated_at: Optional[str] = None,
) -> list[IndexedChunk]:
    title = file_name
    document_key = f"{company_id}:file_document:{file_asset_id}"
    updated_at = source_updated_at or datetime.now(timezone.utc).isoformat()

    records = _build_chunk_records(text=text, title=title, mime_type=mime_type, plan=plan)
    if not records:
        return []

    modality = "image" if mime_type.startswith("image/") else "video" if mime_type.startswith("video/") else "text"
    out: list[IndexedChunk] = []
    for record in records:
        chunk_id = _stable_hash(
            f"{company_id}|file_document|{file_asset_id}|{record.chunk_index}|{record.indexed_text}"
        )
        payload = {
            "citationType": "file",
            "citationTitle": title,
            "fileName": file_name,
            "mimeType": mime_type,
            "cloudinaryUrl": source_url,
            "sourceUrl": source_url,
            "fileAssetId": file_asset_id,
            "documentKey": document_key,
            "allowedRoles": allowed_roles or [],
            "title": title,
            "text": record.indexed_text,
            "chunkText": record.indexed_text,
            "rawChunkText": record.chunk_text,
            "indexedChunkText": record.indexed_text,
            "parentSectionId": record.parent_section_id,
            "parentSectionText": record.parent_section_text,
            "sectionPath": record.section_path or [],
            "contextPrefix": record.context_prefix,
            "documentClass": plan.document_class,
            "chunkingStrategy": plan.strategy,
            "hierarchical": plan.hierarchical,
            "contextualEnrichmentApplied": bool(record.context_prefix),
            "modality": modality,
            "embeddingSchemaVersion": ACTIVE_EMBEDDING_SCHEMA_VERSION,
            "retrievalProfile": "file",
            "sourceUpdatedAt": updated_at,
            **(metadata or {}),
        }
        out.append(
            IndexedChunk(
                id=chunk_id,
                source_id=file_asset_id,
                chunk_index=record.chunk_index,
                document_key=document_key,
                title=title,
                indexed_text=record.indexed_text,
                raw_chunk_text=record.chunk_text,
                token_count=_estimate_tokens(record.indexed_text),
                section_path=record.section_path or [],
                source_updated_at=updated_at,
                visibility=visibility,
                owner_user_id=uploader_user_id,
                file_asset_id=file_asset_id,
                payload=payload,
            )
        )
    return out
