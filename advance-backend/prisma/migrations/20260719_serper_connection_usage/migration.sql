ALTER TABLE "CompanySerperConnection"
  ADD COLUMN "successfulRequestCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "creditsAtLastSync" INTEGER,
  ADD COLUMN "usageAtLastCreditSync" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "creditsSyncedAt" TIMESTAMP(3),
  ADD COLUMN "unavailableUntil" TIMESTAMP(3);

CREATE INDEX "CompanySerperConnection_companyId_status_unavailableUntil_idx"
  ON "CompanySerperConnection"("companyId", "status", "unavailableUntil");
