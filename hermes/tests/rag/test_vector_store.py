"""QdrantStore tests — point IDs, filter building, grouped-search parsing, upsert."""

import re

import pytest

from rag.types import SOURCE_TYPE_FILE, UpsertRecord, VectorQuery
from rag.vector_store import (
    QdrantStore,
    _build_search_filter,
    build_point_id,
)
from tests.rag.fakes import FakeAsyncClient, FakeResponse

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def test_point_id_is_deterministic_uuid5_shaped():
    a = build_point_id("c1", SOURCE_TYPE_FILE, "f1", 0)
    b = build_point_id("c1", SOURCE_TYPE_FILE, "f1", 0)
    assert a == b
    assert _UUID_RE.match(a), a
    # Different chunk → different id.
    assert build_point_id("c1", SOURCE_TYPE_FILE, "f1", 1) != a


def test_search_filter_scope_and_role():
    q = VectorQuery(
        company_id="c1",
        dense_vector=[0.0],
        requester_user_id="u1",
        requester_ai_role="manager",
        source_types=(SOURCE_TYPE_FILE,),
    )
    filt = _build_search_filter(q)
    # schema version pinned
    assert any(
        m.get("key") == "embeddingSchemaVersion" and m["match"]["value"] == "hermes-rag-v1"
        for m in filt["must"]
    )
    # personal scope includes ownerUserId clause
    scope_json = str(filt["should"])
    assert "ownerUserId" in scope_json and "u1" in scope_json
    # role gate present for file scope
    role_json = str(filt["must"])
    assert "allowedRoles" in role_json and "manager" in role_json


def test_search_filter_omits_personal_without_user():
    q = VectorQuery(company_id="c1", dense_vector=[0.0])
    filt = _build_search_filter(q)
    assert "ownerUserId" not in str(filt["should"])


@pytest.mark.asyncio
async def test_search_parses_grouped_response():
    grouped = {
        "result": {
            "groups": [
                {
                    "id": "c1:file_document:f1",
                    "hits": [
                        {
                            "id": "pt1",
                            "score": 0.91,
                            "payload": {
                                "sourceType": "file_document",
                                "sourceId": "f1",
                                "chunkIndex": 2,
                                "visibility": "shared",
                                "documentKey": "c1:file_document:f1",
                                "chunkText": "refund within 30 days",
                                "fileName": "Policy.pdf",
                            },
                        }
                    ],
                }
            ]
        }
    }

    def handler(method, url, body):
        if method == "GET":
            return FakeResponse(200, {})  # collection exists
        if "query/groups" in url:
            return FakeResponse(200, grouped)
        return FakeResponse(200, {})

    http = FakeAsyncClient(handler=handler)
    store = QdrantStore(
        base_url="https://q", collection="retrieval_v3", primary_vector_size=3072, http=http
    )
    groups = await store.search(VectorQuery(company_id="c1", dense_vector=[0.1] * 3072, limit=6))
    assert len(groups) == 1
    hit = groups[0].hits[0]
    assert hit.id == "pt1" and hit.score == pytest.approx(0.91)
    assert hit.payload["fileName"] == "Policy.pdf"


@pytest.mark.asyncio
async def test_search_404_on_query_returns_empty():
    # Collection GET ok, but the grouped query 404s (e.g. transient) → empty, no raise.
    def handler(method, url, body):
        if "query/groups" in url:
            return FakeResponse(404, {}, text="Not found (404)")
        return FakeResponse(200, {})

    http = FakeAsyncClient(handler=handler)
    store = QdrantStore(base_url="https://q", collection="retrieval_v3", primary_vector_size=8, http=http)
    assert await store.search(VectorQuery(company_id="c1", dense_vector=[0.0] * 8)) == []


@pytest.mark.asyncio
async def test_upsert_builds_named_vector_point():
    captured = {}

    def handler(method, url, body):
        if method == "PUT" and "/points" in url:
            captured["body"] = body
        return FakeResponse(200, {})

    http = FakeAsyncClient(handler=handler)
    store = QdrantStore(base_url="https://q", collection="retrieval_v3", primary_vector_size=4, http=http)
    await store.upsert_vectors(
        [
            UpsertRecord(
                company_id="c1",
                source_type=SOURCE_TYPE_FILE,
                source_id="f1",
                chunk_index=0,
                content_hash="h",
                dense_embedding=[0.1, 0.2, 0.3, 0.4],
                content="hello",
                file_asset_id="f1",
                title="Doc.pdf",
            )
        ]
    )
    point = captured["body"]["points"][0]
    assert _UUID_RE.match(point["id"])
    assert "dense_text_v2" in point["vector"]
    assert point["payload"]["chunkText"] == "hello"
    assert point["payload"]["embeddingSchemaVersion"] == "hermes-rag-v1"
