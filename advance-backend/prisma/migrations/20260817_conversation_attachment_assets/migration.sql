CREATE TABLE IF NOT EXISTS "ConversationAttachmentAsset" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "conversationKey" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "storageProvider" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "deliveryType" TEXT NOT NULL,
  "threatScanProvider" TEXT,
  "threatScanVersion" TEXT,
  "threatScannedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "uncertainAt" TIMESTAMP(3),
  CONSTRAINT "ConversationAttachmentAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ConversationAttachmentAsset_scope_live_idx"
  ON "ConversationAttachmentAsset"("companyId", "userId", "channel", "chatId", "expiresAt");

CREATE INDEX IF NOT EXISTS "ConversationAttachmentAsset_name_idx"
  ON "ConversationAttachmentAsset"("companyId", "userId", "channel", "chatId", "fileName", "receivedAt");

CREATE INDEX IF NOT EXISTS "ConversationAttachmentAsset_expires_idx"
  ON "ConversationAttachmentAsset"("expiresAt");
