-- Central knowledge authority. Postgres owns durable truth; Hindsight and the
-- skill registry are projections, never independent writers.
CREATE TYPE "KnowledgeResourceKind" AS ENUM ('memory', 'skill', 'file');
CREATE TYPE "KnowledgeResourceScope" AS ENUM ('personal', 'department', 'company');
CREATE TYPE "KnowledgeResourceStatus" AS ENUM ('draft', 'active', 'archived', 'deleted');
CREATE TYPE "KnowledgeMutationAction" AS ENUM ('create', 'update', 'publish', 'delete');
CREATE TYPE "KnowledgeMutationStatus" AS ENUM (
  'awaiting_requester_review',
  'awaiting_approval',
  'approved',
  'applying',
  'applied',
  'rejected',
  'cancelled',
  'failed',
  'superseded'
);
CREATE TYPE "KnowledgeApprovalAuthority" AS ENUM ('none', 'department_manager', 'company_admin');
CREATE TYPE "KnowledgeOutboxStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE "KnowledgeResource" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "kind" "KnowledgeResourceKind" NOT NULL,
  "scope" "KnowledgeResourceScope" NOT NULL,
  "targetKey" TEXT NOT NULL,
  "ownerUserId" TEXT,
  "departmentId" TEXT,
  "logicalKey" TEXT NOT NULL,
  "status" "KnowledgeResourceStatus" NOT NULL DEFAULT 'draft',
  "currentVersion" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeResource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeResource_target_shape" CHECK (
    ("scope" = 'personal' AND "ownerUserId" IS NOT NULL AND "departmentId" IS NULL AND "targetKey" = 'personal:' || "ownerUserId") OR
    ("scope" = 'department' AND "ownerUserId" IS NULL AND "departmentId" IS NOT NULL AND "targetKey" = 'department:' || "departmentId") OR
    ("scope" = 'company' AND "ownerUserId" IS NULL AND "departmentId" IS NULL AND "targetKey" = 'company')
  )
);

CREATE TABLE "KnowledgeVersion" (
  "id" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "contentJson" JSONB NOT NULL,
  "contentHash" TEXT NOT NULL,
  "evidenceJson" JSONB,
  "sourceType" TEXT NOT NULL,
  "sourceRef" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeVersion_positive_version" CHECK ("version" > 0)
);

CREATE TABLE "KnowledgeMutation" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "resourceId" TEXT,
  "kind" "KnowledgeResourceKind" NOT NULL,
  "scope" "KnowledgeResourceScope" NOT NULL,
  "targetKey" TEXT NOT NULL,
  "ownerUserId" TEXT,
  "departmentId" TEXT,
  "logicalKey" TEXT NOT NULL,
  "action" "KnowledgeMutationAction" NOT NULL,
  "baseVersion" INTEGER,
  "proposedContentJson" JSONB,
  "proposedContentHash" TEXT,
  "evidenceJson" JSONB,
  "sourceType" TEXT NOT NULL,
  "sourceRef" TEXT,
  "requesterId" TEXT NOT NULL,
  "requesterReviewRequired" BOOLEAN NOT NULL,
  "requesterReviewedAt" TIMESTAMP(3),
  "requiredAuthority" "KnowledgeApprovalAuthority" NOT NULL,
  "distinctApprover" BOOLEAN NOT NULL DEFAULT true,
  "policyId" TEXT NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "runtimeApprovalId" TEXT,
  "appliedVersionId" TEXT,
  "status" "KnowledgeMutationStatus" NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "rejectionReason" TEXT,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  CONSTRAINT "KnowledgeMutation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeMutation_target_shape" CHECK (
    ("scope" = 'personal' AND "ownerUserId" IS NOT NULL AND "departmentId" IS NULL AND "targetKey" = 'personal:' || "ownerUserId") OR
    ("scope" = 'department' AND "ownerUserId" IS NULL AND "departmentId" IS NOT NULL AND "targetKey" = 'department:' || "departmentId") OR
    ("scope" = 'company' AND "ownerUserId" IS NULL AND "departmentId" IS NULL AND "targetKey" = 'company')
  ),
  CONSTRAINT "KnowledgeMutation_content_shape" CHECK (
    ("action" = 'delete' AND "proposedContentJson" IS NULL AND "proposedContentHash" IS NULL) OR
    ("action" <> 'delete' AND "proposedContentJson" IS NOT NULL AND "proposedContentHash" IS NOT NULL)
  ),
  CONSTRAINT "KnowledgeMutation_scope_policy" CHECK (
    ("scope" = 'personal' AND "requiredAuthority" = 'none') OR
    ("scope" = 'department' AND "requiredAuthority" = 'department_manager' AND "requesterReviewRequired" AND "distinctApprover") OR
    ("scope" = 'company' AND "requiredAuthority" = 'company_admin' AND "requesterReviewRequired" AND "distinctApprover")
  ),
  CONSTRAINT "KnowledgeMutation_personal_owner_review" CHECK (
    "scope" <> 'personal' OR "kind" = 'memory' OR "requesterReviewRequired"
  ),
  CONSTRAINT "KnowledgeMutation_base_version" CHECK (
    ("action" = 'create' AND "baseVersion" IS NULL) OR
    ("action" = 'publish' AND ("baseVersion" IS NULL OR "baseVersion" > 0)) OR
    ("action" IN ('update', 'delete') AND "baseVersion" IS NOT NULL AND "baseVersion" > 0)
  )
);

