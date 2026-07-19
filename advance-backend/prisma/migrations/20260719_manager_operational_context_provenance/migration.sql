CREATE TYPE "ManagerLearningDecision" AS ENUM ('create', 'merge', 'replace', 'retire');

CREATE TABLE "ManagerLearningProvenance" (
    "id" TEXT NOT NULL,
    "teachSessionId" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "personaNodeId" TEXT,
    "skillId" TEXT,
    "decision" "ManagerLearningDecision" NOT NULL,
    "evidenceRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rationale" TEXT NOT NULL,
    "priorStateJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagerLearningProvenance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ManagerLearningProvenance_single_target_check"
      CHECK (NOT ("personaNodeId" IS NOT NULL AND "skillId" IS NOT NULL))
);

CREATE INDEX "ManagerLearningProvenance_teachSessionId_createdAt_idx"
    ON "ManagerLearningProvenance"("teachSessionId", "createdAt");
CREATE INDEX "ManagerLearningProvenance_mutationId_idx"
    ON "ManagerLearningProvenance"("mutationId");
CREATE INDEX "ManagerLearningProvenance_personaNodeId_createdAt_idx"
    ON "ManagerLearningProvenance"("personaNodeId", "createdAt");
CREATE INDEX "ManagerLearningProvenance_skillId_createdAt_idx"
    ON "ManagerLearningProvenance"("skillId", "createdAt");

ALTER TABLE "ManagerLearningProvenance"
    ADD CONSTRAINT "ManagerLearningProvenance_teachSessionId_fkey"
    FOREIGN KEY ("teachSessionId") REFERENCES "ManagerTeachSession"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ManagerLearningProvenance"
    ADD CONSTRAINT "ManagerLearningProvenance_mutationId_fkey"
    FOREIGN KEY ("mutationId") REFERENCES "ManagerTeachPersonaMutation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ManagerLearningProvenance"
    ADD CONSTRAINT "ManagerLearningProvenance_personaNodeId_fkey"
    FOREIGN KEY ("personaNodeId") REFERENCES "ManagerPersonaNode"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ManagerLearningProvenance"
    ADD CONSTRAINT "ManagerLearningProvenance_skillId_fkey"
    FOREIGN KEY ("skillId") REFERENCES "Skill"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
