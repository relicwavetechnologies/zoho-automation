-- Skill registry foundation: folder hierarchy, immutable recipe versions,
-- aliases/capability metadata, and a company-wide discovery revision.
-- Existing Skill rows remain the live recipes and are seeded as revision 1.

ALTER TABLE "Skill"
  ADD COLUMN "folderId" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "SkillFolder" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "departmentId" TEXT,
  "parentId" TEXT,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SkillFolder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SkillVersion" (
  "id" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "markdown" TEXT NOT NULL,
  "toolIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "scope" TEXT NOT NULL,
  "departmentId" TEXT,
  "status" TEXT NOT NULL,
  "createdBy" TEXT,
  "source" TEXT NOT NULL DEFAULT 'publish',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SkillVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SkillAlias" (
  "id" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "alias" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SkillAlias_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SkillCapability" (
  "id" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "toolId" TEXT NOT NULL,
  "actionGroup" TEXT NOT NULL DEFAULT 'any',
  "requirement" TEXT NOT NULL DEFAULT 'required',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SkillCapability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SkillRegistryRevision" (
  "companyId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SkillRegistryRevision_pkey" PRIMARY KEY ("companyId")
);

CREATE UNIQUE INDEX "SkillVersion_skillId_revision_key" ON "SkillVersion"("skillId", "revision");
CREATE INDEX "SkillVersion_skillId_createdAt_idx" ON "SkillVersion"("skillId", "createdAt");
CREATE UNIQUE INDEX "SkillAlias_skillId_alias_key" ON "SkillAlias"("skillId", "alias");
CREATE INDEX "SkillAlias_alias_idx" ON "SkillAlias"("alias");
CREATE UNIQUE INDEX "SkillCapability_skillId_toolId_actionGroup_key" ON "SkillCapability"("skillId", "toolId", "actionGroup");
CREATE INDEX "SkillCapability_toolId_requirement_idx" ON "SkillCapability"("toolId", "requirement");
CREATE INDEX "SkillFolder_companyId_departmentId_parentId_status_sortOrder_idx"
  ON "SkillFolder"("companyId", "departmentId", "parentId", "status", "sortOrder");
CREATE INDEX "Skill_folderId_status_sortOrder_idx" ON "Skill"("folderId", "status", "sortOrder");

ALTER TABLE "Skill"
  ADD CONSTRAINT "Skill_folderId_fkey"
  FOREIGN KEY ("folderId") REFERENCES "SkillFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SkillFolder"
  ADD CONSTRAINT "SkillFolder_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "SkillFolder_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "SkillFolder_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "SkillFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SkillVersion"
  ADD CONSTRAINT "SkillVersion_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SkillAlias"
  ADD CONSTRAINT "SkillAlias_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SkillCapability"
  ADD CONSTRAINT "SkillCapability_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SkillRegistryRevision"
  ADD CONSTRAINT "SkillRegistryRevision_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "SkillRegistryRevision" ("companyId", "revision", "updatedAt")
SELECT "id", 1, CURRENT_TIMESTAMP FROM "Company"
ON CONFLICT ("companyId") DO NOTHING;

INSERT INTO "SkillVersion" (
  "id", "skillId", "revision", "name", "summary", "markdown", "toolIds", "tags",
  "scope", "departmentId", "status", "createdBy", "source", "createdAt"
)
SELECT
  md5('skill-version:' || "id" || ':1'), "id", "revision", "name", "summary", "markdown", "toolIds", "tags",
  "scope", "departmentId", "status", COALESCE("updatedBy", "createdBy"), 'migration', "updatedAt"
FROM "Skill"
ON CONFLICT ("skillId", "revision") DO NOTHING;

-- Mirror the already-enforced required tool list into registry metadata. The
-- application intentionally continues to enforce Skill.toolIds during this
-- transition; these rows are not a second authorization path.
INSERT INTO "SkillCapability" ("id", "skillId", "toolId", "actionGroup", "requirement", "createdAt", "updatedAt")
SELECT
  md5('skill-capability:' || s."id" || ':' || tool_id), s."id", tool_id, 'any', 'required', s."createdAt", s."updatedAt"
FROM "Skill" s
CROSS JOIN LATERAL unnest(s."toolIds") AS tool_id
ON CONFLICT ("skillId", "toolId", "actionGroup") DO NOTHING;
