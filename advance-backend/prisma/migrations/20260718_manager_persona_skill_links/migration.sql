-- Link manager persona routing rules to reusable skill recipes.
CREATE TABLE "ManagerPersonaSkillLink" (
    "personaNodeId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagerPersonaSkillLink_pkey" PRIMARY KEY ("personaNodeId", "skillId")
);

CREATE INDEX "ManagerPersonaSkillLink_skillId_idx"
    ON "ManagerPersonaSkillLink"("skillId");

ALTER TABLE "ManagerPersonaSkillLink"
    ADD CONSTRAINT "ManagerPersonaSkillLink_personaNodeId_fkey"
    FOREIGN KEY ("personaNodeId") REFERENCES "ManagerPersonaNode"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ManagerPersonaSkillLink"
    ADD CONSTRAINT "ManagerPersonaSkillLink_skillId_fkey"
    FOREIGN KEY ("skillId") REFERENCES "Skill"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
