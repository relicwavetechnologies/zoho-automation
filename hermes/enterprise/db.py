"""Shared Postgres connection helpers for Hermes enterprise persistence."""

from __future__ import annotations

from typing import Any

from .config import EnterprisePostgresConfig

_connection: Any | None = None


def enterprise_postgres_enabled() -> bool:
    return EnterprisePostgresConfig.from_env().enabled


def get_enterprise_connection(*, force_new: bool = False) -> Any:
    """Return a shared psycopg connection for synchronous enterprise repositories."""
    global _connection
    if _connection is not None and not force_new:
        return _connection

    config = EnterprisePostgresConfig.from_env()
    if not config.enabled or not config.database_url:
        raise RuntimeError("Enterprise Postgres is not configured")

    try:
        import psycopg
        from psycopg.rows import dict_row
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Enterprise persistence requires installing hermes-agent[enterprise]"
        ) from exc

    _connection = psycopg.connect(
        config.database_url,
        autocommit=True,
        row_factory=dict_row,
    )
    return _connection


def reset_enterprise_connection_for_tests() -> None:
    """Close and drop the module-level connection (tests only)."""
    global _connection
    if _connection is not None:
        close = getattr(_connection, "close", None)
        if close is not None:
            close()
    _connection = None
