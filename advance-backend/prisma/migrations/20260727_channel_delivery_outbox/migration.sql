-- Wave 5: outbound delivery outbox.
--
-- Purely additive: one new table, no changes to existing ones, so this is safe
-- to apply ahead of the deploy that starts writing to it. The table is empty
-- until the adapter reserves its first delivery.
--
-- Verified against `divo_dev` on 2026-07-27 via `prisma db push`, after which
-- `prisma migrate diff --from-url` reported zero drift.

-- CreateTable
CREATE TABLE "ChannelDelivery" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "companyId" TEXT,
    "chatId" TEXT,
    "payloadJson" JSONB,
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "firstAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelDelivery_channel_status_nextAttemptAt_idx" ON "ChannelDelivery"("channel", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ChannelDelivery_runKey_idx" ON "ChannelDelivery"("runKey");

-- CreateIndex
CREATE INDEX "ChannelDelivery_channel_status_firstAttemptAt_idx" ON "ChannelDelivery"("channel", "status", "firstAttemptAt");

-- The duplicate guard itself. Without this constraint two concurrent attempts
-- could each create a row for the same segment and both send.
-- CreateIndex
CREATE UNIQUE INDEX "ChannelDelivery_channel_idempotencyKey_key" ON "ChannelDelivery"("channel", "idempotencyKey");
