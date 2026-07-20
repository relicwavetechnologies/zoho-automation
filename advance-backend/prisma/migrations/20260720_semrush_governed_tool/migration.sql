-- Company-owned Semrush credentials, paid-data policy, and durable unit
-- reservations. This migration grants no tool access; canonical defaults stay
-- denied until a company administrator chooses to grant the tool.

CREATE TABLE "CompanySemrushConnection" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "apiVersion" TEXT NOT NULL,
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
  CONSTRAINT "CompanySemrushConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompanySemrushPolicy" (
  "companyId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "monthlyUnitBudget" INTEGER NOT NULL,
  "perRunUnitLimit" INTEGER NOT NULL,
  "enabledOperations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "operationUnitCosts" JSONB NOT NULL,
  "cacheEnabled" BOOLEAN NOT NULL DEFAULT false,
  "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 900,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanySemrushPolicy_pkey" PRIMARY KEY ("companyId")
);

CREATE TABLE "CompanySemrushAdminGrant" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "grantedBy" TEXT NOT NULL,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanySemrushAdminGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SemrushUsageReservation" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "estimatedUnits" INTEGER NOT NULL,
  "requestedRows" INTEGER NOT NULL,
  "chargedUnits" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'running',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "SemrushUsageReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanySemrushConnection_companyId_apiVersion_keyFingerprint_key"
  ON "CompanySemrushConnection"("companyId", "apiVersion", "keyFingerprint");
CREATE INDEX "CompanySemrushConnection_companyId_apiVersion_status_unavailableUntil_idx"
  ON "CompanySemrushConnection"("companyId", "apiVersion", "status", "unavailableUntil");
CREATE UNIQUE INDEX "CompanySemrushAdminGrant_companyId_userId_key"
  ON "CompanySemrushAdminGrant"("companyId", "userId");
CREATE INDEX "CompanySemrushAdminGrant_companyId_revokedAt_idx"
  ON "CompanySemrushAdminGrant"("companyId", "revokedAt");
CREATE INDEX "CompanySemrushAdminGrant_userId_revokedAt_idx"
  ON "CompanySemrushAdminGrant"("userId", "revokedAt");
CREATE INDEX "SemrushUsageReservation_companyId_createdAt_status_idx"
  ON "SemrushUsageReservation"("companyId", "createdAt", "status");
CREATE INDEX "SemrushUsageReservation_connectionId_createdAt_status_idx"
  ON "SemrushUsageReservation"("connectionId", "createdAt", "status");
CREATE INDEX "SemrushUsageReservation_correlationId_createdAt_idx"
  ON "SemrushUsageReservation"("correlationId", "createdAt");

ALTER TABLE "CompanySemrushConnection"
  ADD CONSTRAINT "CompanySemrushConnection_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanySemrushConnection"
  ADD CONSTRAINT "CompanySemrushConnection_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CompanySemrushPolicy"
  ADD CONSTRAINT "CompanySemrushPolicy_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanySemrushAdminGrant"
  ADD CONSTRAINT "CompanySemrushAdminGrant_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanySemrushAdminGrant"
  ADD CONSTRAINT "CompanySemrushAdminGrant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanySemrushAdminGrant"
  ADD CONSTRAINT "CompanySemrushAdminGrant_grantedBy_fkey"
  FOREIGN KEY ("grantedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SemrushUsageReservation"
  ADD CONSTRAINT "SemrushUsageReservation_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SemrushUsageReservation"
  ADD CONSTRAINT "SemrushUsageReservation_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "CompanySemrushConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "RegisteredTool" (
  "id", "toolId", "name", "description", "category", "domain",
  "hitlRequired", "guardrails", "deprecated", "engines", "createdAt", "updatedAt"
)
SELECT
  'semrush-governed-tool',
  'semrush',
  'Semrush SEO Research',
  'Run governed, read-only Semrush domain, organic, keyword, and backlink research through official APIs.',
  'analytics',
  'semrush',
  FALSE,
  ARRAY[
    'Uses only company-owned server-side Semrush API keys',
    'Available only after an administrator configures a unit budget and explicitly grants access',
    'Supports a fixed operation allow-list; arbitrary endpoints, exports, and headers are rejected'
  ]::TEXT[],
  FALSE,
  ARRAY[]::TEXT[],
  NOW(),
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM "RegisteredTool" WHERE "toolId" = 'semrush');
