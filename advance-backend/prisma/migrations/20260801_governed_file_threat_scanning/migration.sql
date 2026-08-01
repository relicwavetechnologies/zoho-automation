-- Persist the exact security boundary that admitted governed file bytes.
-- Production requires a clean external malware-scan verdict before upload;
-- these fields make that decision auditable without retaining scanner output.
ALTER TYPE "KnowledgeFileAssetStatus" ADD VALUE IF NOT EXISTS 'deleting' BEFORE 'attached';

ALTER TABLE "KnowledgeFileAsset"
  ADD COLUMN IF NOT EXISTS "threatScanProvider" TEXT,
  ADD COLUMN IF NOT EXISTS "threatScanVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "threatScannedAt" TIMESTAMP(3);
