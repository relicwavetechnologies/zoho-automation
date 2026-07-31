-- P1–P3 manager-persona learning foundation.
-- Evidence and shadow candidates are isolated from active user/department
-- memory. This migration intentionally does not modify runtime prompt tables.

CREATE TYPE "PersonaLearningEvidenceStatus" AS ENUM ('eligible', 'skipped');
CREATE TYPE "PersonaLearningJobStatus" AS ENUM ('queued', 'processing', 'shadow_complete', 'no_learning', 'failed');
CREATE TYPE "PersonaLearningCandidateKind" AS ENUM ('preference', 'correction', 'workflow', 'skill', 'contradiction');
CREATE TYPE "PersonaLearningEvidenceStrength" AS ENUM ('explicit', 'confirmed', 'inferred');
CREATE TYPE "PersonaLearningCandidateStatus" AS ENUM ('shadow');

CREATE TABLE "PersonaLearningEvidence" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "managerId" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "executionRunId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "sourceVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "PersonaLearningEvidenceStatus" NOT NULL,
  "eligibilityReason" TEXT,
  "contextJson" JSONB NOT NULL,
  "toolSummaryJson" JSONB NOT NULL,
  "runSummary" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PersonaLearningEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PersonaLearningJob" (
  "id" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "pipelineVersion" INTEGER NOT NULL DEFAULT 1,
  "idempotencyKey" TEXT NOT NULL,
  "status" "PersonaLearningJobStatus" NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "queueJobId" TEXT,
  "modelProvider" TEXT,
  "modelId" TEXT,
  "lastError" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PersonaLearningJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PersonaLearningCandidate" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "managerId" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "kind" "PersonaLearningCandidateKind" NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "claim" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "evidenceStrength" "PersonaLearningEvidenceStrength" NOT NULL,
  "status" "PersonaLearningCandidateStatus" NOT NULL DEFAULT 'shadow',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PersonaLearningCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PersonaLearningEvidence_executionRunId_key" ON "PersonaLearningEvidence"("executionRunId");
CREATE INDEX "PersonaLearningEvidence_companyId_departmentId_managerId_capturedAt_idx" ON "PersonaLearningEvidence"("companyId", "departmentId", "managerId", "capturedAt");
CREATE INDEX "PersonaLearningEvidence_status_capturedAt_idx" ON "PersonaLearningEvidence"("status", "capturedAt");

CREATE UNIQUE INDEX "PersonaLearningJob_idempotencyKey_key" ON "PersonaLearningJob"("idempotencyKey");
CREATE UNIQUE INDEX "PersonaLearningJob_evidenceId_pipelineVersion_key" ON "PersonaLearningJob"("evidenceId", "pipelineVersion");
CREATE INDEX "PersonaLearningJob_status_createdAt_idx" ON "PersonaLearningJob"("status", "createdAt");

CREATE UNIQUE INDEX "PersonaLearningCandidate_jobId_ordinal_key" ON "PersonaLearningCandidate"("jobId", "ordinal");
CREATE INDEX "PersonaLearningCandidate_companyId_departmentId_managerId_status_createdAt_idx" ON "PersonaLearningCandidate"("companyId", "departmentId", "managerId", "status", "createdAt");
CREATE INDEX "PersonaLearningCandidate_evidenceId_idx" ON "PersonaLearningCandidate"("evidenceId");

ALTER TABLE "PersonaLearningEvidence"
  ADD CONSTRAINT "PersonaLearningEvidence_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonaLearningEvidence"
  ADD CONSTRAINT "PersonaLearningEvidence_managerId_fkey"
  FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonaLearningEvidence"
  ADD CONSTRAINT "PersonaLearningEvidence_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonaLearningEvidence"
  ADD CONSTRAINT "PersonaLearningEvidence_executionRunId_fkey"
  FOREIGN KEY ("executionRunId") REFERENCES "ExecutionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PersonaLearningJob"
  ADD CONSTRAINT "PersonaLearningJob_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "PersonaLearningEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PersonaLearningCandidate"
  ADD CONSTRAINT "PersonaLearningCandidate_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonaLearningCandidate"
  ADD CONSTRAINT "PersonaLearningCandidate_managerId_fkey"
  FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonaLearningCandidate"
  ADD CONSTRAINT "PersonaLearningCandidate_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonaLearningCandidate"
  ADD CONSTRAINT "PersonaLearningCandidate_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "PersonaLearningEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonaLearningCandidate"
  ADD CONSTRAINT "PersonaLearningCandidate_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "PersonaLearningJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
