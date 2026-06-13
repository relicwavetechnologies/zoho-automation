"""Idempotent SQL migration runner for Hermes enterprise Postgres."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .config import EnterprisePostgresConfig
from .db import get_enterprise_connection

MIGRATION_TABLE = "HermesSchemaMigration"
MIGRATIONS_DIR = Path(__file__).with_name("migrations")


def _close_cursor(result: Any) -> None:
    close = getattr(result, "close", None)
    if close is not None:
        close()


def _fetch_applied(connection: Any) -> set[str]:
    result = connection.execute(f'SELECT "id" FROM "{MIGRATION_TABLE}"')
    fetchall = getattr(result, "fetchall", None)
    try:
        rows = list(fetchall() or []) if fetchall is not None else []
    finally:
        _close_cursor(result)
    applied: set[str] = set()
    for row in rows:
        if isinstance(row, dict):
            value = row.get("id")
        else:
            value = row[0] if row else None
        if value:
            applied.add(str(value))
    return applied


def _ensure_migration_table(connection: Any) -> None:
    result = connection.execute(
        f'''
        CREATE TABLE IF NOT EXISTS "{MIGRATION_TABLE}" (
            "id" TEXT PRIMARY KEY,
            "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        '''
    )
    _close_cursor(result)


def _record_applied(connection: Any, migration_id: str) -> None:
    result = connection.execute(
        f'''
        INSERT INTO "{MIGRATION_TABLE}" ("id")
        VALUES (%s)
        ON CONFLICT ("id") DO NOTHING
        ''',
        (migration_id,),
    )
    _close_cursor(result)


def list_migration_files(migrations_dir: Path = MIGRATIONS_DIR) -> list[Path]:
    if not migrations_dir.exists():
        return []
    return sorted(path for path in migrations_dir.iterdir() if path.suffix == ".sql")


def apply_enterprise_migrations(
    connection: Any | None = None,
    *,
    migrations_dir: Path = MIGRATIONS_DIR,
) -> list[str]:
    """Apply unapplied enterprise SQL migrations and return applied IDs."""
    config = EnterprisePostgresConfig.from_env()
    if connection is None:
        if not config.enabled:
            raise RuntimeError("Enterprise Postgres is not enabled")
        connection = get_enterprise_connection(force_new=True)

    _ensure_migration_table(connection)
    applied = _fetch_applied(connection)
    newly_applied: list[str] = []
    for path in list_migration_files(migrations_dir):
        migration_id = path.name
        if migration_id in applied:
            continue
        sql = path.read_text(encoding="utf-8").strip()
        if not sql:
            _record_applied(connection, migration_id)
            newly_applied.append(migration_id)
            continue
        result = connection.execute(sql)
        _close_cursor(result)
        _record_applied(connection, migration_id)
        newly_applied.append(migration_id)
    return newly_applied


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Apply Hermes enterprise SQL migrations")
    parser.add_argument("--apply", action="store_true", help="Apply pending migrations")
    args = parser.parse_args(argv)
    if not args.apply:
        parser.error("--apply is required")
    applied = apply_enterprise_migrations()
    if applied:
        print("Applied enterprise migrations:")
        for migration_id in applied:
            print(f"  - {migration_id}")
    else:
        print("Enterprise migrations already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
