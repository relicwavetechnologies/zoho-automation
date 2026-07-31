CREATE TABLE IF NOT EXISTS "IngressIdempotencyKey" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "tenantKey" TEXT NOT NULL DEFAULT '',
    "eventId" TEXT,
    "messageId" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "companyId" TEXT,
    "queueJobId" TEXT,
    "lastError" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngressIdempotencyKey_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "IngressIdempotencyKey"
    ADD COLUMN IF NOT EXISTS "tenantKey" TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS "eventId" TEXT,
    ADD COLUMN IF NOT EXISTS "payloadJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'accepted',
    ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "companyId" TEXT,
    ADD COLUMN IF NOT EXISTS "queueJobId" TEXT,
    ADD COLUMN IF NOT EXISTS "lastError" TEXT,
    ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DROP INDEX IF EXISTS "IngressIdempotencyKey_messageId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "IngressIdempotencyKey_channel_tenantKey_messageId_key"
    ON "IngressIdempotencyKey"("channel", "tenantKey", "messageId");
CREATE INDEX IF NOT EXISTS "IngressIdempotencyKey_channel_createdAt_idx"
    ON "IngressIdempotencyKey"("channel", "createdAt");
CREATE INDEX IF NOT EXISTS "IngressIdempotencyKey_channel_tenantKey_eventId_idx"
    ON "IngressIdempotencyKey"("channel", "tenantKey", "eventId");
CREATE INDEX IF NOT EXISTS "IngressIdempotencyKey_status_createdAt_idx"
    ON "IngressIdempotencyKey"("status", "createdAt");
