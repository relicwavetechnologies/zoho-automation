ALTER TYPE "ManagerTeachSessionStatus" ADD VALUE IF NOT EXISTS 'evidence_ready';
ALTER TYPE "ManagerTeachSessionStatus" ADD VALUE IF NOT EXISTS 'agent_processing';
ALTER TYPE "ManagerTeachSessionStatus" ADD VALUE IF NOT EXISTS 'completed';

ALTER TABLE "ManagerTeachSession" ADD COLUMN "agentMutationKey" TEXT;
CREATE UNIQUE INDEX "ManagerTeachSession_agentMutationKey_key"
  ON "ManagerTeachSession"("agentMutationKey");
