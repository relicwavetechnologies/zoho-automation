"""ContextSearchBroker tests — ranking, dedupe, multi-source merge (hermetic)."""

import json

import pytest

from rag.context_search import ContextSearchBroker


class _FakeDocBroker:
    def __init__(self, results):
        self._results = results

    async def search(self, *, query, company_id, requester_user_id=None, requester_ai_role=None, limit=6):
        return {"success": True, "operation": "search", "results": self._results}


def _doc(name, text, score):
    return {"text": text, "fileName": name, "fileAssetId": name, "score": score, "citation": f"[{name}]"}


@pytest.mark.asyncio
async def test_files_only_returns_cited_results():
    broker = ContextSearchBroker(
        document_broker=_FakeDocBroker([_doc("Policy.pdf", "refund 30 days", 9.0)]),
        dispatch=lambda name, args: json.dumps({"results": []}),
    )
    out = await broker.search(query="refund", company_id="c1", sources={"web": False, "zoho_crm": False, "lark_contacts": False})
    assert out["success"] and out["resultCount"] == 1
    r = out["results"][0]
    assert r["scope"] == "files" and r["authorityLevel"] == "documentary"
    assert r["fileName"] == "Policy.pdf"
    assert out["citations"][0]["chunkRef"] == "file:Policy.pdf"


@pytest.mark.asyncio
async def test_authoritative_zoho_outranks_web_at_equal_score():
    def dispatch(name, args):
        if name == "zoho_crm":
            return json.dumps({"data": [{"id": "z1", "name": "Acme Corp", "description": "key account"}]})
        if name == "web_search":
            return json.dumps({"results": [{"title": "Acme", "url": "http://x", "snippet": "blog"}]})
        return json.dumps({"results": []})

    broker = ContextSearchBroker(
        document_broker=_FakeDocBroker([]),
        dispatch=dispatch,
    )
    out = await broker.search(
        query="acme",
        company_id="c1",
        sources={"files": False, "zoho_crm": True, "lark_contacts": False, "web": True},
    )
    scopes = [r["scope"] for r in out["results"]]
    assert scopes[0] == "zoho_crm"  # weight 1.5 + auth boost beats web 0.75
    assert "web" in scopes


@pytest.mark.asyncio
async def test_failing_source_does_not_sink_search():
    def dispatch(name, args):
        raise RuntimeError("connector down")

    broker = ContextSearchBroker(
        document_broker=_FakeDocBroker([_doc("A.pdf", "x", 5.0)]),
        dispatch=dispatch,
    )
    out = await broker.search(query="q", company_id="c1", sources={"zoho_crm": True, "web": True})
    assert out["success"] and out["resultCount"] == 1  # files survived


@pytest.mark.asyncio
async def test_error_envelope_from_connector_is_skipped():
    broker = ContextSearchBroker(
        document_broker=_FakeDocBroker([]),
        dispatch=lambda name, args: json.dumps({"error": "denied"}),
    )
    out = await broker.search(query="q", company_id="c1", sources={"files": False, "zoho_crm": True})
    assert out["resultCount"] == 0


@pytest.mark.asyncio
async def test_limit_is_capped():
    broker = ContextSearchBroker(
        document_broker=_FakeDocBroker([_doc(f"f{i}.pdf", "t", 9.0 - i) for i in range(8)]),
        dispatch=lambda name, args: json.dumps({"results": []}),
    )
    out = await broker.search(query="q", company_id="c1", limit=3, sources={"zoho_crm": False, "lark_contacts": False})
    assert out["resultCount"] == 3
