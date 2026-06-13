from __future__ import annotations

from enterprise.migration_runner import apply_enterprise_migrations


class _Cursor:
    def __init__(self, rows=None):
        self._rows = rows or []

    def fetchall(self):
        return self._rows

    def close(self):
        pass


class _MigrationConnection:
    def __init__(self, applied=None):
        self.applied = set(applied or [])
        self.executed: list[tuple[str, tuple | None]] = []

    def execute(self, sql, args=None):
        self.executed.append((sql, args))
        if 'SELECT "id" FROM "HermesSchemaMigration"' in sql:
            return _Cursor([{"id": item} for item in sorted(self.applied)])
        if 'INSERT INTO "HermesSchemaMigration"' in sql and args:
            self.applied.add(args[0])
        return _Cursor()


def test_apply_enterprise_migrations_runs_unapplied_sql_files(tmp_path):
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "001_first.sql").write_text('CREATE TABLE "One" ("id" TEXT);', encoding="utf-8")
    (migrations / "002_second.sql").write_text('CREATE TABLE "Two" ("id" TEXT);', encoding="utf-8")
    conn = _MigrationConnection(applied={"001_first.sql"})

    applied = apply_enterprise_migrations(conn, migrations_dir=migrations)

    assert applied == ["002_second.sql"]
    assert "002_second.sql" in conn.applied
    executed_sql = "\n".join(sql for sql, _args in conn.executed)
    assert 'CREATE TABLE "One"' not in executed_sql
    assert 'CREATE TABLE "Two"' in executed_sql


def test_apply_enterprise_migrations_records_empty_files(tmp_path):
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "001_empty.sql").write_text("\n", encoding="utf-8")
    conn = _MigrationConnection()

    applied = apply_enterprise_migrations(conn, migrations_dir=migrations)

    assert applied == ["001_empty.sql"]
    assert "001_empty.sql" in conn.applied
