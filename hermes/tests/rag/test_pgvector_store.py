"""PgVectorStore + RagChunkRepository tests — hermetic (fake DB connection).

A FakeConnection records executed SQL + args (mirroring the psycopg `.execute`
contract used by enterprise repositories) and returns canned rows, so the store's
SQL shaping, scope/role filters, and grouping are verified without Postgres.
"""

import json

import pytest

from enterprise.rag_repository import RagChunkRepository
from rag.pgvector_store import PgVectorStore
from rag.types import SOURCE_TYPE_FILE, UpsertRecord, VectorQuery


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows
        self.rowcount = len(rows)

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def close(self):
        pass


class FakeConnection:
    def __init__(self, rows=None):
        self._rows = rows or []
        self.calls = []

    def execute(self, sql, args=None):
        self.calls.append({"sql": " ".join(sql.split()), "args": args})
        low = sql.lower()
        if "select" in low and "hermesragchunk" in low and "count(" in low:
            return _FakeResult([{"n": len(self._rows)}])
        if low.strip().startswith("select"):
            return _FakeResult(self._rows)
        return _FakeResult([])


def _row(rid, doc_key, score, text="chunk text", name="Doc.pdf"):
    return {
        "id": rid,
        "companyId": "c1",
        "sourceType": "file_document",
        "sourceId": "f1",
        "chunkIndex": 0,
        "documentKey": doc_key,
        "visibility": "shared",
        "ownerUserId": None,
        "allowedRoles": [],
        "payload": {"fileName": name, "rawChunkText": text, "chunkText": text, "sectionPath": []},
        "score": score,
    }


@pytest.mark.asyncio
async def test_upsert_writes_vector_and_payload():
    conn = FakeConnection()
    store = PgVectorStore(RagChunkRepository(conn))
    await store.upsert_vectors(
        [
            UpsertRecord(
                company_id="c1",
                source_type=SOURCE_TYPE_FILE,
                source_id="f1",
                chunk_index=0,
                content_hash="h",
                dense_embedding=[0.1, 0.2, 0.3],
                content="hello body",
                file_asset_id="f1",
                title="Doc.pdf",
                payload={"rawChunkText": "hello body", "sectionPath": ["1", "Intro"]},
            )
        ]
    )
    call = conn.calls[-1]
    assert "INSERT INTO \"HermesRagChunk\"".lower() in call["sql"].lower()
    assert "ON CONFLICT".lower() in call["sql"].lower()
    # embedding bound as a pgvector literal string
    assert any(isinstance(a, str) and a.startswith("[0.1,0.2,0.3") for a in call["args"])
    # payload + allowedRoles + sectionPath serialized as JSON
    assert any(isinstance(a, str) and a.startswith("[") and "Intro" in a for a in call["args"])


@pytest.mark.asyncio
async def test_search_groups_by_document_and_maps_hits():
    rows = [
        _row("p1", "c1:file_document:f1", 0.92, "first"),
        _row("p2", "c1:file_document:f1", 0.81, "second"),  # same doc → same group
        _row("p3", "c1:file_document:f2", 0.70, "other", name="Other.pdf"),
    ]
    conn = FakeConnection(rows)
    store = PgVectorStore(RagChunkRepository(conn))
    groups = await store.search(
        VectorQuery(company_id="c1", dense_vector=[0.1, 0.2, 0.3], limit=6, group_size=3)
    )
    assert len(groups) == 2  # f1 and f2
    f1 = next(g for g in groups if g.group_value.endswith("f1"))
    assert [h.id for h in f1.hits] == ["p1", "p2"]
    assert f1.hits[0].score == pytest.approx(0.92)
    assert f1.hits[0].payload["fileName"] == "Doc.pdf"


@pytest.mark.asyncio
async def test_search_sql_has_scope_and_role_filters():
    conn = FakeConnection([])
    store = PgVectorStore(RagChunkRepository(conn))
    await store.search(
        VectorQuery(
            company_id="c1",
            dense_vector=[0.0, 0.0],
            requester_user_id="u1",
            requester_ai_role="manager",
            source_types=(SOURCE_TYPE_FILE,),
        )
    )
    sql = conn.calls[-1]["sql"].lower()
    args = conn.calls[-1]["args"]
    assert "visibility" in sql and "halfvec(3072)" in sql
    assert "owneruserid" in sql  # personal scope clause present
    assert "allowedroles" in sql  # role gate present
    assert json.dumps(["manager"]) in args  # role bound for jsonb containment


@pytest.mark.asyncio
async def test_count_and_delete():
    conn = FakeConnection([_row("p1", "k", 0.5)])
    store = PgVectorStore(RagChunkRepository(conn))
    assert await store.count_by_company("c1") == 1
    await store.delete_by_source(company_id="c1", source_type="file_document", source_id="f1")
    assert "delete from".lower() in conn.calls[-1]["sql"].lower()
