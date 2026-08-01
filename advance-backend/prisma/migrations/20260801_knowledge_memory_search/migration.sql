-- Canonical Postgres keyword retrieval for knowledge versions. Hindsight is a
-- semantic projection; this index keeps recall and identity resolution useful
-- when that projection is delayed or unavailable.
ALTER TABLE "KnowledgeVersion"
  ADD COLUMN IF NOT EXISTS "searchText" TEXT,
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

UPDATE "KnowledgeVersion" AS "version"
SET "searchText" = concat_ws(
  ' ',
  "resource"."logicalKey",
  "version"."contentJson"::text
)
FROM "KnowledgeResource" AS "resource"
WHERE "resource"."id" = "version"."resourceId";

UPDATE "KnowledgeVersion"
SET "searchVector" = to_tsvector('english', coalesce("searchText", ''));

CREATE INDEX IF NOT EXISTS "KnowledgeVersion_searchVector_idx"
  ON "KnowledgeVersion" USING GIN ("searchVector");
