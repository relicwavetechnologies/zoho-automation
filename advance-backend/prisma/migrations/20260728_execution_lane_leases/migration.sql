-- Wave 3: distributed execution lane ownership, and the lane key needed to
-- find a burst.
--
-- Purely additive: one new table plus one nullable column and one index on an
-- existing one. Safe to apply ahead of the deploy that starts using them —
-- the table is empty until a worker takes its first lane, and `laneKey` stays
-- null on receipts accepted by the old code.
--
-- Verified against `divo_dev` on 2026-07-28 via `prisma db push`, after which
-- `prisma migrate diff --from-url` reported zero drift.

-- CreateTable
CREATE TABLE "ExecutionLaneLease" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "laneKey" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "fencingToken" INTEGER NOT NULL DEFAULT 1,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionLaneLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionLaneLease_channel_expiresAt_idx" ON "ExecutionLaneLease"("channel", "expiresAt");

-- The mutual exclusion itself. Without this constraint two replicas could each
-- open the same lane and both run the same conversation.
-- CreateIndex
CREATE UNIQUE INDEX "ExecutionLaneLease_channel_laneKey_key" ON "ExecutionLaneLease"("channel", "laneKey");

-- AlterTable
-- Nullable with no backfill: a receipt accepted before this deploy has no lane
-- recorded, so it simply never batches. Guessing one from a stored payload
-- would risk merging messages that were never one thought.
ALTER TABLE "IngressIdempotencyKey" ADD COLUMN "laneKey" TEXT;

-- CreateIndex
CREATE INDEX "IngressIdempotencyKey_channel_laneKey_status_acceptedAt_idx" ON "IngressIdempotencyKey"("channel", "laneKey", "status", "acceptedAt");
