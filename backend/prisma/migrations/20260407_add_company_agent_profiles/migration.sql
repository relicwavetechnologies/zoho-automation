-- CreateTable
CREATE TABLE "CompanyAgentProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "toolIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "routingHints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyAgentProfile_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "DepartmentAgentConfig"
ADD COLUMN "defaultAgentProfileId" TEXT,
ADD COLUMN "specialistAgentProfileIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE UNIQUE INDEX "CompanyAgentProfile_companyId_slug_key" ON "CompanyAgentProfile"("companyId", "slug");

-- CreateIndex
CREATE INDEX "CompanyAgentProfile_companyId_isActive_updatedAt_idx" ON "CompanyAgentProfile"("companyId", "isActive", "updatedAt");

-- AddForeignKey
ALTER TABLE "CompanyAgentProfile" ADD CONSTRAINT "CompanyAgentProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyAgentProfile" ADD CONSTRAINT "CompanyAgentProfile_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyAgentProfile" ADD CONSTRAINT "CompanyAgentProfile_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
