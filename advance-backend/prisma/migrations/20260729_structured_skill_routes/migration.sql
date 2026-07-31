CREATE TABLE "SkillRoute" (
  "routerSkillId" TEXT NOT NULL,
  "targetSkillId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SkillRoute_pkey" PRIMARY KEY ("routerSkillId", "targetSkillId")
);

CREATE INDEX "SkillRoute_routerSkillId_sortOrder_idx"
  ON "SkillRoute"("routerSkillId", "sortOrder");

CREATE INDEX "SkillRoute_targetSkillId_idx"
  ON "SkillRoute"("targetSkillId");

ALTER TABLE "SkillRoute"
  ADD CONSTRAINT "SkillRoute_routerSkillId_fkey"
  FOREIGN KEY ("routerSkillId") REFERENCES "Skill"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SkillRoute"
  ADD CONSTRAINT "SkillRoute_targetSkillId_fkey"
  FOREIGN KEY ("targetSkillId") REFERENCES "Skill"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
