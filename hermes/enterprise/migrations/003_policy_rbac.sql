-- Hermes-Divo local policy/RBAC catalog and audit tables.
-- Runtime decisions remain local to Hermes; these tables store policy state
-- and decision logs, not AWS Verified Permissions data.

CREATE TABLE IF NOT EXISTS "PolicySchemaVersion" (
    "id" TEXT PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "schemaText" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "migrationNotes" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "PolicyTemplate" (
    "id" TEXT PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE ("companyId", "name")
);

CREATE TABLE IF NOT EXISTS "PolicyBinding" (
    "id" TEXT PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL DEFAULT 'adhoc',
    "principalType" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT '*',
    "effect" TEXT NOT NULL DEFAULT 'permit',
    "contextJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "PolicyBinding_company_active_idx"
    ON "PolicyBinding" ("companyId", "status", "principalType", "principalId");

CREATE TABLE IF NOT EXISTS "PolicySnapshot" (
    "id" TEXT PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "schemaVersionId" TEXT NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "PolicyDecisionLog" (
    "id" TEXT PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "mode" TEXT NOT NULL,
    "snapshotId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "PolicyDecisionLog_company_created_idx"
    ON "PolicyDecisionLog" ("companyId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS "PolicyToolCatalog" (
    "id" TEXT PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolset" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "riskClass" TEXT NOT NULL DEFAULT 'normal',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE ("companyId", "toolName", "action")
);

CREATE TABLE IF NOT EXISTS "PolicyRouteCatalog" (
    "id" TEXT PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "routeKey" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "pathPattern" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "riskClass" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE ("companyId", "routeKey", "method")
);
