ALTER TABLE "FileAsset" ADD COLUMN IF NOT EXISTS "contentHash" TEXT;
CREATE INDEX IF NOT EXISTS "FileAsset_companyId_contentHash_idx" ON "FileAsset"("companyId", "contentHash");
