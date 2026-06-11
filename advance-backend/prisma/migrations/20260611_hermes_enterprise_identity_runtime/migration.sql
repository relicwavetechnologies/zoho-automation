-- AlterTable
ALTER TABLE "ChannelIdentity" ADD COLUMN     "approvedSource" TEXT,
ADD COLUMN     "companyUserId" TEXT,
ADD COLUMN     "firstSeenAt" TIMESTAMP(3),
ADD COLUMN     "identityKey" TEXT,
ADD COLUMN     "identityKind" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "platformChatId" TEXT,
ADD COLUMN     "platformUserIdAlt" TEXT,
ADD COLUMN     "platformWorkspaceId" TEXT,
ADD COLUMN     "rawJson" JSONB;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "DesktopThread" ADD COLUMN     "workspaceId" TEXT,
ADD COLUMN     "workspaceName" TEXT,
ADD COLUMN     "workspacePath" TEXT;

-- AlterTable
ALTER TABLE "RuntimeConversationMessage" ADD COLUMN     "actingChannelIdentityId" TEXT,
ADD COLUMN     "actingCompanyUserId" TEXT,
ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "finishReason" TEXT,
ADD COLUMN     "hermesMessageId" TEXT,
ADD COLUMN     "observed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reasoningJson" JSONB,
ADD COLUMN     "senderDisplayName" TEXT,
ADD COLUMN     "senderExternalId" TEXT,
ADD COLUMN     "tokenCount" INTEGER,
ADD COLUMN     "toolCallId" TEXT;

-- AlterTable
ALTER TABLE "RuntimeRun" ADD COLUMN     "cwd" TEXT,
ADD COLUMN     "hermesSessionId" TEXT,
ADD COLUMN     "modelId" TEXT,
ADD COLUMN     "parentHermesSessionId" TEXT,
ADD COLUMN     "systemPromptSnapshot" TEXT;

-- AlterTable
ALTER TABLE "StepResult" ADD COLUMN     "hermesSessionId" TEXT,
ADD COLUMN     "toolCallId" TEXT;

-- CreateTable
CREATE TABLE "CompanyUser" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "departmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesktopWorkspace" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesktopWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HermesSessionBinding" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hermesSessionId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "runId" TEXT,
    "channelIdentityId" TEXT,
    "resolvedUserId" TEXT,
    "parentHermesSessionId" TEXT,
    "platform" TEXT,
    "chatId" TEXT,
    "threadId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'runtime',
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HermesSessionBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HermesRunStats" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(18,8),
    "actualCostUsd" DECIMAL(18,8),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "rewindCount" INTEGER NOT NULL DEFAULT 0,
    "billingStatus" TEXT NOT NULL DEFAULT 'unbilled',
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HermesRunStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyUser_companyId_role_idx" ON "CompanyUser"("companyId", "role");

-- CreateIndex
CREATE INDEX "CompanyUser_companyId_departmentId_idx" ON "CompanyUser"("companyId", "departmentId");

-- CreateIndex
CREATE INDEX "CompanyUser_companyId_status_idx" ON "CompanyUser"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyUser_companyId_userId_key" ON "CompanyUser"("companyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyUser_companyId_email_key" ON "CompanyUser"("companyId", "email");

-- CreateIndex
CREATE INDEX "DesktopWorkspace_userId_companyId_updatedAt_idx" ON "DesktopWorkspace"("userId", "companyId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DesktopWorkspace_companyId_userId_path_key" ON "DesktopWorkspace"("companyId", "userId", "path");

-- CreateIndex
CREATE INDEX "HermesSessionBinding_sessionKey_idx" ON "HermesSessionBinding"("sessionKey");

-- CreateIndex
CREATE INDEX "HermesSessionBinding_conversationId_idx" ON "HermesSessionBinding"("conversationId");

-- CreateIndex
CREATE INDEX "HermesSessionBinding_runId_idx" ON "HermesSessionBinding"("runId");

-- CreateIndex
CREATE INDEX "HermesSessionBinding_channelIdentityId_idx" ON "HermesSessionBinding"("channelIdentityId");

-- CreateIndex
CREATE INDEX "HermesSessionBinding_resolvedUserId_idx" ON "HermesSessionBinding"("resolvedUserId");

-- CreateIndex
CREATE INDEX "HermesSessionBinding_parentHermesSessionId_idx" ON "HermesSessionBinding"("parentHermesSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "HermesSessionBinding_companyId_hermesSessionId_key" ON "HermesSessionBinding"("companyId", "hermesSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "HermesRunStats_runId_key" ON "HermesRunStats"("runId");

-- CreateIndex
CREATE INDEX "ChannelIdentity_companyId_companyUserId_idx" ON "ChannelIdentity"("companyId", "companyUserId");

-- CreateIndex
CREATE INDEX "ChannelIdentity_companyId_identityKey_idx" ON "ChannelIdentity"("companyId", "identityKey");

-- CreateIndex
CREATE INDEX "ChannelIdentity_companyId_platformChatId_idx" ON "ChannelIdentity"("companyId", "platformChatId");

-- CreateIndex
CREATE INDEX "DesktopThread_workspaceId_updatedAt_idx" ON "DesktopThread"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "RuntimeConversationMessage_actingCompanyUserId_createdAt_idx" ON "RuntimeConversationMessage"("actingCompanyUserId", "createdAt");

-- CreateIndex
CREATE INDEX "RuntimeConversationMessage_actingChannelIdentityId_createdA_idx" ON "RuntimeConversationMessage"("actingChannelIdentityId", "createdAt");

-- CreateIndex
CREATE INDEX "RuntimeConversationMessage_hermesMessageId_idx" ON "RuntimeConversationMessage"("hermesMessageId");

-- CreateIndex
CREATE INDEX "RuntimeConversationMessage_toolCallId_idx" ON "RuntimeConversationMessage"("toolCallId");

-- CreateIndex
CREATE INDEX "RuntimeRun_hermesSessionId_idx" ON "RuntimeRun"("hermesSessionId");

-- CreateIndex
CREATE INDEX "RuntimeRun_parentHermesSessionId_idx" ON "RuntimeRun"("parentHermesSessionId");

-- CreateIndex
CREATE INDEX "StepResult_toolCallId_idx" ON "StepResult"("toolCallId");

-- CreateIndex
CREATE INDEX "StepResult_hermesSessionId_idx" ON "StepResult"("hermesSessionId");

-- AddForeignKey
ALTER TABLE "DesktopWorkspace" ADD CONSTRAINT "DesktopWorkspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopWorkspace" ADD CONSTRAINT "DesktopWorkspace_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopThread" ADD CONSTRAINT "DesktopThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "DesktopWorkspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

