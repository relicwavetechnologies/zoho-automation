"""Register the ``document_rag`` and ``context_search`` tools.

``document_rag`` exposes the file-RAG broker (semantic chunk search, full-document
read, file listing) over the shared Qdrant ``retrieval_v3`` collection. It is only
available in an enterprise session (company scope resolved) with RAG configured
(Qdrant URL + an embedding provider key).

``context_search`` is the unified multi-source meta-search; it builds on the same
RAG stack plus the already-registered web/Zoho/Lark connector tools.
"""

from __future__ import annotations

import logging

from rag.config import RagConfig
from rag.factory import build_context_search_broker, build_document_rag_broker
from tools.registry import registry, tool_error, tool_result

logger = logging.getLogger(__name__)


def _company_scope() -> dict:
    """Resolve {company_id, company_user_id, company_role} from the session."""
    try:
        from gateway.session_context import get_session_env
    except Exception:
        return {}
    company_id = str(get_session_env("HERMES_COMPANY_ID", "") or "").strip()
    if not company_id:
        return {}
    return {
        "company_id": company_id,
        "company_user_id": str(get_session_env("HERMES_COMPANY_USER_ID", "") or "").strip() or None,
        "company_role": str(get_session_env("HERMES_COMPANY_ROLE", "") or "").strip() or None,
    }


def check_rag_requirements() -> bool:
    """Tool is available only in an enterprise session with RAG configured."""
    try:
        if not _company_scope():
            return False
        return RagConfig.from_env().rag_enabled()
    except Exception:
        return False


# ── document_rag ─────────────────────────────────────────────────────────────

DOCUMENT_RAG_SCHEMA = {
    "name": "document_rag",
    "description": (
        "Search the company's indexed documents (contracts, policies, handbooks, "
        "uploaded files) by meaning and get back the most relevant excerpts with "
        "citations. Use op='search' for a question, op='read_full' to read one "
        "document's full text verbatim (exact wording/clauses), op='list_files' to "
        "see what documents are indexed."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {
                "type": "string",
                "enum": ["search", "read_full", "list_files"],
                "description": "The operation to perform.",
            },
            "query": {"type": "string", "description": "Search question (for op='search')."},
            "fileAssetId": {
                "type": "string",
                "description": "Restrict to / read this document (op='read_full', or scope a search).",
            },
            "limit": {"type": "integer", "description": "Max results for op='search' (1-6, default 6)."},
        },
        "required": ["op"],
    },
}


async def handle_document_rag(args: dict, **kwargs) -> str:
    op = (args.get("op") or "").strip()
    scope = _company_scope()
    company_id = kwargs.get("company_id") or scope.get("company_id")
    if not company_id:
        return tool_error("document_rag requires a company session", code="no_company_scope")
    requester_user_id = kwargs.get("company_user_id") or scope.get("company_user_id")
    requester_ai_role = kwargs.get("company_role") or scope.get("company_role")

    try:
        broker = build_document_rag_broker()
    except Exception as exc:  # noqa: BLE001
        return tool_error(f"RAG not configured: {exc}", code="rag_unavailable")

    if op == "search":
        query = (args.get("query") or "").strip()
        if not query:
            return tool_error("op='search' requires a query")
        result = await broker.search(
            query=query,
            company_id=company_id,
            requester_user_id=requester_user_id,
            requester_ai_role=requester_ai_role,
            file_asset_id=(args.get("fileAssetId") or None),
            limit=int(args.get("limit") or 6),
        )
        return tool_result(result)

    if op == "read_full":
        file_asset_id = (args.get("fileAssetId") or "").strip()
        if not file_asset_id:
            return tool_error("op='read_full' requires fileAssetId")
        result = await broker.read_full(
            company_id=company_id,
            file_asset_id=file_asset_id,
            requester_user_id=requester_user_id,
            requester_ai_role=requester_ai_role,
        )
        return tool_result(result)

    if op == "list_files":
        result = await broker.list_files(
            company_id=company_id,
            requester_user_id=requester_user_id,
            requester_ai_role=requester_ai_role,
        )
        return tool_result(result)

    return tool_error(f"Unknown op: {op}", code="bad_op")


registry.register(
    name="document_rag",
    toolset="rag",
    schema=DOCUMENT_RAG_SCHEMA,
    handler=handle_document_rag,
    check_fn=check_rag_requirements,
    is_async=True,
    emoji="📚",
    max_result_size_chars=100_000,
)


# ── context_search ───────────────────────────────────────────────────────────

CONTEXT_SEARCH_SCHEMA = {
    "name": "context_search",
    "description": (
        "Unified search across the company's knowledge in one call — indexed "
        "documents, Zoho CRM records, Lark contacts, and (optionally) the web — "
        "returning the most relevant, citation-backed snippets ranked by source "
        "authority. Use this when a question could be answered by more than one "
        "system and you don't know which; use 'document_rag' when you only need "
        "documents."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to look for."},
            "limit": {"type": "integer", "description": "Max results (1-10, default 5)."},
            "sources": {
                "type": "object",
                "description": "Per-source on/off overrides.",
                "properties": {
                    "files": {"type": "boolean"},
                    "zoho_crm": {"type": "boolean"},
                    "lark_contacts": {"type": "boolean"},
                    "web": {"type": "boolean"},
                },
            },
        },
        "required": ["query"],
    },
}


async def handle_context_search(args: dict, **kwargs) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return tool_error("context_search requires a query")
    scope = _company_scope()
    company_id = kwargs.get("company_id") or scope.get("company_id")
    if not company_id:
        return tool_error("context_search requires a company session", code="no_company_scope")
    try:
        broker = build_context_search_broker()
    except Exception as exc:  # noqa: BLE001
        return tool_error(f"RAG not configured: {exc}", code="rag_unavailable")
    result = await broker.search(
        query=query,
        company_id=company_id,
        requester_user_id=kwargs.get("company_user_id") or scope.get("company_user_id"),
        requester_ai_role=kwargs.get("company_role") or scope.get("company_role"),
        sources=(args.get("sources") if isinstance(args.get("sources"), dict) else None),
        limit=int(args.get("limit") or 5),
    )
    return tool_result(result)


registry.register(
    name="context_search",
    toolset="rag",
    schema=CONTEXT_SEARCH_SCHEMA,
    handler=handle_context_search,
    check_fn=check_rag_requirements,
    is_async=True,
    emoji="🔎",
    max_result_size_chars=100_000,
)
