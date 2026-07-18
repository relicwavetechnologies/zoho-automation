-- Turn explicit Teach evidence into an idempotent, reversible persona mutation.

ALTER TYPE "PersonaLearningCandidateStatus" ADD VALUE IF NOT EXISTS 'reverted';
ALTER TYPE "ManagerTeachSessionStatus" ADD VALUE IF NOT EXISTS 'persona_processing';
ALTER TYPE "ManagerTeachSessionStatus" ADD VALUE IF NOT EXISTS 'persona_updated';
ALTER TYPE "ManagerTeachSessionStatus" ADD VALUE IF NOT EXISTS 'no_learning';

CREATE TYPE "ManagerTeachPersonaMutationStatus" AS ENUM ('applied', 'no_learning');

CREATE TABLE "ManagerTeachPersonaMutation" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "treeId" TEXT,
  "baseRevision" INTEGER,
  "appliedRevision" INTEGER,
  "evidenceHash" TEXT NOT NULL,
  "modelProvider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "status" "ManagerTeachPersonaMutationStatus" NOT NULL,
  "understanding" TEXT NOT NULL,
  "patchJson" JSONB NOT NULL,
  "appliedChangeCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ManagerTeachPersonaMutation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManagerTeachPersonaMutation_sessionId_key"
  ON "ManagerTeachPersonaMutation"("sessionId");
CREATE INDEX "ManagerTeachPersonaMutation_treeId_createdAt_idx"
  ON "ManagerTeachPersonaMutation"("treeId", "createdAt");
CREATE INDEX "ManagerTeachPersonaMutation_status_createdAt_idx"
  ON "ManagerTeachPersonaMutation"("status", "createdAt");

ALTER TABLE "ManagerTeachPersonaMutation"
  ADD CONSTRAINT "ManagerTeachPersonaMutation_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "ManagerTeachSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerTeachPersonaMutation"
  ADD CONSTRAINT "ManagerTeachPersonaMutation_treeId_fkey"
  FOREIGN KEY ("treeId") REFERENCES "ManagerPersonaTree"("id") ON DELETE SET NULL ON UPDATE CASCADE;
