"""Configuration for the Hermes-owned enterprise Postgres boundary."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class EnterprisePostgresConfig:
    """Postgres settings for the transformed runtime.

    SQLite remains a local/dev cache. A missing database URL means the
    enterprise persistence boundary is disabled, not that company.db becomes
    production truth.
    """

    database_url: str = ""
    schema_name: str = "public"
    enabled: bool = False

    @classmethod
    def from_env(cls) -> "EnterprisePostgresConfig":
        database_url = (
            os.getenv("HERMES_ENTERPRISE_DATABASE_URL", "").strip()
            or os.getenv("DATABASE_URL", "").strip()
        )
        schema_name = os.getenv("HERMES_ENTERPRISE_SCHEMA", "public").strip() or "public"
        explicit_enabled = os.getenv("HERMES_ENTERPRISE_POSTGRES", "").strip().lower()
        enabled = bool(database_url)
        if explicit_enabled in {"1", "true", "yes", "on"}:
            enabled = True
        elif explicit_enabled in {"0", "false", "no", "off"}:
            enabled = False
        return cls(database_url=database_url, schema_name=schema_name, enabled=enabled)
