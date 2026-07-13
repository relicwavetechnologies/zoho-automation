CREATE TABLE "CompanySerperConnection" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "apiKeyEncrypted" TEXT NOT NULL,
  "keyFingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'connected',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "lastTestedAt" TIMESTAMP(3),
  "lastSucceededAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastFailureCode" TEXT,
  "lastUsedAt" TIMESTAMP(3),
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "CompanySerperConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanySerperConnection_companyId_keyFingerprint_key" ON "CompanySerperConnection"("companyId", "keyFingerprint");
CREATE INDEX "CompanySerperConnection_companyId_status_priority_idx" ON "CompanySerperConnection"("companyId", "status", "priority");
ALTER TABLE "CompanySerperConnection" ADD CONSTRAINT "CompanySerperConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanySerperConnection" ADD CONSTRAINT "CompanySerperConnection_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
