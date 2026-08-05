-- ONE-TIME SHOPIFY PROTECTED-DATA CLEANUP (begin)
--
-- Before enabling the durable privacy lifecycle, remove legacy customer/order
-- tool material from execution traces and every learning pipeline that copied
-- those executions. This is an irreversible privacy cleanup, not a customer
-- data export. Analytics-only Shopify traces are intentionally untouched.
CREATE TEMP TABLE "_ShopifyProtectedExecution" (
  "executionId" TEXT PRIMARY KEY
);

INSERT INTO "_ShopifyProtectedExecution" ("executionId")
SELECT DISTINCT protected."executionId"
FROM (
  SELECT result."executionId"
  FROM "StepResult" result
  WHERE result."rawOutput" #>> '{input,payload,toolId}' IN ('shopifyOrders', 'shopifyCustomers')

  UNION

  SELECT event."executionId"
  FROM "ExecutionEvent" event
  WHERE event."payload" #>> '{input,payload,toolId}' IN ('shopifyOrders', 'shopifyCustomers')
) protected;

-- Evidence owns persona-learning jobs and candidates through ON DELETE CASCADE.
DELETE FROM "PersonaLearningEvidence" evidence
USING "_ShopifyProtectedExecution" protected
WHERE evidence."executionRunId" = protected."executionId";

DELETE FROM "KnowledgeLearningJob" job
USING "_ShopifyProtectedExecution" protected
WHERE job."sourceId" = 'desktop:' || protected."executionId";

-- The top-level rollup can summarize protected rows even though it is not raw
-- tool output, so clear it before deleting only the protected trace rows.
UPDATE "ExecutionRun" execution
SET "latestSummary" = NULL
FROM "_ShopifyProtectedExecution" protected
WHERE execution."id" = protected."executionId";

DELETE FROM "StepResult" result
WHERE result."rawOutput" #>> '{input,payload,toolId}' IN ('shopifyOrders', 'shopifyCustomers');

DELETE FROM "ExecutionEvent" event
WHERE event."payload" #>> '{input,payload,toolId}' IN ('shopifyOrders', 'shopifyCustomers');

-- A protected approval can be summarized into any message in its conversation.
-- Delete all messages for those conversations and invalidate the summary before
-- deleting the approval payload/result itself.
CREATE TEMP TABLE "_ShopifyProtectedConversation" (
  "conversationId" TEXT PRIMARY KEY
);

INSERT INTO "_ShopifyProtectedConversation" ("conversationId")
SELECT DISTINCT approval."conversationId"
FROM "RuntimeApproval" approval
WHERE approval."toolId" IN ('shopifyOrders', 'shopifyCustomers');

DELETE FROM "RuntimeConversationMessage" message
USING "_ShopifyProtectedConversation" protected
WHERE message."conversationId" = protected."conversationId";

UPDATE "RuntimeConversation" conversation
SET
  "summaryJson" = NULL,
  "summaryUpdatedAt" = NULL,
  "lastSummarizedSequence" = 0
FROM "_ShopifyProtectedConversation" protected
WHERE conversation."id" = protected."conversationId";

DELETE FROM "RuntimeApproval"
WHERE "toolId" IN ('shopifyOrders', 'shopifyCustomers');

DROP TABLE "_ShopifyProtectedConversation";
DROP TABLE "_ShopifyProtectedExecution";
-- ONE-TIME SHOPIFY PROTECTED-DATA CLEANUP (end)

CREATE TYPE "ShopifyPrivacyRequestState" AS ENUM (
  'received',
  'ready',
  'delivered',
  'expired',
  'redacted',
  'failed'
);

CREATE TABLE "ShopifyPrivacyRequest" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "customerIdHash" TEXT,
  "orderIdHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "state" "ShopifyPrivacyRequestState" NOT NULL DEFAULT 'received',
  "exportPayloadEncrypted" TEXT,
  "exportCipherVersion" INTEGER,
  "failureCode" TEXT,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "readyAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "redactedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ShopifyPrivacyRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ShopifyPrivacyRequest_subject_check" CHECK (
    "state" IN ('expired', 'redacted')
    OR "customerIdHash" IS NOT NULL
    OR cardinality("orderIdHashes") > 0
  ),
  CONSTRAINT "ShopifyPrivacyRequest_customer_hash_check" CHECK (
    "customerIdHash" IS NULL OR "customerIdHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ShopifyPrivacyRequest_order_hashes_check" CHECK (
    cardinality("orderIdHashes") <= 250
    AND length(array_to_string("orderIdHashes", '')) = cardinality("orderIdHashes") * 64
    AND array_to_string("orderIdHashes", '') ~ '^[0-9a-f]*$'
  ),
  CONSTRAINT "ShopifyPrivacyRequest_retention_check" CHECK (
    "expiresAt" >= "deadlineAt"
  ),
  CONSTRAINT "ShopifyPrivacyRequest_export_check" CHECK (
    (
      "state" IN ('ready', 'delivered')
      AND "exportPayloadEncrypted" IS NOT NULL
      AND "exportCipherVersion" IS NOT NULL
    )
    OR
    (
      "state" NOT IN ('ready', 'delivered')
      AND "exportPayloadEncrypted" IS NULL
      AND "exportCipherVersion" IS NULL
    )
  ),
  CONSTRAINT "ShopifyPrivacyRequest_failure_check" CHECK (
    ("state" = 'failed' AND "failureCode" IS NOT NULL)
    OR ("state" <> 'failed' AND "failureCode" IS NULL)
  ),
  CONSTRAINT "ShopifyPrivacyRequest_delivery_check" CHECK (
    "state" <> 'delivered' OR "deliveredAt" IS NOT NULL
  ),
  CONSTRAINT "ShopifyPrivacyRequest_redaction_check" CHECK (
    "state" <> 'redacted' OR "redactedAt" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "ShopifyPrivacyRequest_companyId_shopDomain_requestId_key"
  ON "ShopifyPrivacyRequest"("companyId", "shopDomain", "requestId");
CREATE INDEX "ShopifyPrivacyRequest_companyId_shopDomain_state_createdAt_idx"
  ON "ShopifyPrivacyRequest"("companyId", "shopDomain", "state", "createdAt");
CREATE INDEX "ShopifyPrivacyRequest_companyId_customerIdHash_state_idx"
  ON "ShopifyPrivacyRequest"("companyId", "customerIdHash", "state");
CREATE INDEX "ShopifyPrivacyRequest_state_expiresAt_idx"
  ON "ShopifyPrivacyRequest"("state", "expiresAt");

ALTER TABLE "ShopifyPrivacyRequest"
  ADD CONSTRAINT "ShopifyPrivacyRequest_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
