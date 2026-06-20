"""Pluggable persistence for :class:`tools.memory_tool.MemoryStore`.

``MemoryStore`` stays backend-agnostic (in-memory lists, threat scanning,
char-limits, dedup, the frozen system-prompt snapshot) and delegates *only*
persistence to a ``MemoryBackend``:

  - ``FileMemoryBackend``     — the original flat-file storage (MEMORY.md /
    USER.md under the hashed company/user dir). Keeps the file lock + external
    "drift guard" + atomic rename. ``load_company()`` is empty (no company
    concept in standalone Hermes).
  - ``PostgresMemoryBackend`` — rows in ``HermesMemoryEntry`` via
    :class:`enterprise.memory_repository.MemoryRepository`. Personal entries are
    per-user; the company bucket is shared + read-only to the agent in v1. No
    file lock / drift / .bak — Postgres handles concurrency per row.

The mutation contract is one method: ``mutate(target, action, apply)``. The
backend supplies the *fresh* entry list, runs the store's pure transform
``apply(fresh) -> (new_entries | None, response)`` (under a file lock for
``FileMemoryBackend``), persists when ``new_entries`` is not None, and returns
the response. All file-specific concerns live in ``FileMemoryBackend``; all
SQL/row concerns live in ``PostgresMemoryBackend``.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

from utils import atomic_replace

# fcntl is Unix-only; on Windows use msvcrt for file locking (mirrors memory_tool).
msvcrt = None
try:
    import fcntl
except ImportError:  # pragma: no cover - platform-specific
    fcntl = None
    try:
        import msvcrt
    except ImportError:
        pass

logger = logging.getLogger(__name__)

# Type of the pure transform the store hands to ``mutate``: it receives the
# fresh entry list and returns (new_entries_to_persist | None, response_dict).
ApplyFn = Callable[[list], tuple[Optional[list], dict]]


class MemoryBackend(Protocol):
    def load(self, target: str) -> list[str]:
        """Return the persisted personal entries for 'memory' or 'user'."""

    def load_company(self) -> list[str]:
        """Return the read-only shared company entries ([] when unsupported)."""

    def mutate(self, target: str, action: str, apply: ApplyFn) -> dict:
        """Run a guarded read-modify-write and return the tool response dict."""


class FileMemoryBackend:
    """Flat-file persistence — the original MemoryStore behaviour, isolated."""

    def __init__(self, *, char_limits: dict[str, int], dir_provider: Callable[[], Path]):
        self._char_limits = char_limits
        # Resolved lazily so company/user scope (and test monkeypatching of
        # get_memory_dir) is always read at call time, never cached.
        self._dir_provider = dir_provider

    # -- backend interface --------------------------------------------------

    def load(self, target: str) -> list[str]:
        self._dir().mkdir(parents=True, exist_ok=True)
        return self._read_file(self._path_for(target))

    def load_company(self) -> list[str]:
        return []

    def mutate(self, target: str, action: str, apply: ApplyFn) -> dict:
        from tools.memory_tool import _drift_error

        path = self._path_for(target)
        with self._file_lock(path):
            # Re-read under lock to pick up sister-session writes. If the file
            # drifted (un-roundtrippable / oversized entry), it was backed up
            # to .bak.<ts> — refuse the mutation rather than clobber it.
            bak = self._detect_external_drift(target)
            if bak:
                return _drift_error(path, bak)
            fresh = list(dict.fromkeys(self._read_file(path)))
            new_entries, response = apply(fresh)
            if new_entries is not None:
                self._dir().mkdir(parents=True, exist_ok=True)
                self._write_file(path, new_entries)
            return response

    # -- file primitives (moved verbatim from MemoryStore) -----------------

    def _dir(self) -> Path:
        return self._dir_provider()

    def _path_for(self, target: str) -> Path:
        mem_dir = self._dir()
        if target == "user":
            return mem_dir / "USER.md"
        return mem_dir / "MEMORY.md"

    def _char_limit(self, target: str) -> int:
        return self._char_limits.get(target, self._char_limits.get("memory", 2200))

    @staticmethod
    def _file_lock(path: Path):
        return _file_lock(path)

    @staticmethod
    def _read_file(path: Path) -> list[str]:
        from tools.memory_tool import ENTRY_DELIMITER

        if not path.exists():
            return []
        try:
            raw = path.read_text(encoding="utf-8")
        except (OSError, IOError):
            return []
        if not raw.strip():
            return []
        entries = [e.strip() for e in raw.split(ENTRY_DELIMITER)]
        return [e for e in entries if e]

    @staticmethod
    def _write_file(path: Path, entries: list[str]) -> None:
        from tools.memory_tool import ENTRY_DELIMITER

        content = ENTRY_DELIMITER.join(entries) if entries else ""
        try:
            fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp", prefix=".mem_")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(content)
                    f.flush()
                    os.fsync(f.fileno())
                atomic_replace(tmp_path, path)
            except BaseException:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        except (OSError, IOError) as e:
            raise RuntimeError(f"Failed to write memory file {path}: {e}")

    def _detect_external_drift(self, target: str) -> Optional[str]:
        import time

        from tools.memory_tool import ENTRY_DELIMITER

        path = self._path_for(target)
        if not path.exists():
            return None
        try:
            raw = path.read_text(encoding="utf-8")
        except (OSError, IOError):
            return None
        if not raw.strip():
            return None

        parsed = [e.strip() for e in raw.split(ENTRY_DELIMITER) if e.strip()]
        roundtrip = ENTRY_DELIMITER.join(parsed)
        char_limit = self._char_limit(target)
        max_entry_len = max((len(e) for e in parsed), default=0)

        if (raw.strip() == roundtrip) and (max_entry_len <= char_limit):
            return None

        ts = int(time.time())
        bak_path = path.with_suffix(path.suffix + f".bak.{ts}")
        try:
            bak_path.write_text(raw, encoding="utf-8")
        except (OSError, IOError):
            return str(bak_path) + " (BACKUP FAILED — file unchanged on disk)"
        return str(bak_path)


class PostgresMemoryBackend:
    """Row-backed persistence via MemoryRepository. Scope resolved per call."""

    _KIND = {"memory": "fact", "user": "preference"}

    def load(self, target: str) -> list[str]:
        scope = self._scope()
        if not scope:
            return []
        return self._repo().list_personal(
            scope["company_id"], scope["company_user_id"], self._KIND.get(target, "fact")
        )

    def load_company(self) -> list[str]:
        scope = self._scope()
        if not scope:
            return []
        return self._repo().list_company(scope["company_id"])

    def mutate(self, target: str, action: str, apply: ApplyFn) -> dict:
        scope = self._scope()
        kind = self._KIND.get(target, "fact")
        fresh: list[str] = []
        if scope:
            fresh = self._repo().list_personal(scope["company_id"], scope["company_user_id"], kind)
        new_entries, response = apply(list(dict.fromkeys(fresh)))
        if new_entries is not None and scope:
            self._reconcile(scope, kind, action, fresh, new_entries)
        return response

    # -- internals ---------------------------------------------------------

    def _reconcile(self, scope, kind, action, fresh, new_entries) -> None:
        repo = self._repo()
        cid, uid = scope["company_id"], scope["company_user_id"]
        added = [e for e in new_entries if e not in fresh]
        removed = [e for e in fresh if e not in new_entries]
        if action == "replace" and removed and added:
            repo.replace_entry(
                company_id=cid, company_user_id=uid, scope="personal",
                kind=kind, before=removed[0], after=added[0],
            )
            return
        for content in removed:
            repo.remove_entry(
                company_id=cid, company_user_id=uid, scope="personal", kind=kind, content=content
            )
        for content in added:
            repo.add_entry(
                company_id=cid, company_user_id=uid, scope="personal", kind=kind, content=content
            )

    @staticmethod
    def _scope() -> dict:
        from tools.memory_tool import get_company_memory_scope

        try:
            return get_company_memory_scope() or {}
        except Exception:
            return {}

    @staticmethod
    def _repo():
        from enterprise.db import get_enterprise_connection
        from enterprise.memory_repository import MemoryRepository

        return MemoryRepository(get_enterprise_connection())


def make_memory_backend(*, char_limits: dict[str, int], dir_provider: Callable[[], Path]) -> MemoryBackend:
    """Select Postgres in an enterprise session with a company scope, else files."""
    try:
        from enterprise.db import enterprise_postgres_enabled

        if enterprise_postgres_enabled():
            from tools.memory_tool import get_company_memory_scope

            if get_company_memory_scope():
                return PostgresMemoryBackend()
    except Exception:
        logger.debug("memory: Postgres backend unavailable; using files", exc_info=True)
    return FileMemoryBackend(char_limits=char_limits, dir_provider=dir_provider)


# Shared lock context manager (kept module-level so FileMemoryBackend can stay
# a plain dataclass-ish class). Separate .lock file lets the memory file itself
# be atomically replaced.
from contextlib import contextmanager


@contextmanager
def _file_lock(path: Path):
    lock_path = path.with_suffix(path.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    if fcntl is None and msvcrt is None:
        yield
        return

    fd = open(lock_path, "a+", encoding="utf-8")
    try:
        if fcntl:
            fcntl.flock(fd, fcntl.LOCK_EX)
        else:
            fd.seek(0)
            msvcrt.locking(fd.fileno(), msvcrt.LK_LOCK, 1)
        yield
    finally:
        if fcntl:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except (OSError, IOError):
                pass
        elif msvcrt:
            try:
                fd.seek(0)
                msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
            except (OSError, IOError):
                pass
        fd.close()
