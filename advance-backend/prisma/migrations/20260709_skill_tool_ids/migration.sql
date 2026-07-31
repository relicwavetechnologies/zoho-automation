ALTER TABLE "Skill" ADD COLUMN "toolIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "Skill"
SET "toolIds" = ARRAY['contextSearch', 'dataProcessor']::TEXT[]
WHERE "slug" = 'coding-ops' AND cardinality("toolIds") = 0;

UPDATE "Skill"
SET "toolIds" = ARRAY['webSearch']::TEXT[]
WHERE "slug" = 'web-search' AND cardinality("toolIds") = 0;

UPDATE "Skill"
SET "toolIds" = ARRAY['zohoBooks', 'zohoCrm', 'documentRag', 'dataProcessor']::TEXT[]
WHERE "slug" = 'finance-ops-core' AND cardinality("toolIds") = 0;

UPDATE "Skill"
SET "toolIds" = ARRAY['larkTask', 'larkDoc', 'larkApproval', 'larkCalendar', 'larkBase']::TEXT[]
WHERE "slug" = 'finance-lark-ops' AND cardinality("toolIds") = 0;

UPDATE "Skill"
SET "toolIds" = ARRAY['contextSearch', 'larkCalendar', 'googleCalendar', 'larkTask']::TEXT[]
WHERE "slug" = 'workflows-scheduling-ops' AND cardinality("toolIds") = 0;
