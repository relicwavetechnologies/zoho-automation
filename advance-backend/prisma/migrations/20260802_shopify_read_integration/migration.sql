ALTER TABLE "IntegrationConnection"
ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "refreshLeaseOwner" TEXT,
ADD COLUMN "refreshLeaseExpiresAt" TIMESTAMP(3);

CREATE TABLE "IntegrationOAuthAttempt" (
  "id" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "requestedScopes" TEXT[] NOT NULL,
  "returnTo" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntegrationOAuthAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationOAuthAttempt_stateHash_key" ON "IntegrationOAuthAttempt"("stateHash");
CREATE INDEX "IntegrationOAuthAttempt_companyId_provider_status_expiresAt_idx" ON "IntegrationOAuthAttempt"("companyId", "provider", "status", "expiresAt");
CREATE INDEX "IntegrationOAuthAttempt_status_expiresAt_idx" ON "IntegrationOAuthAttempt"("status", "expiresAt");
ALTER TABLE "IntegrationOAuthAttempt" ADD CONSTRAINT "IntegrationOAuthAttempt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationOAuthAttempt" ADD CONSTRAINT "IntegrationOAuthAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IntegrationWebhookReceipt" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationWebhookReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrationWebhookReceipt_provider_webhookId_key" ON "IntegrationWebhookReceipt"("provider", "webhookId");
CREATE INDEX "IntegrationWebhookReceipt_provider_accountId_receivedAt_idx" ON "IntegrationWebhookReceipt"("provider", "accountId", "receivedAt");
