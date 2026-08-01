CREATE TYPE "KnowledgeLearningJobStatus" AS ENUM (
  'queued',
  'processing',
  'completed',
  'no_learning',
  'failed'
);

CREATE TABLE "KnowledgeLearningJob" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "companyRole" TEXT NOT NULL,
  "userMessages" JSONB NOT NULL,
  "assistantText" TEXT,
  "pipelineVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "KnowledgeLearningJobStatus" NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "modelProvider" TEXT,
  "modelId" TEXT,
  "outcomesJson" JSONB,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeLearningJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeLearningJob_identity_pipeline_key"
  ON "KnowledgeLearningJob"("companyId", "userId", "sourceId", "pipelineVersion");
CREATE INDEX "KnowledgeLearningJob_status_lockedAt_createdAt_idx"
  ON "KnowledgeLearningJob"("status", "lockedAt", "createdAt");
CREATE INDEX "KnowledgeLearningJob_companyId_userId_createdAt_idx"
  ON "KnowledgeLearningJob"("companyId", "userId", "createdAt");

ALTER TABLE "KnowledgeLearningJob"
  ADD CONSTRAINT "KnowledgeLearningJob_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeLearningJob"
  ADD CONSTRAINT "KnowledgeLearningJob_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
