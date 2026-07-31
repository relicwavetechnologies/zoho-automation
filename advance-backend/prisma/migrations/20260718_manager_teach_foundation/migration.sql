-- Explicit manager Teach ingestion plus a bounded two-Undo persona history.
-- Teach remains isolated from memory, executable skills, RBAC and SaaS policy.

CREATE TYPE "ManagerTeachSource" AS ENUM ('recording', 'upload');
CREATE TYPE "ManagerTeachSessionStatus" AS ENUM (
  'awaiting_upload',
  'queued',
  'ingesting',
  'ready_for_processing',
  'failed',
  'cancelled'
);
CREATE TYPE "ManagerTeachArtifactKind" AS ENUM ('raw_video', 'evidence_manifest');
CREATE TYPE "ManagerTeachArtifactStatus" AS ENUM ('available', 'deleted');

CREATE TABLE "ManagerPersonaRevision" (
  "id" TEXT NOT NULL,
  "treeId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "snapshotJson" JSONB NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ManagerPersonaRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ManagerTeachSession" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "managerId" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "source" "ManagerTeachSource" NOT NULL,
  "status" "ManagerTeachSessionStatus" NOT NULL DEFAULT 'awaiting_upload',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "originalFileName" TEXT,
  "mimeType" TEXT,
  "fileSize" INTEGER,
  "queueJobId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "cancelRequestedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ManagerTeachSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ManagerTeachArtifact" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "kind" "ManagerTeachArtifactKind" NOT NULL,
  "status" "ManagerTeachArtifactStatus" NOT NULL DEFAULT 'available',
  "storageKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ManagerTeachArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManagerPersonaRevision_treeId_revision_key"
  ON "ManagerPersonaRevision"("treeId", "revision");
CREATE INDEX "ManagerPersonaRevision_treeId_createdAt_idx"
  ON "ManagerPersonaRevision"("treeId", "createdAt");
CREATE INDEX "ManagerTeachSession_companyId_departmentId_managerId_createdAt_idx"
  ON "ManagerTeachSession"("companyId", "departmentId", "managerId", "createdAt");
CREATE INDEX "ManagerTeachSession_status_createdAt_idx"
  ON "ManagerTeachSession"("status", "createdAt");
CREATE UNIQUE INDEX "ManagerTeachArtifact_sessionId_kind_key"
  ON "ManagerTeachArtifact"("sessionId", "kind");
CREATE INDEX "ManagerTeachArtifact_status_expiresAt_idx"
  ON "ManagerTeachArtifact"("status", "expiresAt");

ALTER TABLE "ManagerPersonaRevision"
  ADD CONSTRAINT "ManagerPersonaRevision_treeId_fkey"
  FOREIGN KEY ("treeId") REFERENCES "ManagerPersonaTree"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerTeachSession"
  ADD CONSTRAINT "ManagerTeachSession_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerTeachSession"
  ADD CONSTRAINT "ManagerTeachSession_managerId_fkey"
  FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerTeachSession"
  ADD CONSTRAINT "ManagerTeachSession_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerTeachArtifact"
  ADD CONSTRAINT "ManagerTeachArtifact_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "ManagerTeachSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
