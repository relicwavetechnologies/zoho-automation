CREATE TABLE "ShopifyRunProvenance" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "executionRunId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "toolId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ShopifyRunProvenance_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RuntimeConversationMessage"
  ADD COLUMN "sourceRunId" TEXT;

ALTER TABLE "RuntimeConversation"
  ADD COLUMN "historyRevision" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "ShopifyRunProvenance_executionRunId_connectionId_toolId_key"
  ON "ShopifyRunProvenance"("executionRunId", "connectionId", "toolId");
CREATE INDEX "ShopifyRunProvenance_companyId_shopDomain_createdAt_idx"
  ON "ShopifyRunProvenance"("companyId", "shopDomain", "createdAt");
CREATE INDEX "ShopifyRunProvenance_connectionId_createdAt_idx"
  ON "ShopifyRunProvenance"("connectionId", "createdAt");
CREATE INDEX "RuntimeConversationMessage_sourceRunId_createdAt_idx"
  ON "RuntimeConversationMessage"("sourceRunId", "createdAt");

ALTER TABLE "ShopifyRunProvenance"
  ADD CONSTRAINT "ShopifyRunProvenance_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShopifyRunProvenance"
  ADD CONSTRAINT "ShopifyRunProvenance_executionRunId_fkey"
  FOREIGN KEY ("executionRunId") REFERENCES "ExecutionRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill only when the legacy trace contains an exact Shopify connection ID
-- that still resolves to the same tenant. Ambiguous or orphaned JSON is left
-- unclassified instead of risking cross-shop erasure.
INSERT INTO "ShopifyRunProvenance" (
  "id",
  "companyId",
  "executionRunId",
  "connectionId",
  "shopDomain",
  "toolId"
)
SELECT
  gen_random_uuid()::TEXT,
  execution."companyId",
  legacy."executionId",
  legacy."connectionId",
  connection."externalAccountId",
  legacy."toolId"
FROM (
  SELECT DISTINCT
    result."executionId",
    result."rawOutput" #>> '{input,payload,toolId}' AS "toolId",
    result."rawOutput" #>> '{input,payload,args,connectionId}' AS "connectionId"
  FROM "StepResult" result
  WHERE result."rawOutput" #>> '{input,payload,toolId}' IN (
    'shopifyAnalytics', 'shopifyOrders', 'shopifyCustomers'
  )

  UNION

  SELECT DISTINCT
    event."executionId",
    event."payload" #>> '{input,payload,toolId}' AS "toolId",
    event."payload" #>> '{input,payload,args,connectionId}' AS "connectionId"
  FROM "ExecutionEvent" event
  WHERE event."payload" #>> '{input,payload,toolId}' IN (
    'shopifyAnalytics', 'shopifyOrders', 'shopifyCustomers'
  )
) legacy
JOIN "ExecutionRun" execution
  ON execution."id" = legacy."executionId"
JOIN "IntegrationConnection" connection
  ON connection."id" = legacy."connectionId"
 AND connection."companyId" = execution."companyId"
 AND connection."provider" = 'shopify'
 AND connection."externalAccountId" IS NOT NULL
ON CONFLICT ("executionRunId", "connectionId", "toolId") DO NOTHING;
