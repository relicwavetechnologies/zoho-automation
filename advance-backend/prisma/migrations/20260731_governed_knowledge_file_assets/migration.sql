-- Private file staging for the central knowledge authority. Provider object
-- keys are server-owned and can never be supplied as authorization by Pi.
CREATE TYPE "KnowledgeFileAssetStatus" AS ENUM ('staged', 'attached', 'deleted');

CREATE TABLE "KnowledgeFileAsset" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "knowledgeResourceId" TEXT,
  "provider" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "deliveryType" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "inspectionVersion" TEXT NOT NULL DEFAULT 'strict-v1',
  "inspectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" "KnowledgeFileAssetStatus" NOT NULL DEFAULT 'staged',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attachedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeFileAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeFileAsset_size" CHECK ("sizeBytes" >= 0),
  CONSTRAINT "KnowledgeFileAsset_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "KnowledgeFileAsset_delivery" CHECK ("deliveryType" IN ('private', 'authenticated'))
);

CREATE UNIQUE INDEX "KnowledgeFileAsset_storageKey_key"
  ON "KnowledgeFileAsset"("storageKey");
CREATE INDEX "KnowledgeFileAsset_companyId_uploadedById_status_createdAt_idx"
  ON "KnowledgeFileAsset"("companyId", "uploadedById", "status", "createdAt");
CREATE INDEX "KnowledgeFileAsset_knowledgeResourceId_status_idx"
  ON "KnowledgeFileAsset"("knowledgeResourceId", "status");
CREATE INDEX "KnowledgeFileAsset_status_expiresAt_idx"
  ON "KnowledgeFileAsset"("status", "expiresAt");
CREATE INDEX "KnowledgeFileAsset_companyId_sha256_idx"
  ON "KnowledgeFileAsset"("companyId", "sha256");

ALTER TABLE "KnowledgeFileAsset"
  ADD CONSTRAINT "KnowledgeFileAsset_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeFileAsset_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeFileAsset_knowledgeResourceId_fkey"
  FOREIGN KEY ("knowledgeResourceId") REFERENCES "KnowledgeResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KnowledgeMutation" ADD COLUMN "fileAssetId" TEXT;
CREATE INDEX "KnowledgeMutation_fileAssetId_status_idx"
  ON "KnowledgeMutation"("fileAssetId", "status");
ALTER TABLE "KnowledgeMutation"
  ADD CONSTRAINT "KnowledgeMutation_fileAssetId_fkey"
  FOREIGN KEY ("fileAssetId") REFERENCES "KnowledgeFileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
