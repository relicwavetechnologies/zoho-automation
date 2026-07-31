-- Department-scoped skills created before atomic grant creation could be
-- present in the registry but unavailable to their own department. Restore
-- that invariant once for active historical rows. Future writes create the
-- skill and its department grant in the same transaction.
INSERT INTO "SkillAccessGrant" (
  "id",
  "companyId",
  "skillId",
  "granteeType",
  "granteeId",
  "grantedBy",
  "createdAt"
)
SELECT
  md5('department-skill-grant:' || skill."id" || ':' || skill."departmentId"),
  skill."companyId",
  skill."id",
  'department',
  skill."departmentId",
  COALESCE(skill."updatedBy", skill."createdBy"),
  CURRENT_TIMESTAMP
FROM "Skill" AS skill
WHERE skill."scope" = 'department'
  AND skill."departmentId" IS NOT NULL
  AND skill."status" = 'active'
ON CONFLICT ("skillId", "granteeType", "granteeId") DO NOTHING;