CREATE TABLE "KnowledgePolicy" (
  "id" TEXT NOT NULL,
  "tenantKey" TEXT NOT NULL DEFAULT 'global',
  "kind" "KnowledgeResourceKind" NOT NULL,
  "scope" "KnowledgeResourceScope" NOT NULL,
  "action" "KnowledgeMutationAction" NOT NULL,
  "requesterReviewRequired" BOOLEAN NOT NULL,
  "requiredAuthority" "KnowledgeApprovalAuthority" NOT NULL,
  "distinctApprover" BOOLEAN NOT NULL DEFAULT true,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgePolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgePolicy_scope_policy" CHECK (
    ("scope" = 'personal' AND "requiredAuthority" = 'none') OR
    ("scope" = 'department' AND "requiredAuthority" = 'department_manager' AND "requesterReviewRequired" AND "distinctApprover") OR
    ("scope" = 'company' AND "requiredAuthority" = 'company_admin' AND "requesterReviewRequired" AND "distinctApprover")
  ),
  CONSTRAINT "KnowledgePolicy_personal_owner_review" CHECK (
    "scope" <> 'personal' OR "kind" = 'memory' OR "requesterReviewRequired"
  )
);

CREATE TABLE "KnowledgeOutbox" (
  "id" TEXT NOT NULL,
  "mutationId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payloadJson" JSONB NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "status" "KnowledgeOutboxStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeOutbox_nonnegative_attempts" CHECK ("attempts" >= 0)
);

ALTER TABLE "Skill" ADD COLUMN "knowledgeResourceId" TEXT;
CREATE UNIQUE INDEX "Skill_knowledgeResourceId_key" ON "Skill"("knowledgeResourceId");
ALTER TABLE "Skill"
  ADD CONSTRAINT "Skill_knowledgeResourceId_fkey" FOREIGN KEY ("knowledgeResourceId") REFERENCES "KnowledgeResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- `global` was the legacy name for company-wide skill visibility. The public
-- and persisted vocabulary is canonical after this migration.
UPDATE "Skill" SET "scope" = 'company' WHERE "scope" = 'global';
UPDATE "SkillVersion" SET "scope" = 'company' WHERE "scope" = 'global';

