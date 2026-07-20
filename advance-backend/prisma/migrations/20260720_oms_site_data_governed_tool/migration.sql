-- Company-owned OMS Site Data credentials. This migration does not grant
-- normal members access: PermissionService exposes the tool only to live
-- COMPANY_ADMIN or SUPER_ADMIN memberships.

CREATE TABLE "CompanyOmsConnection" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "apiKeyEncrypted" TEXT NOT NULL,
  "keyFingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'connected',
  "lastTestedAt" TIMESTAMP(3),
  "lastSucceededAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastFailureCode" TEXT,
  "lastUsedAt" TIMESTAMP(3),
  "unavailableUntil" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanyOmsConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyOmsConnection_companyId_keyFingerprint_key"
  ON "CompanyOmsConnection"("companyId", "keyFingerprint");
CREATE INDEX "CompanyOmsConnection_companyId_status_unavailableUntil_idx"
  ON "CompanyOmsConnection"("companyId", "status", "unavailableUntil");

ALTER TABLE "CompanyOmsConnection"
  ADD CONSTRAINT "CompanyOmsConnection_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanyOmsConnection"
  ADD CONSTRAINT "CompanyOmsConnection_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "RegisteredTool" (
  "id", "toolId", "name", "description", "category", "domain",
  "hitlRequired", "guardrails", "deprecated", "engines", "createdAt", "updatedAt"
)
SELECT
  'oms-site-data-governed-tool',
  'omsSiteData',
  'OMS Site Inventory',
  'Search the governed, read-only OMS website inventory for site shortlists, profiles, and catalog values.',
  'analytics',
  'oms',
  FALSE,
  ARRAY[
    'Uses only a company-owned server-side OMS Site Data API key',
    'Available only to active company administrators',
    'Supports fixed operations; SQL, raw webhook requests, headers, and provider filters are rejected',
    'OMS responses are capped at 100 rows and have no pagination'
  ]::TEXT[],
  FALSE,
  ARRAY[]::TEXT[],
  NOW(),
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM "RegisteredTool" WHERE "toolId" = 'omsSiteData');
