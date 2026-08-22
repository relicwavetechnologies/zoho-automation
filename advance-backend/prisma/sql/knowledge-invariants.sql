-- Prisma db push cannot declare PostgreSQL CHECK constraints. This idempotent
-- release step restores the database-level invariants after the Prisma schema
-- has been synchronized. Existing invalid data deliberately fails deployment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'KnowledgeMutation_scope_policy'
      AND pg_get_constraintdef(oid) NOT LIKE '%kind%skill%'
  ) THEN
    ALTER TABLE "KnowledgeMutation" DROP CONSTRAINT "KnowledgeMutation_scope_policy";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'KnowledgePolicy_scope_policy'
      AND pg_get_constraintdef(oid) NOT LIKE '%kind%skill%'
  ) THEN
    ALTER TABLE "KnowledgePolicy" DROP CONSTRAINT "KnowledgePolicy_scope_policy";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeResource_target_shape') THEN
    ALTER TABLE "KnowledgeResource" ADD CONSTRAINT "KnowledgeResource_target_shape" CHECK (
      ("scope" = 'personal' AND "ownerUserId" IS NOT NULL AND "departmentId" IS NULL AND "targetKey" = 'personal:' || "ownerUserId") OR
      ("scope" = 'department' AND "ownerUserId" IS NULL AND "departmentId" IS NOT NULL AND "targetKey" = 'department:' || "departmentId") OR
      ("scope" = 'company' AND "ownerUserId" IS NULL AND "departmentId" IS NULL AND "targetKey" = 'company')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeVersion_positive_version') THEN
    ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_positive_version" CHECK ("version" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeMutation_target_shape') THEN
    ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_target_shape" CHECK (
      ("scope" = 'personal' AND "ownerUserId" IS NOT NULL AND "departmentId" IS NULL AND "targetKey" = 'personal:' || "ownerUserId") OR
      ("scope" = 'department' AND "ownerUserId" IS NULL AND "departmentId" IS NOT NULL AND "targetKey" = 'department:' || "departmentId") OR
      ("scope" = 'company' AND "ownerUserId" IS NULL AND "departmentId" IS NULL AND "targetKey" = 'company')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeMutation_content_shape') THEN
    ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_content_shape" CHECK (
      ("action" = 'delete' AND "proposedContentJson" IS NULL AND "proposedContentHash" IS NULL) OR
      ("action" <> 'delete' AND "proposedContentJson" IS NOT NULL AND "proposedContentHash" IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeMutation_scope_policy') THEN
    ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_scope_policy" CHECK (
      ("scope" = 'personal' AND "requiredAuthority" = 'none') OR
      ("scope" = 'department' AND "requiredAuthority" = 'department_manager' AND "requesterReviewRequired" AND ("distinctApprover" OR "kind" = 'skill')) OR
      ("scope" = 'company' AND "requiredAuthority" = 'company_admin' AND "requesterReviewRequired" AND "distinctApprover")
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeMutation_personal_owner_review') THEN
    ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_personal_owner_review" CHECK (
      "scope" <> 'personal' OR "kind" = 'memory' OR "requesterReviewRequired"
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeMutation_base_version') THEN
    ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_base_version" CHECK (
      ("action" = 'create' AND "baseVersion" IS NULL) OR
      ("action" = 'publish' AND ("baseVersion" IS NULL OR "baseVersion" > 0)) OR
      ("action" IN ('update', 'delete') AND "baseVersion" IS NOT NULL AND "baseVersion" > 0)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgePolicy_scope_policy') THEN
    ALTER TABLE "KnowledgePolicy" ADD CONSTRAINT "KnowledgePolicy_scope_policy" CHECK (
      ("scope" = 'personal' AND "requiredAuthority" = 'none') OR
      ("scope" = 'department' AND "requiredAuthority" = 'department_manager' AND "requesterReviewRequired" AND ("distinctApprover" OR "kind" = 'skill')) OR
      ("scope" = 'company' AND "requiredAuthority" = 'company_admin' AND "requesterReviewRequired" AND "distinctApprover")
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgePolicy_personal_owner_review') THEN
    ALTER TABLE "KnowledgePolicy" ADD CONSTRAINT "KnowledgePolicy_personal_owner_review" CHECK (
      "scope" <> 'personal' OR "kind" = 'memory' OR "requesterReviewRequired"
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeOutbox_nonnegative_attempts') THEN
    ALTER TABLE "KnowledgeOutbox" ADD CONSTRAINT "KnowledgeOutbox_nonnegative_attempts" CHECK ("attempts" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeFileAsset_size') THEN
    ALTER TABLE "KnowledgeFileAsset" ADD CONSTRAINT "KnowledgeFileAsset_size" CHECK ("sizeBytes" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeFileAsset_sha256') THEN
    ALTER TABLE "KnowledgeFileAsset" ADD CONSTRAINT "KnowledgeFileAsset_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeFileAsset_delivery') THEN
    ALTER TABLE "KnowledgeFileAsset" ADD CONSTRAINT "KnowledgeFileAsset_delivery" CHECK ("deliveryType" IN ('private', 'authenticated'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeFileDocument_positive_version') THEN
    ALTER TABLE "KnowledgeFileDocument" ADD CONSTRAINT "KnowledgeFileDocument_positive_version" CHECK ("resourceVersion" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeFileDocument_nonnegative_counts') THEN
    ALTER TABLE "KnowledgeFileDocument" ADD CONSTRAINT "KnowledgeFileDocument_nonnegative_counts" CHECK (
      "chunkCount" >= 0 AND "attempts" >= 0 AND ("pageCount" IS NULL OR "pageCount" >= 0)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeFileDocument_sha256') THEN
    ALTER TABLE "KnowledgeFileDocument" ADD CONSTRAINT "KnowledgeFileDocument_sha256" CHECK ("sourceSha256" ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeFileChunk_nonnegative_ordinal') THEN
    ALTER TABLE "KnowledgeFileChunk" ADD CONSTRAINT "KnowledgeFileChunk_nonnegative_ordinal" CHECK ("ordinal" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeFileChunk_positive_sizes') THEN
    ALTER TABLE "KnowledgeFileChunk" ADD CONSTRAINT "KnowledgeFileChunk_positive_sizes" CHECK (
      "charCount" > 0 AND "tokenEstimate" > 0 AND length("text") = "charCount"
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeFileChunk_page_range') THEN
    ALTER TABLE "KnowledgeFileChunk" ADD CONSTRAINT "KnowledgeFileChunk_page_range" CHECK (
      ("pageStart" IS NULL AND "pageEnd" IS NULL) OR ("pageStart" > 0 AND "pageEnd" >= "pageStart")
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeFileChunk_text_hash') THEN
    ALTER TABLE "KnowledgeFileChunk" ADD CONSTRAINT "KnowledgeFileChunk_text_hash" CHECK ("textHash" ~ '^[0-9a-f]{64}$');
  END IF;
END $$;
