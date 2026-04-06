CREATE TABLE IF NOT EXISTS "CompanyPromptProfile" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "companyContext" TEXT NOT NULL DEFAULT '',
  "systemsOfRecord" TEXT NOT NULL DEFAULT '',
  "businessRules" TEXT NOT NULL DEFAULT '',
  "communicationStyle" TEXT NOT NULL DEFAULT '',
  "formattingDefaults" TEXT NOT NULL DEFAULT '',
  "restrictedClaims" TEXT NOT NULL DEFAULT '',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompanyPromptProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CompanyPromptProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CompanyPromptProfile_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CompanyPromptProfile_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "CompanyPromptProfile_companyId_key" ON "CompanyPromptProfile"("companyId");
CREATE INDEX IF NOT EXISTS "CompanyPromptProfile_companyId_isActive_idx" ON "CompanyPromptProfile"("companyId", "isActive");
