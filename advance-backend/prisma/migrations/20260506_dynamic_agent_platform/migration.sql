-- Dynamic agent runtime fields for DB-configured orchestration.
ALTER TABLE "AgentDefinition"
  ADD COLUMN "slug" TEXT,
  ADD COLUMN "capabilityDescription" TEXT,
  ADD COLUMN "hookId" TEXT,
  ADD COLUMN "maxSteps" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0;

WITH base AS (
  SELECT
    "id",
    "companyId",
    COALESCE(
      NULLIF(
        regexp_replace(
          regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'),
          '(^-|-$)',
          '',
          'g'
        ),
        ''
      ),
      "id"
    ) AS "baseSlug"
  FROM "AgentDefinition"
  WHERE "slug" IS NULL
),
ranked AS (
  SELECT
    "id",
    CASE
      WHEN COUNT(*) OVER (PARTITION BY "companyId", "baseSlug") = 1 THEN "baseSlug"
      ELSE "baseSlug" || '-' || ROW_NUMBER() OVER (PARTITION BY "companyId", "baseSlug" ORDER BY "id")
    END AS "newSlug"
  FROM base
)
UPDATE "AgentDefinition" AS a
SET "slug" = ranked."newSlug"
FROM ranked
WHERE a."id" = ranked."id";

ALTER TABLE "AgentDefinition"
  ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX "AgentDefinition_companyId_slug_key"
  ON "AgentDefinition"("companyId", "slug");
