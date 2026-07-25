-- Tenant-scoped Lark identity resolution reads `tokenMetadata.larkTenantKey`.
-- Connections created before that field was written have no tenant key, so the
-- scoped resolver returns NULL for them: card actions fail to authenticate and
-- webhook routing silently drops to the legacy chat-wide lane.
--
-- `LarkTenantBinding` is unique on larkTenantKey, so one installation cannot
-- span two companies — but a company CAN hold two active bindings, which the
-- admin API treats as a live state (company.routes.ts returns 409 for it).
-- With two bindings there is no authoritative tenant key for a connection, and
-- guessing would stamp the wrong one; the row would then resolve to nothing and
-- could not be repaired by re-running, since the key is no longer null. So
-- restrict the backfill to companies with exactly one active binding and leave
-- ambiguous companies for the admin to resolve.
--
-- Backfill only rows missing the key; never overwrite one already set.
--
-- Guarded because this migration folder is not a complete schema history: these
-- tables are created by `prisma db push`, not by a migration, so on a database
-- built purely from `prisma/migrations` they do not exist yet. A backfill has
-- nothing to do in that case.

DO $$
BEGIN
  IF to_regclass('"IntegrationConnection"') IS NOT NULL
     AND to_regclass('"LarkTenantBinding"') IS NOT NULL THEN
    UPDATE "IntegrationConnection" AS ic
    SET "tokenMetadata" = COALESCE(ic."tokenMetadata", '{}'::jsonb)
        || jsonb_build_object('larkTenantKey', b."larkTenantKey")
    FROM (
      SELECT "companyId", min("larkTenantKey") AS "larkTenantKey"
      FROM "LarkTenantBinding"
      WHERE "isActive" = true
      GROUP BY "companyId"
      HAVING count(*) = 1
    ) AS b
    WHERE ic."companyId" = b."companyId"
      AND ic."provider" = 'lark'
      AND (
        ic."tokenMetadata" IS NULL
        OR ic."tokenMetadata" ->> 'larkTenantKey' IS NULL
        OR ic."tokenMetadata" ->> 'larkTenantKey' = ''
      );
  END IF;
END $$;
