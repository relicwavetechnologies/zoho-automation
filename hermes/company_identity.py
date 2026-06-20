"""Company identity sidecar store for Hermes.

This module intentionally does not modify ``state.db``.  The prototype company
identity layer lives in ``HERMES_HOME/company.db`` and binds Hermes session IDs
to stable company/user/channel identities.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional

from hermes_constants import get_hermes_home


DEFAULT_COMPANY_SLUG = "default"
DEFAULT_COMPANY_NAME = "Default Company"
DISABLED_COMPANY_USER_STATUSES = {"disabled", "inactive", "suspended"}


def _now() -> float:
    return time.time()


def get_default_company_db_path() -> Path:
    return get_hermes_home() / "company.db"


def _clean_slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", (value or "").strip().lower())
    cleaned = cleaned.strip("-_")
    return cleaned or DEFAULT_COMPANY_SLUG


def _stable_id(prefix: str, *parts: object) -> str:
    seed = "\x1f".join(str(part or "") for part in parts)
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


def dashboard_company_user_id(
    company_id: str,
    provider: str,
    provider_user_id: str,
) -> str:
    """Stable company user id for a dashboard-auth provider subject."""
    return _stable_id(
        "cu",
        company_id,
        str(provider or "dashboard").strip() or "dashboard",
        str(provider_user_id or "").strip(),
    )


def _json_dumps(value: Mapping[str, Any]) -> str:
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"))


def _normalize_text(value: str | None, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _is_disabled_status(value: Any) -> bool:
    return str(value or "").strip().lower() in DISABLED_COMPANY_USER_STATUSES


def _canonical_channel(value: str | None) -> str:
    channel = str(value or "unknown").strip().lower() or "unknown"
    if channel == "feishu":
        return "lark"
    return channel


@dataclass(frozen=True)
class CompanyIdentity:
    company_id: str
    company_user_id: Optional[str]
    channel_identity_id: str
    identity_key: str


class CompanyIdentityDB:
    """SQLite sidecar for company/user/channel/session identity."""

    def __init__(self, db_path: Path | str | None = None):
        self.db_path = Path(db_path) if db_path else get_default_company_db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            timeout=1.0,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._init_connection()
        self._init_schema()

    def close(self) -> None:
        self._conn.close()

    def _init_connection(self) -> None:
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.DatabaseError:
            self._conn.execute("PRAGMA journal_mode=DELETE")
        self._conn.execute("PRAGMA foreign_keys=ON")

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_version (
                    version INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS companies (
                    id TEXT PRIMARY KEY,
                    slug TEXT UNIQUE NOT NULL,
                    display_name TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS company_users (
                    id TEXT PRIMARY KEY,
                    company_id TEXT NOT NULL,
                    display_name TEXT,
                    email TEXT,
                    role TEXT NOT NULL DEFAULT 'MEMBER',
                    department_id TEXT,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    UNIQUE(company_id, email),
                    FOREIGN KEY (company_id) REFERENCES companies(id)
                );

                CREATE TABLE IF NOT EXISTS channel_identities (
                    id TEXT PRIMARY KEY,
                    company_id TEXT NOT NULL,
                    company_user_id TEXT,
                    platform TEXT NOT NULL,
                    identity_key TEXT NOT NULL,
                    platform_user_id TEXT,
                    platform_user_id_alt TEXT,
                    platform_chat_id TEXT,
                    platform_workspace_id TEXT,
                    display_name TEXT,
                    identity_kind TEXT NOT NULL DEFAULT 'user',
                    approved_source TEXT,
                    raw_json TEXT,
                    first_seen_at REAL NOT NULL,
                    last_seen_at REAL NOT NULL,
                    UNIQUE(company_id, platform, identity_key),
                    FOREIGN KEY (company_id) REFERENCES companies(id),
                    FOREIGN KEY (company_user_id) REFERENCES company_users(id)
                );

                CREATE TABLE IF NOT EXISTS session_identities (
                    session_id TEXT PRIMARY KEY,
                    session_key TEXT NOT NULL,
                    company_id TEXT NOT NULL,
                    company_user_id TEXT,
                    channel_identity_id TEXT,
                    platform TEXT,
                    chat_id TEXT,
                    thread_id TEXT,
                    binding_source TEXT NOT NULL,
                    bound_at REAL NOT NULL,
                    last_seen_at REAL NOT NULL,
                    FOREIGN KEY (company_id) REFERENCES companies(id),
                    FOREIGN KEY (company_user_id) REFERENCES company_users(id),
                    FOREIGN KEY (channel_identity_id) REFERENCES channel_identities(id)
                );

                CREATE TABLE IF NOT EXISTS tool_audit_logs (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    company_id TEXT NOT NULL,
                    company_user_id TEXT,
                    tool_name TEXT NOT NULL,
                    tool_call_id TEXT,
                    status TEXT,
                    created_at REAL NOT NULL,
                    metadata_json TEXT,
                    FOREIGN KEY (company_id) REFERENCES companies(id),
                    FOREIGN KEY (company_user_id) REFERENCES company_users(id)
                );

                CREATE TABLE IF NOT EXISTS company_user_home_channels (
                    id TEXT PRIMARY KEY,
                    company_id TEXT NOT NULL,
                    company_user_id TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    chat_name TEXT,
                    thread_id TEXT,
                    channel_identity_id TEXT,
                    metadata_json TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    UNIQUE(company_id, company_user_id, platform),
                    FOREIGN KEY (company_id) REFERENCES companies(id),
                    FOREIGN KEY (company_user_id) REFERENCES company_users(id),
                    FOREIGN KEY (channel_identity_id) REFERENCES channel_identities(id)
                );

                CREATE INDEX IF NOT EXISTS idx_channel_identities_company_user
                    ON channel_identities(company_id, company_user_id);
                CREATE INDEX IF NOT EXISTS idx_session_identities_company_user
                    ON session_identities(company_id, company_user_id);
                CREATE INDEX IF NOT EXISTS idx_tool_audit_logs_session
                    ON tool_audit_logs(session_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_company_user_home_channels_user
                    ON company_user_home_channels(company_id, company_user_id);
                """
            )
            row = self._conn.execute("SELECT COUNT(*) AS c FROM schema_version").fetchone()
            if row and int(row["c"]) == 0:
                self._conn.execute("INSERT INTO schema_version (version) VALUES (1)")
            self._ensure_column("company_users", "role", "TEXT NOT NULL DEFAULT 'MEMBER'")
            self._ensure_column("company_users", "department_id", "TEXT")

    def _ensure_column(self, table: str, column: str, sql_type: str) -> None:
        row = self._conn.execute(
            f"PRAGMA table_info({table})"
        ).fetchall()
        names = {str(item["name"]) for item in row}
        if column in names:
            return
        self._conn.execute(
            f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}"
        )

    def ensure_default_company(self) -> str:
        company_id = os.getenv("HERMES_COMPANY_ID", "").strip()
        slug = _clean_slug(os.getenv("HERMES_COMPANY_SLUG", "") or DEFAULT_COMPANY_SLUG)
        display_name = (
            os.getenv("HERMES_COMPANY_NAME", "").strip()
            or os.getenv("HERMES_COMPANY_DISPLAY_NAME", "").strip()
            or DEFAULT_COMPANY_NAME
        )
        if not company_id:
            company_id = f"company_{slug}"
        self._ensure_company(company_id, slug=slug, display_name=display_name)
        return company_id

    def _ensure_company(
        self,
        company_id: str,
        *,
        slug: str | None = None,
        display_name: str | None = None,
    ) -> None:
        now = _now()
        effective_slug = slug or _clean_slug(company_id.removeprefix("company_"))
        effective_name = display_name or company_id.replace("_", " ").strip() or DEFAULT_COMPANY_NAME
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO companies (id, slug, display_name, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    slug = excluded.slug,
                    display_name = excluded.display_name,
                    updated_at = excluded.updated_at
                """,
                (company_id, effective_slug, effective_name, now, now),
            )

    def resolve_channel_identity(
        self,
        *,
        platform: str,
        chat_id: str,
        user_id: str | None = None,
        user_name: str | None = None,
        user_id_alt: str | None = None,
        thread_id: str | None = None,
        platform_workspace_id: str | None = None,
        company_id: str | None = None,
        raw: Mapping[str, Any] | None = None,
    ) -> CompanyIdentity:
        company_id = company_id or self.ensure_default_company()
        platform = _canonical_channel(platform)
        chat_id = str(chat_id or "")
        user_id = str(user_id).strip() if user_id else None
        user_id_alt = str(user_id_alt).strip() if user_id_alt else None
        user_name = str(user_name).strip() if user_name else None
        thread_id = str(thread_id).strip() if thread_id else None
        platform_workspace_id = (
            str(platform_workspace_id).strip() if platform_workspace_id else None
        )

        platform_user_id = user_id or user_id_alt
        if platform_user_id:
            identity_key = f"user:{platform_user_id}"
            identity_kind = "user"
        else:
            chat_key = chat_id or "unknown"
            if thread_id:
                chat_key = f"{chat_key}:{thread_id}"
            identity_key = f"chat:{chat_key}"
            identity_kind = "channel"

        existing_identity = self._find_existing_channel_identity(
            company_id=company_id,
            platform=platform,
            identity_key=identity_key,
            platform_user_id=platform_user_id,
            user_id_alt=user_id_alt,
        )

        company_user_id = (
            str(existing_identity["company_user_id"])
            if existing_identity and existing_identity["company_user_id"]
            else None
        )
        if platform_user_id:
            company_user_id = company_user_id or _stable_id(
                "cu", company_id, platform, platform_user_id
            )
            self._upsert_company_user(
                company_user_id=company_user_id,
                company_id=company_id,
                display_name=(
                    user_name
                    or (str(existing_identity["display_name"]) if existing_identity and existing_identity["display_name"] else None)
                ),
                email=(
                    str(existing_identity["email"]) if existing_identity and existing_identity["email"] else None
                ),
            )

        channel_identity_id = (
            str(existing_identity["id"])
            if existing_identity and existing_identity["id"]
            else _stable_id("ci", company_id, platform, identity_key)
        )
        now = _now()
        raw_payload = {
            "platform": platform,
            "chat_id": chat_id,
            "user_id": user_id,
            "user_id_alt": user_id_alt,
            "user_name": user_name,
            "thread_id": thread_id,
            "platform_workspace_id": platform_workspace_id,
        }
        if raw:
            raw_payload.update(raw)

        with self._lock:
            self._conn.execute(
                """
                INSERT INTO channel_identities (
                    id, company_id, company_user_id, platform, identity_key,
                    platform_user_id, platform_user_id_alt, platform_chat_id,
                    platform_workspace_id, display_name, identity_kind,
                    approved_source, raw_json, first_seen_at, last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(company_id, platform, identity_key) DO UPDATE SET
                    company_user_id = excluded.company_user_id,
                    platform_user_id = excluded.platform_user_id,
                    platform_user_id_alt = excluded.platform_user_id_alt,
                    platform_chat_id = excluded.platform_chat_id,
                    platform_workspace_id = excluded.platform_workspace_id,
                    display_name = COALESCE(excluded.display_name, channel_identities.display_name),
                    identity_kind = excluded.identity_kind,
                    raw_json = excluded.raw_json,
                    last_seen_at = excluded.last_seen_at
                """,
                (
                    channel_identity_id,
                    company_id,
                    company_user_id,
                    _canonical_channel(platform),
                    identity_key,
                    user_id,
                    user_id_alt,
                    chat_id,
                    platform_workspace_id,
                    user_name,
                    identity_kind,
                    "gateway",
                    _json_dumps(raw_payload),
                    now,
                    now,
                ),
            )

        return CompanyIdentity(
            company_id=company_id,
            company_user_id=company_user_id,
            channel_identity_id=channel_identity_id,
            identity_key=identity_key,
        )

    def _find_existing_channel_identity(
        self,
        *,
        company_id: str,
        platform: str,
        identity_key: str,
        platform_user_id: str | None,
        user_id_alt: str | None,
    ) -> sqlite3.Row | None:
        if not platform_user_id and not user_id_alt:
            return None
        return self._conn.execute(
            """
            SELECT ci.*, cu.email, cu.role AS company_role
            FROM channel_identities ci
            LEFT JOIN company_users cu ON cu.id = ci.company_user_id
            WHERE ci.company_id = ?
              AND (
                (ci.platform = ? AND (ci.identity_key = ? OR ci.platform_user_id = ?))
                OR ci.platform_user_id_alt = ?
              )
            ORDER BY
              CASE WHEN COALESCE(cu.email, '') <> '' THEN 0 ELSE 1 END,
              CASE WHEN ci.approved_source = 'dashboard_auth' THEN 0 ELSE 1 END,
              CASE WHEN COALESCE(cu.role, '') IN ('SUPER_ADMIN', 'OWNER', 'COMPANY_ADMIN', 'ADMIN') THEN 0 ELSE 1 END,
              CASE WHEN ci.identity_key = ? OR ci.platform_user_id = ? THEN 0 ELSE 1 END,
              ci.last_seen_at DESC
            LIMIT 1
            """,
            (
                company_id,
                platform,
                identity_key,
                platform_user_id,
                user_id_alt,
                identity_key,
                platform_user_id,
            ),
        ).fetchone()

    def _find_company_user_id_by_channel_alt(
        self,
        *,
        company_id: str,
        provider: str,
        provider_user_id_alt: str | None,
    ) -> str | None:
        provider_user_id_alt = str(provider_user_id_alt or "").strip()
        if not provider_user_id_alt:
            return None
        row = self._conn.execute(
            """
            SELECT ci.company_user_id
            FROM channel_identities ci
            LEFT JOIN company_users cu ON cu.id = ci.company_user_id
            WHERE ci.company_id = ?
              AND ci.platform = ?
              AND ci.platform_user_id_alt = ?
              AND NULLIF(ci.company_user_id, '') IS NOT NULL
            ORDER BY
              CASE WHEN COALESCE(cu.email, '') <> '' THEN 0 ELSE 1 END,
              CASE WHEN ci.approved_source = 'dashboard_auth' THEN 0 ELSE 1 END,
              CASE WHEN COALESCE(cu.role, '') IN ('SUPER_ADMIN', 'OWNER', 'COMPANY_ADMIN', 'ADMIN') THEN 0 ELSE 1 END,
              ci.last_seen_at DESC
            LIMIT 1
            """,
            (company_id, provider, provider_user_id_alt),
        ).fetchone()
        return str(row["company_user_id"]) if row and row["company_user_id"] else None

    def _list_company_user_ids_by_channel_alt(
        self,
        *,
        company_id: str,
        provider: str,
        provider_user_id_alt: str | None,
    ) -> list[str]:
        provider_user_id_alt = str(provider_user_id_alt or "").strip()
        if not provider_user_id_alt:
            return []
        rows = self._conn.execute(
            """
            SELECT DISTINCT company_user_id
            FROM channel_identities
            WHERE company_id = ?
              AND platform = ?
              AND platform_user_id_alt = ?
              AND NULLIF(company_user_id, '') IS NOT NULL
            """,
            (company_id, provider, provider_user_id_alt),
        ).fetchall()
        return [str(row["company_user_id"]) for row in rows if row["company_user_id"]]

    def _merge_channel_alt_to_company_user(
        self,
        *,
        company_id: str,
        provider: str,
        provider_user_id_alt: str | None,
        target_company_user_id: str,
    ) -> None:
        source_ids = self._list_company_user_ids_by_channel_alt(
            company_id=company_id,
            provider=provider,
            provider_user_id_alt=provider_user_id_alt,
        )
        provider_user_id_alt = str(provider_user_id_alt or "").strip()
        now = _now()
        if provider_user_id_alt:
            with self._lock:
                self._conn.execute(
                    """
                    UPDATE channel_identities
                    SET company_user_id = ?, last_seen_at = ?
                    WHERE company_id = ?
                      AND platform = ?
                      AND platform_user_id_alt = ?
                      AND COALESCE(company_user_id, '') <> ?
                    """,
                    (
                        target_company_user_id,
                        now,
                        company_id,
                        provider,
                        provider_user_id_alt,
                        target_company_user_id,
                    ),
                )
        self._merge_company_user_refs(
            company_id=company_id,
            target_company_user_id=target_company_user_id,
            source_company_user_ids=source_ids,
        )

    def _merge_company_user_refs(
        self,
        *,
        company_id: str,
        target_company_user_id: str,
        source_company_user_ids: list[str],
    ) -> None:
        now = _now()
        with self._lock:
            for source_company_user_id in sorted(set(source_company_user_ids)):
                if not source_company_user_id or source_company_user_id == target_company_user_id:
                    continue
                self._conn.execute(
                    """
                    UPDATE channel_identities
                    SET company_user_id = ?, last_seen_at = ?
                    WHERE company_id = ? AND company_user_id = ?
                    """,
                    (target_company_user_id, now, company_id, source_company_user_id),
                )
                self._conn.execute(
                    """
                    UPDATE session_identities
                    SET company_user_id = ?, last_seen_at = ?
                    WHERE company_id = ? AND company_user_id = ?
                    """,
                    (target_company_user_id, now, company_id, source_company_user_id),
                )
                self._conn.execute(
                    """
                    UPDATE tool_audit_logs
                    SET company_user_id = ?
                    WHERE company_id = ? AND company_user_id = ?
                    """,
                    (target_company_user_id, company_id, source_company_user_id),
                )
                self._conn.execute(
                    """
                    DELETE FROM company_user_home_channels
                    WHERE company_id = ?
                      AND company_user_id = ?
                      AND EXISTS (
                        SELECT 1
                        FROM company_user_home_channels target
                        WHERE target.company_id = company_user_home_channels.company_id
                          AND target.company_user_id = ?
                          AND target.platform = company_user_home_channels.platform
                      )
                    """,
                    (company_id, source_company_user_id, target_company_user_id),
                )
                self._conn.execute(
                    """
                    UPDATE company_user_home_channels
                    SET company_user_id = ?, updated_at = ?
                    WHERE company_id = ? AND company_user_id = ?
                    """,
                    (target_company_user_id, now, company_id, source_company_user_id),
                )
                self._conn.execute(
                    """
                    DELETE FROM company_users
                    WHERE id = ?
                      AND company_id = ?
                      AND NOT EXISTS (
                        SELECT 1 FROM channel_identities
                        WHERE company_id = ? AND company_user_id = ?
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM session_identities
                        WHERE company_id = ? AND company_user_id = ?
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM company_user_home_channels
                        WHERE company_id = ? AND company_user_id = ?
                      )
                    """,
                    (
                        source_company_user_id,
                        company_id,
                        company_id,
                        source_company_user_id,
                        company_id,
                        source_company_user_id,
                        company_id,
                        source_company_user_id,
                    ),
                )

    def _upsert_company_user(
        self,
        *,
        company_user_id: str,
        company_id: str,
        display_name: str | None = None,
        email: str | None = None,
        role: str | None = None,
        department_id: str | None = None,
    ) -> None:
        now = _now()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO company_users (
                    id, company_id, display_name, email, role, department_id,
                    status, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    display_name = COALESCE(excluded.display_name, company_users.display_name),
                    email = COALESCE(excluded.email, company_users.email),
                    role = CASE
                        WHEN ? IS NULL THEN company_users.role
                        ELSE excluded.role
                    END,
                    department_id = COALESCE(excluded.department_id, company_users.department_id),
                    updated_at = excluded.updated_at
                """,
                (
                    company_user_id,
                    company_id,
                    display_name,
                    email,
                    role or "MEMBER",
                    department_id,
                    now,
                    now,
                    role,
                ),
            )

    def upsert_dashboard_member(
        self,
        *,
        provider: str,
        provider_user_id: str,
        provider_user_id_alt: str | None = None,
        display_name: str | None = None,
        email: str | None = None,
        company_id: str | None = None,
        role: str | None = None,
        department_id: str | None = None,
        status: str = "active",
    ) -> dict[str, Any]:
        company_id = company_id or self.ensure_default_company()
        self._ensure_company(company_id)
        provider = str(provider or "dashboard").strip() or "dashboard"
        provider_user_id = str(provider_user_id or "").strip()
        provider_user_id_alt = str(provider_user_id_alt or "").strip() or None
        if not provider_user_id:
            raise ValueError("provider_user_id is required")

        existing_id = None
        if email:
            row = self._conn.execute(
                """
                SELECT id FROM company_users
                WHERE company_id = ? AND email = ?
                LIMIT 1
                """,
                (company_id, email),
            ).fetchone()
            existing_id = row["id"] if row else None

        existing_id = existing_id or self._find_company_user_id_by_channel_alt(
            company_id=company_id,
            provider=provider,
            provider_user_id_alt=provider_user_id_alt,
        )
        company_user_id = existing_id or _stable_id(
            "cu", company_id, provider, provider_user_id
        )
        existing_row = self.get_company_user(company_user_id)
        effective_status = _normalize_text(status, "active")
        if existing_row and _is_disabled_status(existing_row.get("status")) and effective_status == "active":
            # Login upsert must not silently reactivate an employee disabled
            # by an admin action. Reactivation goes through update_company_user.
            effective_status = str(existing_row.get("status") or "disabled")

        self._upsert_company_user(
            company_user_id=company_user_id,
            company_id=company_id,
            display_name=display_name,
            email=email,
            role=role,
            department_id=department_id,
        )

        now = _now()
        with self._lock:
            self._conn.execute(
                """
                UPDATE company_users
                SET status = ?, updated_at = ?
                WHERE id = ?
                """,
                (effective_status, now, company_user_id),
            )
        self._link_dashboard_channel_identity(
            company_id=company_id,
            company_user_id=company_user_id,
            provider=provider,
            provider_user_id=provider_user_id,
            provider_user_id_alt=provider_user_id_alt,
            display_name=display_name,
        )
        self._merge_channel_alt_to_company_user(
            company_id=company_id,
            provider=provider,
            provider_user_id_alt=provider_user_id_alt,
            target_company_user_id=company_user_id,
        )
        row = self.get_company_user(company_user_id)
        if row is None:
            raise RuntimeError("company user upsert did not persist")
        return row

    def _link_dashboard_channel_identity(
        self,
        *,
        company_id: str,
        company_user_id: str,
        provider: str,
        provider_user_id: str,
        provider_user_id_alt: str | None = None,
        display_name: str | None = None,
    ) -> None:
        identity_key = f"user:{provider_user_id}"
        channel_identity_id = _stable_id("ci", company_id, provider, identity_key)
        provider_user_id_alt = str(provider_user_id_alt or "").strip() or None
        now = _now()
        raw_payload = {
            "platform": provider,
            "user_id": provider_user_id,
            "user_id_alt": provider_user_id_alt,
            "user_name": display_name,
            "source": "dashboard_auth",
        }
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO channel_identities (
                    id, company_id, company_user_id, platform, identity_key,
                    platform_user_id, platform_user_id_alt, platform_chat_id,
                    platform_workspace_id, display_name, identity_kind,
                    approved_source, raw_json, first_seen_at, last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(company_id, platform, identity_key) DO UPDATE SET
                    company_user_id = excluded.company_user_id,
                    platform_user_id = excluded.platform_user_id,
                    platform_user_id_alt = COALESCE(excluded.platform_user_id_alt, channel_identities.platform_user_id_alt),
                    display_name = COALESCE(excluded.display_name, channel_identities.display_name),
                    approved_source = excluded.approved_source,
                    raw_json = excluded.raw_json,
                    last_seen_at = excluded.last_seen_at
                """,
                (
                    channel_identity_id,
                    company_id,
                    company_user_id,
                    provider,
                    identity_key,
                    provider_user_id,
                    provider_user_id_alt,
                    "",
                    company_id,
                    display_name,
                    "user",
                    "dashboard_auth",
                    _json_dumps(raw_payload),
                    now,
                    now,
                ),
            )

    def get_company(self, company_id: str) -> Optional[dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM companies WHERE id = ?",
            (company_id,),
        ).fetchone()
        return dict(row) if row else None

    def find_dashboard_company_user(
        self,
        *,
        provider: str,
        provider_user_id: str,
        company_id: str | None = None,
    ) -> Optional[dict[str, Any]]:
        company_id = company_id or self.ensure_default_company()
        provider = str(provider or "dashboard").strip() or "dashboard"
        provider_user_id = str(provider_user_id or "").strip()
        if not provider_user_id:
            return None
        company_user_id = _stable_id("cu", company_id, provider, provider_user_id)
        return self.get_company_user(company_user_id)

    def list_channel_identities_for_company_user(
        self,
        company_user_id: str,
    ) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT *
            FROM channel_identities
            WHERE company_user_id = ?
            ORDER BY last_seen_at DESC
            """,
            (company_user_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def bind_session_identity(
        self,
        *,
        session_id: str,
        session_key: str,
        identity: CompanyIdentity,
        platform: str | None = None,
        chat_id: str | None = None,
        thread_id: str | None = None,
        binding_source: str = "gateway",
    ) -> None:
        now = _now()
        effective_platform = _canonical_channel(platform)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO session_identities (
                    session_id, session_key, company_id, company_user_id,
                    channel_identity_id, platform, chat_id, thread_id,
                    binding_source, bound_at, last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    session_key = excluded.session_key,
                    company_id = excluded.company_id,
                    company_user_id = excluded.company_user_id,
                    channel_identity_id = excluded.channel_identity_id,
                    platform = excluded.platform,
                    chat_id = excluded.chat_id,
                    thread_id = excluded.thread_id,
                    binding_source = excluded.binding_source,
                    last_seen_at = excluded.last_seen_at
                """,
                (
                    session_id,
                    session_key,
                    identity.company_id,
                    identity.company_user_id,
                    identity.channel_identity_id,
                    effective_platform,
                    chat_id,
                    thread_id,
                    binding_source,
                    now,
                    now,
                ),
            )

    def get_session_identity(self, session_id: str) -> Optional[dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM session_identities WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        return dict(row) if row else None

    def list_session_identities_for_company_user(
        self,
        company_user_id: str,
    ) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT *
            FROM session_identities
            WHERE company_user_id = ?
            ORDER BY last_seen_at DESC
            """,
            (company_user_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def upsert_company_user_home_channel(
        self,
        *,
        company_id: str,
        company_user_id: str,
        platform: str,
        chat_id: str,
        chat_name: str | None = None,
        thread_id: str | None = None,
        channel_identity_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        company_id = _normalize_text(company_id)
        company_user_id = _normalize_text(company_user_id)
        platform = _canonical_channel(platform)
        chat_id = _normalize_text(chat_id)
        if not company_id or not company_user_id or not platform or not chat_id:
            raise ValueError("company_id, company_user_id, platform, and chat_id are required")

        self._ensure_company(company_id)
        home_id = _stable_id("home", company_id, company_user_id, platform)
        now = _now()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO company_user_home_channels (
                    id, company_id, company_user_id, platform, chat_id, chat_name,
                    thread_id, channel_identity_id, metadata_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(company_id, company_user_id, platform) DO UPDATE SET
                    chat_id = excluded.chat_id,
                    chat_name = excluded.chat_name,
                    thread_id = excluded.thread_id,
                    channel_identity_id = excluded.channel_identity_id,
                    metadata_json = excluded.metadata_json,
                    updated_at = excluded.updated_at
                """,
                (
                    home_id,
                    company_id,
                    company_user_id,
                    platform,
                    chat_id,
                    chat_name,
                    thread_id,
                    channel_identity_id,
                    _json_dumps(metadata or {}),
                    now,
                    now,
                ),
            )
        row = self.get_company_user_home_channel(
            company_id=company_id,
            company_user_id=company_user_id,
            platform=platform,
        )
        if row is None:
            raise RuntimeError("company user home channel did not persist")
        return row

    def get_company_user_home_channel(
        self,
        *,
        company_id: str,
        company_user_id: str,
        platform: str,
    ) -> Optional[dict[str, Any]]:
        row = self._conn.execute(
            """
            SELECT *
            FROM company_user_home_channels
            WHERE company_id = ? AND company_user_id = ? AND platform = ?
            """,
            (company_id, company_user_id, _canonical_channel(platform)),
        ).fetchone()
        return dict(row) if row else None

    def list_company_user_home_channels(
        self,
        *,
        company_id: str,
        company_user_id: str,
    ) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT *
            FROM company_user_home_channels
            WHERE company_id = ? AND company_user_id = ?
            ORDER BY platform
            """,
            (company_id, company_user_id),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_channel_identity(self, channel_identity_id: str) -> Optional[dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM channel_identities WHERE id = ?",
            (channel_identity_id,),
        ).fetchone()
        return dict(row) if row else None

    def get_company_user(self, company_user_id: str) -> Optional[dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM company_users WHERE id = ?",
            (company_user_id,),
        ).fetchone()
        return dict(row) if row else None

    def update_company_user(
        self,
        *,
        company_user_id: str,
        company_id: str | None = None,
        role: str | None = None,
        status: str | None = None,
        department_id: str | None = None,
    ) -> Optional[dict[str, Any]]:
        company_id = company_id or self.ensure_default_company()
        updates: list[str] = []
        args: list[Any] = []
        if role is not None:
            updates.append("role = ?")
            args.append(_normalize_text(role, "MEMBER"))
        if status is not None:
            updates.append("status = ?")
            args.append(_normalize_text(status, "active"))
        if department_id is not None:
            updates.append("department_id = ?")
            args.append(_normalize_text(department_id, "") or None)
        if not updates:
            row = self.get_company_user(company_user_id)
            return row if row and row.get("company_id") == company_id else None

        updates.append("updated_at = ?")
        args.append(_now())
        args.extend([company_user_id, company_id])
        with self._lock:
            self._conn.execute(
                f"""
                UPDATE company_users
                SET {", ".join(updates)}
                WHERE id = ? AND company_id = ?
                """,
                tuple(args),
            )
        row = self.get_company_user(company_user_id)
        if row and row.get("company_id") == company_id:
            return row
        return None

    def list_company_users(self, *, company_id: str | None = None) -> list[dict[str, Any]]:
        company_id = company_id or self.ensure_default_company()
        rows = self._conn.execute(
            """
            SELECT *
            FROM company_users
            WHERE company_id = ?
            ORDER BY
                CASE WHEN display_name IS NULL OR display_name = '' THEN 1 ELSE 0 END,
                lower(COALESCE(display_name, email, id))
            """,
            (company_id,),
        ).fetchall()
        return [dict(row) for row in rows]
