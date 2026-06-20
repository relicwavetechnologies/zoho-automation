-- Curated agent memory moved off flat files onto Postgres.
-- Two buckets: personal (per-user, auto-written) and company (shared, read-only
-- to the agent in v1 — companyUserId IS NULL). No embedding column in v1;
-- semantic search is a later, company-bucket-only addition on this same table.

CREATE TABLE IF NOT EXISTS "HermesMemoryEntry" (
  "id"            TEXT PRIMARY KEY,
  "companyId"     TEXT NOT NULL REFERENCES "Company"("id") ON DELETE CASCADE,
  "companyUserId" TEXT NULL REFERENCES "CompanyUser"("id") ON DELETE CASCADE,  -- NULL = company-shared
  "scope"         TEXT NOT NULL DEFAULT 'personal',   -- 'personal' | 'company'
  "kind"          TEXT NOT NULL,                       -- 'fact' (MEMORY.md) | 'preference' (USER.md)
  "content"       TEXT NOT NULL,
  "source"        TEXT NOT NULL DEFAULT 'auto',        -- 'auto' | 'user' | 'admin'
  "createdBy"     TEXT NULL,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt"     TIMESTAMPTZ NULL                     -- soft delete (GDPR/audit)
);

-- One live copy of a given content per (user, scope, kind). COALESCE so the
-- NULL companyUserId of company rows dedupes too (NULLs are otherwise distinct).
CREATE UNIQUE INDEX IF NOT EXISTS "HermesMemoryEntry_dedupe_idx"
  ON "HermesMemoryEntry" ("companyId", COALESCE("companyUserId", ''), "scope", "kind", md5("content"))
  WHERE "deletedAt" IS NULL;

-- Read path: a user's personal slice + the company slice.
CREATE INDEX IF NOT EXISTS "HermesMemoryEntry_read_idx"
  ON "HermesMemoryEntry" ("companyId", "scope", "companyUserId", "kind", "createdAt")
  WHERE "deletedAt" IS NULL;

CREATE TABLE IF NOT EXISTS "HermesMemoryAudit" (
  "id"          TEXT PRIMARY KEY,
  "companyId"   TEXT NOT NULL,
  "entryId"     TEXT NULL,
  "action"      TEXT NOT NULL,            -- 'add' | 'replace' | 'remove' | 'promote'
  "kind"        TEXT NULL,
  "actorUserId" TEXT NULL,
  "before"      TEXT NULL,
  "after"       TEXT NULL,
  "metadata"    JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "HermesMemoryAudit_company_time_idx"
  ON "HermesMemoryAudit" ("companyId", "createdAt" DESC);