INSERT INTO "RegisteredTool" (
  "id", "toolId", "name", "description", "category", "domain",
  "hitlRequired", "guardrails", "deprecated", "engines", "createdAt", "updatedAt"
)
VALUES (
  'central-knowledge-authority',
  'knowledge',
  'Divo Knowledge',
  'Recall and mutate governed memory, skills, and file knowledge through one backend authority.',
  'knowledge',
  'memory',
  TRUE,
  ARRAY[
    'Personal targets are derived from the authenticated member',
    'Shared changes require exact requester review and a different manager or administrator',
    'All writes are versioned, idempotent, audited, and projected through an outbox',
    'Denied targets are never downgraded or redirected'
  ]::TEXT[],
  FALSE,
  ARRAY[]::TEXT[],
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("toolId") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "domain" = EXCLUDED."domain",
  "hitlRequired" = EXCLUDED."hitlRequired",
  "guardrails" = EXCLUDED."guardrails",
  "deprecated" = FALSE,
  "updatedAt" = CURRENT_TIMESTAMP;

-- Old publishing/recall contracts cannot safely be translated operation by
-- operation. Preserve only the maintained knowledge-management system skill and
-- archive every other active recipe that depended on a retired contract.
UPDATE "Skill"
SET "status" = 'archived', "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" <> 'archived'
  AND "toolIds" && ARRAY['memoryPublishing', 'memoryRecall', 'skillPublishing']::TEXT[]
  AND NOT ("isSystem" = TRUE AND "slug" = 'share-memory');

UPDATE "Skill"
SET
  "scope" = 'company',
  "name" = 'Manage Knowledge',
  "toolIds" = ARRAY['knowledge']::TEXT[],
  "summary" = 'Safely manage personal, department, and company memory, procedures, and governed files through exact review, RBAC, and approval.',
  "tags" = ARRAY['knowledge', 'memory', 'procedures', 'files', 'review']::TEXT[],
  "markdown" = $share_memory$
# Manage Knowledge

Use this skill when the member naturally asks Divo to remember, forget, update, teach, save, share, or remove durable knowledge. Classify meaning semantically; never route by keyword or regex.

1. Personal preferences/corrections are evaluated asynchronously after a successful private turn without confirmation. Never call a mutation tool, expose the background learner, promise persistence, or claim in the same reply that they were saved; acknowledge and apply the preference naturally.
2. Department/company facts use the dedicated memory review surface with 1-10 exact facts and backend-derived targets.
3. Detailed reusable methods are procedures, not memory facts. Personal/shared procedures and governed files use the exact knowledge review surface with the complete corrected version.
4. Personal procedures/files require owner review. Department changes then require a different active department manager; company changes require a different active company administrator.
5. Never call knowledge mutations directly, change scope after denial, offer an unreviewed fallback, or claim success before the verified backend result.
6. Before an update/delete, read the canonical resource logical key, current version, and complete content through the knowledge resource catalogue. Never guess from chat history or a projected skill revision.
7. Retained files are downloaded only through the governed file-download operation, which checks the current approved version and returns a short-lived link.
$share_memory$,
  "revision" = "revision" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "isSystem" = TRUE AND "slug" = 'share-memory';

DELETE FROM "SkillCapability"
WHERE "toolId" IN ('memoryPublishing', 'memoryRecall', 'skillPublishing');
DELETE FROM "DepartmentUserToolOverride"
WHERE "toolId" IN ('memoryPublishing', 'memoryRecall', 'skillPublishing');
DELETE FROM "DepartmentToolPermission"
WHERE "toolId" IN ('memoryPublishing', 'memoryRecall', 'skillPublishing');
DELETE FROM "ToolActionPermission"
WHERE "toolId" IN ('memoryPublishing', 'memoryRecall', 'skillPublishing');
DELETE FROM "ToolPermission"
WHERE "toolId" IN ('memoryPublishing', 'memoryRecall', 'skillPublishing');
DELETE FROM "RegisteredTool"
WHERE "toolId" IN ('memoryPublishing', 'memoryRecall', 'skillPublishing');

-- Experimental typed-memory tables were never an authority and had no live
-- readers. Remove them conditionally so environments created before or after
-- that experiment converge on the same schema.
DROP TABLE IF EXISTS "UserMemoryProfile";
DROP TABLE IF EXISTS "UserMemoryItem";
DROP TYPE IF EXISTS "UserMemoryFormatting";
DROP TYPE IF EXISTS "UserMemoryTone";
DROP TYPE IF EXISTS "UserMemoryReplyLength";
DROP TYPE IF EXISTS "UserMemoryChannelOrigin";
DROP TYPE IF EXISTS "UserMemorySource";
DROP TYPE IF EXISTS "UserMemoryStatus";
DROP TYPE IF EXISTS "UserMemoryScope";
DROP TYPE IF EXISTS "UserMemoryKind";

CREATE UNIQUE INDEX "KnowledgeResource_companyId_kind_targetKey_logicalKey_key"
  ON "KnowledgeResource"("companyId", "kind", "targetKey", "logicalKey");
CREATE INDEX "KnowledgeResource_companyId_scope_status_updatedAt_idx"
  ON "KnowledgeResource"("companyId", "scope", "status", "updatedAt");
CREATE INDEX "KnowledgeResource_ownerUserId_kind_status_updatedAt_idx"
  ON "KnowledgeResource"("ownerUserId", "kind", "status", "updatedAt");
CREATE INDEX "KnowledgeResource_departmentId_kind_status_updatedAt_idx"
  ON "KnowledgeResource"("departmentId", "kind", "status", "updatedAt");

CREATE UNIQUE INDEX "KnowledgeVersion_resourceId_version_key"
  ON "KnowledgeVersion"("resourceId", "version");
CREATE UNIQUE INDEX "KnowledgeVersion_resourceId_contentHash_key"
  ON "KnowledgeVersion"("resourceId", "contentHash");
CREATE INDEX "KnowledgeVersion_contentHash_idx" ON "KnowledgeVersion"("contentHash");

CREATE UNIQUE INDEX "KnowledgeMutation_runtimeApprovalId_key" ON "KnowledgeMutation"("runtimeApprovalId");
CREATE UNIQUE INDEX "KnowledgeMutation_idempotencyKey_key" ON "KnowledgeMutation"("idempotencyKey");
CREATE INDEX "KnowledgeMutation_companyId_requesterId_status_createdAt_idx"
  ON "KnowledgeMutation"("companyId", "requesterId", "status", "createdAt");
CREATE INDEX "KnowledgeMutation_companyId_departmentId_status_createdAt_idx"
  ON "KnowledgeMutation"("companyId", "departmentId", "status", "createdAt");
CREATE INDEX "KnowledgeMutation_resourceId_createdAt_idx" ON "KnowledgeMutation"("resourceId", "createdAt");
CREATE INDEX "KnowledgeMutation_runtimeApprovalId_idx" ON "KnowledgeMutation"("runtimeApprovalId");

CREATE UNIQUE INDEX "KnowledgePolicy_tenantKey_kind_scope_action_key"
  ON "KnowledgePolicy"("tenantKey", "kind", "scope", "action");
CREATE INDEX "KnowledgePolicy_tenantKey_enabled_idx" ON "KnowledgePolicy"("tenantKey", "enabled");

CREATE UNIQUE INDEX "KnowledgeOutbox_dedupeKey_key" ON "KnowledgeOutbox"("dedupeKey");
CREATE INDEX "KnowledgeOutbox_status_availableAt_idx" ON "KnowledgeOutbox"("status", "availableAt");
CREATE INDEX "KnowledgeOutbox_mutationId_idx" ON "KnowledgeOutbox"("mutationId");

ALTER TABLE "KnowledgeResource"
  ADD CONSTRAINT "KnowledgeResource_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeResource_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeResource_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeResource_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "KnowledgeVersion"
  ADD CONSTRAINT "KnowledgeVersion_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "KnowledgeResource"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "KnowledgeMutation"
  ADD CONSTRAINT "KnowledgeMutation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeMutation_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "KnowledgeResource"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeMutation_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeMutation_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeMutation_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeMutation_runtimeApprovalId_fkey" FOREIGN KEY ("runtimeApprovalId") REFERENCES "RuntimeApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeMutation_appliedVersionId_fkey" FOREIGN KEY ("appliedVersionId") REFERENCES "KnowledgeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "KnowledgeOutbox"
  ADD CONSTRAINT "KnowledgeOutbox_mutationId_fkey" FOREIGN KEY ("mutationId") REFERENCES "KnowledgeMutation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every governed combination is present from day one. Company-specific rows
-- may override an exact tuple without changing application code.
WITH kinds(kind) AS (
  VALUES ('memory'::"KnowledgeResourceKind"), ('skill'::"KnowledgeResourceKind"), ('file'::"KnowledgeResourceKind")
), scopes(scope) AS (
  VALUES ('personal'::"KnowledgeResourceScope"), ('department'::"KnowledgeResourceScope"), ('company'::"KnowledgeResourceScope")
), actions(action) AS (
  VALUES ('create'::"KnowledgeMutationAction"), ('update'::"KnowledgeMutationAction"), ('publish'::"KnowledgeMutationAction"), ('delete'::"KnowledgeMutationAction")
)
INSERT INTO "KnowledgePolicy" (
  "id", "tenantKey", "kind", "scope", "action",
  "requesterReviewRequired", "requiredAuthority", "distinctApprover",
  "enabled", "version", "createdAt", "updatedAt"
)
SELECT
  'kp-global-' || kind::text || '-' || scope::text || '-' || action::text,
  'global', kind, scope, action,
  (scope <> 'personal' OR kind <> 'memory'),
  CASE scope
    WHEN 'department' THEN 'department_manager'::"KnowledgeApprovalAuthority"
    WHEN 'company' THEN 'company_admin'::"KnowledgeApprovalAuthority"
    ELSE 'none'::"KnowledgeApprovalAuthority"
  END,
  scope <> 'personal',
  true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM kinds CROSS JOIN scopes CROSS JOIN actions;
