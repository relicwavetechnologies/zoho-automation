-- Must sort after 20260725_lark_durable_ingress_receipt, which creates
-- "IngressIdempotencyKey". Migrations apply in lexicographic folder order, so
-- anything altering that table has to carry a later prefix.

-- Align the durable ingress receipt with schema.prisma. The original migration
-- carried column defaults that the Prisma model does not declare, which leaves
-- `prisma migrate diff` reporting drift on every run.
-- `updatedAt DateTime @updatedAt` is maintained by Prisma and carries no
-- database default; every other migration here emits a bare NOT NULL column.
ALTER TABLE "IngressIdempotencyKey"
    ALTER COLUMN "tenantKey" DROP DEFAULT,
    ALTER COLUMN "payloadJson" DROP DEFAULT,
    ALTER COLUMN "updatedAt" DROP DEFAULT;

-- Recovery scans filter on channel + status and order by acceptedAt, which also
-- decides whether a receipt is still inside its retry window. The index name
-- must match the one Prisma derives from @@index([channel, status, acceptedAt])
-- or `migrate diff` reports the schema index as permanently missing.
CREATE INDEX IF NOT EXISTS "IngressIdempotencyKey_channel_status_acceptedAt_idx"
    ON "IngressIdempotencyKey"("channel", "status", "acceptedAt");
