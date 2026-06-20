"""Tests for the Postgres-backed memory repository.

Uses an in-memory psycopg-style fake connection that actually stores rows and
interprets the repository's SQL, so per-user isolation, dedupe, soft-delete,
and audit are exercised end-to-end without a real database.
"""

from __future__ import annotations

from typing import Any

from enterprise.memory_repository import MemoryRepository


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
    """Minimal row store that understands MemoryRepository's statements."""

    def __init__(self):
        self.entries: list[dict[str, Any]] = []
        self.audits: list[tuple[Any, ...]] = []

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
                    return _Cursor([])  # live duplicate → ON CONFLICT DO NOTHING
            self.entries.append(
                {
                    "id": entry_id,
                    "companyId": company_id,
                    "companyUserId": company_user_id,
                    "scope": scope,
                    "kind": kind,
                    "content": content,
                    "source": source,
                    "createdBy": created_by,
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
                if e["deletedAt"] is not None:
                    continue
                if e["companyId"] != company_id or e["scope"] != scope or e["kind"] != kind:
                    continue
                if e["content"] != content:
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
                kind = args[1] if len(args) > 1 else None
                rows = [
                    e
                    for e in self.entries
                    if e["deletedAt"] is None
                    and e["companyId"] == company_id
                    and e["companyUserId"] is None
                    and e["scope"] == "company"
                    and (kind is None or e["kind"] == kind)
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
            self.audits.append(args)
            return _Cursor([])

        raise AssertionError(f"Unhandled SQL: {s[:120]}")


def _repo():
    conn = _FakeMemoryConn()
    return MemoryRepository(conn), conn


def _add_personal(repo, company_id, user_id, content, kind="fact"):
    return repo.add_entry(
        company_id=company_id,
        company_user_id=user_id,
        scope="personal",
        kind=kind,
        content=content,
    )


def test_personal_entries_are_isolated_per_user():
    repo, _ = _repo()
    _add_personal(repo, "co", "alice", "Alice private fact")
    _add_personal(repo, "co", "bob", "Bob private fact")

    alice = repo.list_personal("co", "alice", "fact")
    bob = repo.list_personal("co", "bob", "fact")

    assert alice == ["Alice private fact"]
    assert bob == ["Bob private fact"]
    assert "Alice private fact" not in bob
    assert "Bob private fact" not in alice


def test_company_bucket_shared_and_excluded_from_personal():
    repo, _ = _repo()
    repo.add_entry(
        company_id="co",
        company_user_id=None,
        scope="company",
        kind="fact",
        content="Company runs on AWS",
        source="admin",
        created_by="admin1",
    )
    _add_personal(repo, "co", "alice", "Alice private fact")

    assert repo.list_company("co") == ["Company runs on AWS"]
    # The company entry must NOT leak into a user's personal slice.
    assert repo.list_personal("co", "alice", "fact") == ["Alice private fact"]


def test_add_dedupes_live_duplicate():
    repo, _ = _repo()
    first = _add_personal(repo, "co", "alice", "same text")
    second = _add_personal(repo, "co", "alice", "same text")

    assert first is not None
    assert second is None  # ON CONFLICT DO NOTHING → no second row
    assert repo.list_personal("co", "alice", "fact") == ["same text"]


def test_remove_soft_deletes_and_allows_readd():
    repo, _ = _repo()
    _add_personal(repo, "co", "alice", "fact one")
    removed = repo.remove_entry(
        company_id="co", company_user_id="alice", scope="personal", kind="fact", content="fact one"
    )

    assert removed is not None
    assert repo.list_personal("co", "alice", "fact") == []
    # A soft-deleted row no longer blocks dedupe — re-adding is allowed.
    assert _add_personal(repo, "co", "alice", "fact one") is not None
    assert repo.list_personal("co", "alice", "fact") == ["fact one"]


def test_replace_swaps_content():
    repo, _ = _repo()
    _add_personal(repo, "co", "alice", "old fact")
    repo.replace_entry(
        company_id="co",
        company_user_id="alice",
        scope="personal",
        kind="fact",
        before="old fact",
        after="new fact",
    )

    assert repo.list_personal("co", "alice", "fact") == ["new fact"]


def test_mutations_write_audit_rows():
    repo, conn = _repo()
    _add_personal(repo, "co", "alice", "audited fact")
    repo.remove_entry(
        company_id="co", company_user_id="alice", scope="personal", kind="fact", content="audited fact"
    )

    actions = [a[3] for a in conn.audits]  # 4th INSERT arg = action
    assert "add" in actions
    assert "remove" in actions
