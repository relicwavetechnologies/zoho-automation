"""Tests for the MemoryStore persistence seam (tools/memory_backends.py).

Covers (a) an injected fake backend — company block injection + mutation
routing — and (b) the PostgresMemoryBackend driven through MemoryStore against
an in-memory psycopg-style connection, including the per-user isolation
regression and the read-only company bucket.
"""

from __future__ import annotations

from typing import Any

import pytest

from tools.memory_backends import PostgresMemoryBackend
from tools.memory_tool import MemoryStore


# ── Row-storing fake connection (understands MemoryRepository's SQL) ─────────
class _Cursor:
    def __init__(self, rows: list[dict[str, Any]] | None = None):
        self._rows = rows or []

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def close(self):
        return None


class _FakeMemoryConn:
    def __init__(self):
        self.entries: list[dict[str, Any]] = []

    def execute(self, sql: str, args: tuple[Any, ...]):
        s = " ".join(sql.split())
        if s.startswith('INSERT INTO "HermesMemoryEntry"'):
            entry_id, company_id, company_user_id, scope, kind, content, source, created_by = args
            for e in self.entries:
                if (
                    e["deletedAt"] is None
                    and e["companyId"] == company_id
                    and (e["companyUserId"] or "") == (company_user_id or "")
                    and e["scope"] == scope
                    and e["kind"] == kind
                    and e["content"] == content
                ):
                    return _Cursor([])
            self.entries.append(
                {
                    "id": entry_id,
                    "companyId": company_id,
                    "companyUserId": company_user_id,
                    "scope": scope,
                    "kind": kind,
                    "content": content,
                    "deletedAt": None,
                    "seq": len(self.entries),
                }
            )
            return _Cursor([{"id": entry_id}])
        if s.startswith('UPDATE "HermesMemoryEntry"'):
            null_user = '"companyUserId" IS NULL' in s
            if null_user:
                company_id, scope, kind, content = args
                company_user_id = None
            else:
                company_id, company_user_id, scope, kind, content = args
            for e in self.entries:
                if e["deletedAt"] is not None or e["companyId"] != company_id:
                    continue
                if e["scope"] != scope or e["kind"] != kind or e["content"] != content:
                    continue
                if null_user and e["companyUserId"] is not None:
                    continue
                if not null_user and e["companyUserId"] != company_user_id:
                    continue
                e["deletedAt"] = "now"
                return _Cursor([{"id": e["id"]}])
            return _Cursor([])
        if s.startswith('SELECT "content" FROM "HermesMemoryEntry"'):
            if '"companyUserId" IS NULL' in s:
                company_id = args[0]
                rows = [
                    e
                    for e in self.entries
                    if e["deletedAt"] is None
                    and e["companyId"] == company_id
                    and e["companyUserId"] is None
                    and e["scope"] == "company"
                ]
            else:
                company_id, company_user_id, kind = args
                rows = [
                    e
                    for e in self.entries
                    if e["deletedAt"] is None
                    and e["companyId"] == company_id
                    and e["companyUserId"] == company_user_id
                    and e["scope"] == "personal"
                    and e["kind"] == kind
                ]
            rows.sort(key=lambda e: e["seq"])
            return _Cursor([{"content": e["content"]} for e in rows])
        if s.startswith('INSERT INTO "HermesMemoryAudit"'):
            return _Cursor([])
        raise AssertionError(f"Unhandled SQL: {s[:120]}")


# ── Injected fake backend ───────────────────────────────────────────────────
class _RecordingBackend:
    def __init__(self, company: list[str] | None = None):
        self.company = company or []
        self.calls: list[tuple[str, str]] = []
        self.persisted: dict[str, list[str]] = {"memory": [], "user": []}

    def load(self, target: str) -> list[str]:
        return list(self.persisted.get(target, []))

    def load_company(self) -> list[str]:
        return list(self.company)

    def mutate(self, target: str, action: str, apply):
        new_entries, response = apply(list(self.persisted.get(target, [])))
        self.calls.append((target, action))
        if new_entries is not None:
            self.persisted[target] = list(new_entries)
        return response


def test_company_block_injected_from_backend_load_company():
    store = MemoryStore(backend=_RecordingBackend(company=["Company runs on AWS"]))
    store.load_from_disk()

    block = store.format_for_system_prompt("company")
    assert block is not None
    assert "COMPANY KNOWLEDGE (shared, read-only)" in block
    assert "Company runs on AWS" in block


def test_no_company_block_when_empty():
    store = MemoryStore(backend=_RecordingBackend(company=[]))
    store.load_from_disk()
    assert store.format_for_system_prompt("company") is None


def test_mutations_route_through_backend():
    backend = _RecordingBackend()
    store = MemoryStore(backend=backend)
    store.load_from_disk()

    res = store.add("memory", "fact one")
    assert res["success"] is True
    assert ("memory", "add") in backend.calls
    assert backend.persisted["memory"] == ["fact one"]

    store.replace("memory", "fact one", "fact two")
    store.remove("memory", "fact two")
    assert ("memory", "replace") in backend.calls
    assert ("memory", "remove") in backend.calls
    assert backend.persisted["memory"] == []


# ── PostgresMemoryBackend driven through MemoryStore ────────────────────────
@pytest.fixture()
def pg(monkeypatch):
    conn = _FakeMemoryConn()
    scope = {"v": {"company_id": "co", "company_user_id": "alice"}}
    monkeypatch.setattr("enterprise.db.get_enterprise_connection", lambda *a, **k: conn, raising=False)
    monkeypatch.setattr("tools.memory_tool.get_company_memory_scope", lambda: scope["v"])
    return conn, scope


def _store():
    s = MemoryStore(backend=PostgresMemoryBackend())
    s.load_from_disk()
    return s


def test_postgres_backend_persists_personal_through_store(pg):
    store = _store()
    store.add("memory", "Alice fact")
    store.add("user", "prefers concise")

    reloaded = _store()
    assert "Alice fact" in reloaded.memory_entries
    assert "prefers concise" in reloaded.user_entries


def test_postgres_personal_isolated_per_user(pg):
    _conn, scope = pg

    scope["v"] = {"company_id": "co", "company_user_id": "alice"}
    alice = _store()
    alice.add("memory", "Alice private fact")

    scope["v"] = {"company_id": "co", "company_user_id": "bob"}
    bob = _store()
    assert "Alice private fact" not in bob.memory_entries
    bob.add("memory", "Bob private fact")

    scope["v"] = {"company_id": "co", "company_user_id": "alice"}
    alice_again = _store()
    assert "Alice private fact" in alice_again.memory_entries
    assert "Bob private fact" not in alice_again.memory_entries


def test_postgres_company_bucket_shared_and_readonly(pg):
    conn, scope = pg
    # Seed a company-shared row directly (admin path is deferred; agent can't write it).
    conn.entries.append(
        {
            "id": "c1",
            "companyId": "co",
            "companyUserId": None,
            "scope": "company",
            "kind": "fact",
            "content": "Refunds within 30 days",
            "deletedAt": None,
            "seq": 0,
        }
    )

    store = _store()
    assert "Refunds within 30 days" in store.company_entries
    # Company knowledge is injected read-only and is NOT in the personal slice.
    assert "Refunds within 30 days" not in store.memory_entries
    block = store.format_for_system_prompt("company")
    assert block and "Refunds within 30 days" in block
