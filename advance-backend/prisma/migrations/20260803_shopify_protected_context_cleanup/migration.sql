-- ONE-TIME SHOPIFY LARK CONTEXT CLEANUP (begin)
-- Earlier protected Shopify replies could be copied into the durable shared
-- room snapshot. Purge every Lark snapshot for a company that has, or has had,
-- a Shopify lifecycle row. Retaining an uncertain historical room snapshot is
-- not worth the privacy risk.
UPDATE "LarkChatContext"
SET
  "recentMessagesJson" = NULL,
  "summaryJson" = NULL,
  "summaryUpdatedAt" = NULL,
  "taskStateJson" = NULL,
  "taskStateUpdatedAt" = NULL,
  "sourceMessageCount" = 0,
  "lastMessageAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "companyId" IN (
  SELECT "companyId"
  FROM "IntegrationConnection"
  WHERE "provider" = 'shopify'
  UNION
  SELECT "companyId"
  FROM "ShopifyPrivacyRequest"
);
-- ONE-TIME SHOPIFY LARK CONTEXT CLEANUP (end)
