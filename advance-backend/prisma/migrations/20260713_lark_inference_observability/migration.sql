ALTER TABLE "ProxyRequestLog"
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'desktop',
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'deepseek',
  ADD COLUMN "agentTarget" TEXT NOT NULL DEFAULT 'pi';

CREATE INDEX "ProxyRequestLog_companyId_channel_createdAt_idx"
  ON "ProxyRequestLog"("companyId", "channel", "createdAt");
