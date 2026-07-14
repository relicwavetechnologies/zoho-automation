-- Department agent config fields retained only as admin/permission pass-through
-- and never consumed by Pi or backend execution have been removed.
ALTER TABLE "DepartmentAgentConfig"
  DROP COLUMN "skillsMarkdown",
  DROP COLUMN "zohoRateLimitJson";
