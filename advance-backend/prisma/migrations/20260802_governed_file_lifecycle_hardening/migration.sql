-- Governed-file lifecycle hardening.
-- Lease tokens fence stale object/index workers after a lease is reclaimed.
ALTER TABLE "KnowledgeFileAsset"
  ADD COLUMN IF NOT EXISTS "deletionLeaseToken" TEXT;

ALTER TABLE "KnowledgeFileDocument"
  ADD COLUMN IF NOT EXISTS "lockToken" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeFileDocument_id_companyId_key"
  ON "KnowledgeFileDocument"("id", "companyId");

CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeFileDocument_tenant_binding_key"
  ON "KnowledgeFileDocument"("id", "companyId", "resourceId", "resourceVersion");

-- Existing rows are not rewritten or deleted. NOT VALID preserves a recoverable
-- rollout while enforcing the relationship for every new or changed row; a
-- later maintenance window can validate after any legacy violations are audited.
ALTER TABLE "KnowledgeFileChunk"
  DROP CONSTRAINT IF EXISTS "KnowledgeFileChunk_documentId_fkey";

ALTER TABLE "KnowledgeFileChunk"
  ADD CONSTRAINT "KnowledgeFileChunk_document_tenant_version_fkey"
  FOREIGN KEY ("documentId", "companyId", "resourceId", "resourceVersion")
  REFERENCES "KnowledgeFileDocument"("id", "companyId", "resourceId", "resourceVersion")
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "KnowledgeFileChunk"
  ADD CONSTRAINT "KnowledgeFileChunk_resource_tenant_fkey"
  FOREIGN KEY ("resourceId", "companyId")
  REFERENCES "KnowledgeResource"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;
