-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ScheduledWorkflowStatus" AS ENUM ('draft', 'published', 'active', 'scheduled_active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "ScheduledWorkflowScheduleType" AS ENUM ('one_time', 'hourly', 'daily', 'weekly', 'monthly');

-- CreateEnum
CREATE TYPE "ScheduledWorkflowRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'blocked');

-- CreateEnum
CREATE TYPE "KnowledgeResourceKind" AS ENUM ('memory', 'skill', 'file');

-- CreateEnum
CREATE TYPE "KnowledgeResourceScope" AS ENUM ('personal', 'department', 'company');

-- CreateEnum
CREATE TYPE "KnowledgeResourceStatus" AS ENUM ('draft', 'active', 'archived', 'deleted');

-- CreateEnum
CREATE TYPE "KnowledgeMutationAction" AS ENUM ('create', 'update', 'publish', 'delete');

-- CreateEnum
CREATE TYPE "KnowledgeMutationStatus" AS ENUM ('awaiting_requester_review', 'awaiting_approval', 'approved', 'applying', 'applied', 'rejected', 'cancelled', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "KnowledgeApprovalAuthority" AS ENUM ('none', 'department_manager', 'company_admin');

-- CreateEnum
CREATE TYPE "KnowledgeOutboxStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "KnowledgeFileAssetStatus" AS ENUM ('staged', 'deleting', 'attached', 'deleted');

-- CreateEnum
CREATE TYPE "KnowledgeFileDocumentStatus" AS ENUM ('processing', 'ready', 'failed', 'superseded', 'deleted');

-- CreateEnum
CREATE TYPE "KnowledgeLearningJobStatus" AS ENUM ('queued', 'processing', 'completed', 'no_learning', 'failed');

-- CreateEnum
CREATE TYPE "ShopifyPrivacyRequestState" AS ENUM ('received', 'ready', 'delivered', 'expired', 'redacted', 'failed');

-- CreateEnum
CREATE TYPE "PersonaLearningEvidenceStatus" AS ENUM ('eligible', 'skipped');

-- CreateEnum
CREATE TYPE "PersonaLearningJobStatus" AS ENUM ('queued', 'processing', 'shadow_complete', 'no_learning', 'failed');

-- CreateEnum
CREATE TYPE "PersonaLearningCandidateKind" AS ENUM ('preference', 'correction', 'workflow', 'skill', 'contradiction');

-- CreateEnum
CREATE TYPE "PersonaLearningEvidenceStrength" AS ENUM ('explicit', 'confirmed', 'inferred');

-- CreateEnum
CREATE TYPE "PersonaLearningCandidateStatus" AS ENUM ('shadow', 'active', 'reverted');

-- CreateEnum
CREATE TYPE "ManagerPersonaNodeStatus" AS ENUM ('active', 'superseded', 'quarantined');

-- CreateEnum
CREATE TYPE "ManagerLearningDecision" AS ENUM ('create', 'merge', 'replace', 'retire');

-- CreateEnum
CREATE TYPE "ManagerTeachSource" AS ENUM ('recording', 'upload');

-- CreateEnum
CREATE TYPE "ManagerTeachSessionStatus" AS ENUM ('awaiting_upload', 'queued', 'ingesting', 'evidence_ready', 'agent_processing', 'completed', 'ready_for_processing', 'persona_processing', 'persona_updated', 'no_learning', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ManagerTeachPersonaMutationStatus" AS ENUM ('applied', 'no_learning');

-- CreateEnum
CREATE TYPE "ManagerTeachArtifactKind" AS ENUM ('raw_video', 'evidence_manifest');

-- CreateEnum
CREATE TYPE "ManagerTeachArtifactStatus" AS ENUM ('available', 'deleted');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "gateway_api_key" TEXT,
    "gateway_url" TEXT,
    "gateway_dedicated_account_id" TEXT,
    "default_ai_provider" TEXT NOT NULL DEFAULT 'google',
    "default_ai_model" TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegisteredTool" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "promptSnippet" TEXT,
    "recoveryHint" TEXT,
    "hitlRequired" BOOLEAN NOT NULL DEFAULT false,
    "guardrails" TEXT[],
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "engines" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegisteredTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDepartmentPreference" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeDepartmentId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDepartmentPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT,
    "role" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT,
    "role" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZohoConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'prod',
    "providerMode" TEXT NOT NULL DEFAULT 'rest',
    "status" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[],
    "lastSyncAt" TIMESTAMP(3),
    "mcpBaseUrl" TEXT,
    "mcpApiKeyEncrypted" TEXT,
    "mcpWorkspaceKey" TEXT,
    "mcpAllowedTools" TEXT[],
    "mcpCapabilities" JSONB,
    "mcpLastHealthAt" TIMESTAMP(3),
    "mcpLastHealthStatus" TEXT,
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "tokenCipherVersion" INTEGER NOT NULL DEFAULT 1,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "tokenFailureCode" TEXT,
    "lastTokenRefreshAt" TIMESTAMP(3),
    "tokenMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZohoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZohoConnectionProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "profileName" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'prod',
    "connectionSource" TEXT NOT NULL DEFAULT 'manual_token_set',
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "clientId" TEXT NOT NULL,
    "clientSecretEncrypted" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "accountsBaseUrl" TEXT NOT NULL DEFAULT 'https://accounts.zoho.com',
    "apiBaseUrl" TEXT NOT NULL DEFAULT 'https://www.zohoapis.com',
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "tokenCipherVersion" INTEGER NOT NULL DEFAULT 1,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "tokenMetadata" JSONB,
    "disabledAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZohoConnectionProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZohoOAuthConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEncrypted" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "accountsBaseUrl" TEXT NOT NULL DEFAULT 'https://accounts.zoho.com',
    "apiBaseUrl" TEXT NOT NULL DEFAULT 'https://www.zohoapis.com',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZohoOAuthConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelIdentity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "externalTenantId" TEXT NOT NULL,
    "displayName" TEXT,
    "email" TEXT,
    "larkOpenId" TEXT,
    "larkUserId" TEXT,
    "sourceRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aiRole" TEXT NOT NULL DEFAULT 'MEMBER',
    "aiRoleSource" TEXT NOT NULL DEFAULT 'sync',
    "syncedAiRole" TEXT,
    "syncedFromLarkRole" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LarkWorkspaceConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "appSecretEncrypted" TEXT NOT NULL,
    "verificationTokenEncrypted" TEXT,
    "signingSecretEncrypted" TEXT,
    "staticTenantAccessTokenEncrypted" TEXT,
    "apiBaseUrl" TEXT NOT NULL DEFAULT 'https://open.larksuite.com',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LarkWorkspaceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LarkOperationalConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "defaultBaseAppToken" TEXT,
    "defaultBaseTableId" TEXT,
    "defaultBaseViewId" TEXT,
    "defaultTasklistId" TEXT,
    "defaultCalendarId" TEXT,
    "defaultApprovalCode" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LarkOperationalConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LarkDirectorySyncRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "syncedCount" INTEGER NOT NULL DEFAULT 0,
    "adminCount" INTEGER NOT NULL DEFAULT 0,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "diagnostics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LarkDirectorySyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LarkTenantBinding" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "larkTenantKey" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LarkTenantBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpActionLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actionName" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "receipt" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZohoSyncJob" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "checkpoint" TEXT,
    "totalBatches" INTEGER,
    "processedBatches" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "correlationId" TEXT,
    "payload" JSONB,
    "errorMessage" TEXT,

    CONSTRAINT "ZohoSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZohoDeltaEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZohoDeltaEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZohoSyncJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "message" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZohoSyncJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundArtifact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "sourceSystem" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceRecordType" TEXT,
    "sourceRecordId" TEXT,
    "sourceMetadata" JSONB,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKind" TEXT NOT NULL DEFAULT 'inline_base64',
    "contentBase64" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundArtifact_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "IngressIdempotencyKey" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "tenantKey" TEXT NOT NULL,
    "eventId" TEXT,
    "messageId" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "laneKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "companyId" TEXT,
    "queueJobId" TEXT,
    "lastError" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngressIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacPermission" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "RbacPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "companyId" TEXT,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminControlState" (
    "id" TEXT NOT NULL,
    "controlKey" TEXT NOT NULL,
    "companyId" TEXT,
    "value" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminControlState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyInvite" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "knowledgeResourceId" TEXT,
    "companyId" TEXT NOT NULL,
    "departmentId" TEXT,
    "folderId" TEXT,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "toolIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillRoute" (
    "routerSkillId" TEXT NOT NULL,
    "targetSkillId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillRoute_pkey" PRIMARY KEY ("routerSkillId","targetSkillId")
);

-- CreateTable
CREATE TABLE "SkillFolder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "departmentId" TEXT,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillVersion" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "toolIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scope" TEXT NOT NULL,
    "departmentId" TEXT,
    "status" TEXT NOT NULL,
    "createdBy" TEXT,
    "source" TEXT NOT NULL DEFAULT 'publish',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillAlias" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillCapability" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "actionGroup" TEXT NOT NULL DEFAULT 'any',
    "requirement" TEXT NOT NULL DEFAULT 'required',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillRegistryRevision" (
    "companyId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillRegistryRevision_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "SkillAccessGrant" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "granteeType" TEXT NOT NULL,
    "granteeId" TEXT NOT NULL,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentAgentConfig" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "desktopPersonaPrompt" TEXT NOT NULL DEFAULT '',
    "managerApprovalJson" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentAgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentRole" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "zohoReadScope" TEXT NOT NULL DEFAULT 'personalized',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BooksModulePermission" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "departmentRoleId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scopeOverride" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "BooksModulePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentMembership" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentToolPermission" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "actionGroup" TEXT NOT NULL DEFAULT 'all',
    "allowed" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentToolPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentUserToolOverride" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "actionGroup" TEXT NOT NULL DEFAULT 'all',
    "allowed" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentUserToolOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolPermission" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "ToolPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolActionPermission" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "actionGroup" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "ToolActionPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZohoRoleAccessPolicy" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "companyScopedRead" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "ZohoRoleAccessPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRoleDefinition" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRoleDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModelTargetConfig" (
    "id" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "thinkingLevel" TEXT,
    "fastProvider" TEXT,
    "fastModelId" TEXT,
    "fastThinkingLevel" TEXT,
    "xtremeProvider" TEXT,
    "xtremeModelId" TEXT,
    "xtremeThinkingLevel" TEXT,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModelTargetConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "channel" TEXT NOT NULL DEFAULT 'desktop',
    "authProvider" TEXT NOT NULL DEFAULT 'password',
    "larkTenantKey" TEXT,
    "larkOpenId" TEXT,
    "larkUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LarkUserAuthLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "larkTenantKey" TEXT NOT NULL,
    "larkOpenId" TEXT,
    "larkUserId" TEXT,
    "larkEmail" TEXT NOT NULL,
    "larkName" TEXT,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT,
    "tokenType" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "tokenMetadata" JSONB,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LarkUserAuthLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "label" TEXT NOT NULL,
    "accountEmail" TEXT,
    "accountName" TEXT,
    "externalAccountId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "scopes" TEXT[],
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "tokenType" TEXT,
    "tokenCipherVersion" INTEGER NOT NULL DEFAULT 1,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "refreshLeaseOwner" TEXT,
    "refreshLeaseExpiresAt" TIMESTAMP(3),
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "tokenMetadata" JSONB,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationOAuthAttempt" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "requestedScopes" TEXT[],
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

-- CreateTable
CREATE TABLE "IntegrationWebhookReceipt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationWebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyPrivacyRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "customerIdHash" TEXT,
    "orderIdHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
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

    CONSTRAINT "ShopifyPrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "ShopifyRunErasureFence" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyRunErasureFence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionAuthorizationIntent" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "activeDedupeKey" TEXT,
    "provider" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "departmentId" TEXT,
    "connectionId" TEXT,
    "larkOpenId" TEXT NOT NULL,
    "larkTenantKey" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatType" TEXT NOT NULL,
    "originalMessageId" TEXT NOT NULL,
    "rootMessageId" TEXT,
    "replyInThread" BOOLEAN NOT NULL DEFAULT false,
    "groupReplyMode" TEXT,
    "originalRequest" TEXT NOT NULL,
    "requestedToolIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "continuationStatus" TEXT NOT NULL DEFAULT 'blocked',
    "continuationIdempotencyKey" TEXT NOT NULL,
    "continuationRunId" TEXT,
    "correlationId" TEXT NOT NULL,
    "failureCode" TEXT,
    "authorizationCodeEncrypted" TEXT,
    "exchangeTokensEncrypted" TEXT,
    "exchangeStartedAt" TIMESTAMP(3),
    "exchangeAttempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "continuationQueuedAt" TIMESTAMP(3),
    "continuationStartedAt" TIMESTAMP(3),
    "continuationFinishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectionAuthorizationIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxSubscription" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'google_workspace',
    "mailboxEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "historyId" TEXT,
    "nextPollAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "watchExpirationAt" TIMESTAMP(3),
    "nextWatchRenewalAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "watchRegisteredAt" TIMESTAMP(3),
    "watchClaimToken" TEXT,
    "watchClaimedAt" TIMESTAMP(3),
    "watchFailureCode" TEXT,
    "signalVersion" INTEGER NOT NULL DEFAULT 0,
    "lastSignalAt" TIMESTAMP(3),
    "lastSignalHistoryId" TEXT,
    "lastSignalMessageId" TEXT,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailboxSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailAutomationRule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "departmentId" TEXT,
    "subscriptionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "matchJson" JSONB NOT NULL,
    "actionJson" JSONB NOT NULL,
    "destinationJson" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "pausedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailAutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "providerThreadId" TEXT,
    "historyId" TEXT NOT NULL,
    "metadataJson" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailDelivery" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
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

    CONSTRAINT "MailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnectionGovernance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "managerPolicyJson" JSONB,
    "managerConfiguredBy" TEXT,
    "managerConfiguredAt" TIMESTAMP(3),
    "adminOverrideJson" JSONB,
    "adminOverriddenBy" TEXT,
    "adminOverriddenAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnectionGovernance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyCapabilityGovernance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "policyJson" JSONB NOT NULL,
    "configuredBy" TEXT,
    "configuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyCapabilityGovernance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanySerperConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "lastTestedAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureCode" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "successfulRequestCount" INTEGER NOT NULL DEFAULT 0,
    "creditsAtLastSync" INTEGER,
    "usageAtLastCreditSync" INTEGER NOT NULL DEFAULT 0,
    "creditsSyncedAt" TIMESTAMP(3),
    "unavailableUntil" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CompanySerperConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyOmsConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "lastTestedAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureCode" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "unavailableUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyOmsConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnectionGrant" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "granteeType" TEXT NOT NULL,
    "granteeId" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "grantedBy" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnectionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesktopAuthHandoff" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopAuthHandoff_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "DesktopThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'desktop',
    "canonicalThreadKey" TEXT,
    "workspaceId" TEXT,
    "workspacePath" TEXT,
    "workspaceName" TEXT,
    "departmentId" TEXT,
    "preferredEngine" TEXT,
    "title" TEXT,
    "summaryJson" JSONB,
    "summaryUpdatedAt" TIMESTAMP(3),
    "taskStateJson" JSONB,
    "taskStateUpdatedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesktopThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LarkChatContext" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'lark',
    "chatType" TEXT,
    "summaryJson" JSONB,
    "summaryUpdatedAt" TIMESTAMP(3),
    "taskStateJson" JSONB,
    "taskStateUpdatedAt" TIMESTAMP(3),
    "recentMessagesJson" JSONB,
    "sourceMessageCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LarkChatContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesktopMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledWorkflow" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "departmentId" TEXT,
    "createdByUserId" TEXT,
    "name" TEXT NOT NULL,
    "status" "ScheduledWorkflowStatus" NOT NULL DEFAULT 'draft',
    "userIntent" TEXT NOT NULL,
    "aiDraft" TEXT,
    "workflowSpecJson" JSONB NOT NULL,
    "compiledPrompt" TEXT NOT NULL,
    "capabilitySummaryJson" JSONB NOT NULL,
    "timezone" TEXT NOT NULL,
    "scheduleType" "ScheduledWorkflowScheduleType" NOT NULL,
    "scheduleConfigJson" JSONB NOT NULL,
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "outputConfigJson" JSONB NOT NULL,
    "approvalGrantJson" JSONB,
    "publishedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledWorkflowMessage" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledWorkflowMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledWorkflowRun" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "status" "ScheduledWorkflowRunStatus" NOT NULL DEFAULT 'queued',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "executionRunId" TEXT,
    "queueJobId" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "resultSummary" TEXT,
    "errorSummary" TEXT,
    "deliveryStatusJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledWorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTokenUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "agentTarget" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "threadId" TEXT,
    "executionRunId" TEXT,
    "estimatedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "actualInputTokens" INTEGER,
    "actualOutputTokens" INTEGER,
    "cacheReadInputTokens" INTEGER,
    "cacheWriteInputTokens" INTEGER,
    "reportedCostUsd" DOUBLE PRECISION,
    "wasCompacted" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'high',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTokenUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "channel" TEXT NOT NULL,
    "entrypoint" TEXT NOT NULL,
    "requestId" TEXT,
    "taskId" TEXT,
    "threadId" TEXT,
    "chatId" TEXT,
    "messageId" TEXT,
    "mode" TEXT,
    "agentTarget" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "latestSummary" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "protectedDataObserved" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonaLearningEvidence" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "executionRunId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "PersonaLearningEvidenceStatus" NOT NULL,
    "eligibilityReason" TEXT,
    "contextJson" JSONB NOT NULL,
    "toolSummaryJson" JSONB NOT NULL,
    "runSummary" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonaLearningEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonaLearningJob" (
    "id" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "pipelineVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "status" "PersonaLearningJobStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "queueJobId" TEXT,
    "modelProvider" TEXT,
    "modelId" TEXT,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonaLearningJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonaLearningCandidate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "PersonaLearningCandidateKind" NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidenceStrength" "PersonaLearningEvidenceStrength" NOT NULL,
    "status" "PersonaLearningCandidateStatus" NOT NULL DEFAULT 'shadow',
    "promotedNodeId" TEXT,
    "promotedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonaLearningCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerPersonaTree" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagerPersonaTree_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerPersonaRevision" (
    "id" TEXT NOT NULL,
    "treeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagerPersonaRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerPersonaNode" (
    "id" TEXT NOT NULL,
    "treeId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "kind" "PersonaLearningCandidateKind" NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceCount" INTEGER NOT NULL,
    "firstEvidenceAt" TIMESTAMP(3) NOT NULL,
    "lastEvidenceAt" TIMESTAMP(3) NOT NULL,
    "status" "ManagerPersonaNodeStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagerPersonaNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerPersonaSkillLink" (
    "personaNodeId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagerPersonaSkillLink_pkey" PRIMARY KEY ("personaNodeId","skillId")
);

-- CreateTable
CREATE TABLE "ManagerTeachSession" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "source" "ManagerTeachSource" NOT NULL,
    "status" "ManagerTeachSessionStatus" NOT NULL DEFAULT 'awaiting_upload',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "originalFileName" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "queueJobId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "parentSessionId" TEXT,
    "managerCorrection" TEXT,
    "agentMutationKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagerTeachSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerTeachPersonaMutation" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "treeId" TEXT,
    "baseRevision" INTEGER,
    "appliedRevision" INTEGER,
    "evidenceHash" TEXT NOT NULL,
    "modelProvider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "status" "ManagerTeachPersonaMutationStatus" NOT NULL,
    "understanding" TEXT NOT NULL,
    "patchJson" JSONB NOT NULL,
    "appliedChangeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagerTeachPersonaMutation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerLearningProvenance" (
    "id" TEXT NOT NULL,
    "teachSessionId" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "personaNodeId" TEXT,
    "skillId" TEXT,
    "decision" "ManagerLearningDecision" NOT NULL,
    "evidenceRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rationale" TEXT NOT NULL,
    "priorStateJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagerLearningProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerTeachArtifact" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "ManagerTeachArtifactKind" NOT NULL,
    "status" "ManagerTeachArtifactStatus" NOT NULL DEFAULT 'available',
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagerTeachArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionEvent" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorKey" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepResult" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "actorKey" TEXT,
    "title" TEXT,
    "success" BOOLEAN NOT NULL,
    "status" TEXT,
    "authorityLevel" TEXT,
    "resolvedIds" JSONB,
    "entityIndexes" JSONB,
    "summary" TEXT,
    "rawOutput" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeConversation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "departmentId" TEXT,
    "channel" TEXT NOT NULL,
    "channelConversationKey" TEXT NOT NULL,
    "rawChannelKey" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdByEmail" TEXT,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "refsJson" JSONB,
    "lastMessageSequence" INTEGER NOT NULL DEFAULT 0,
    "historyRevision" INTEGER NOT NULL DEFAULT 0,
    "summaryJson" JSONB,
    "summaryUpdatedAt" TIMESTAMP(3),
    "lastSummarizedSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeConversationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "runId" TEXT,
    "sequence" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "messageKind" TEXT NOT NULL,
    "sourceChannel" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "sourceRunId" TEXT,
    "dedupeKey" TEXT,
    "contentText" TEXT,
    "contentJson" JSONB,
    "attachmentsJson" JSONB,
    "toolCallJson" JSONB,
    "toolResultJson" JSONB,
    "visibility" TEXT NOT NULL DEFAULT 'internal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuntimeConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimePendingAttachment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "descriptorJson" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuntimePendingAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeRun" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "parentRunId" TEXT,
    "engine" TEXT NOT NULL DEFAULT 'langgraph',
    "engineMode" TEXT NOT NULL DEFAULT 'primary',
    "channel" TEXT NOT NULL,
    "entrypoint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "currentNode" TEXT,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "maxSteps" INTEGER NOT NULL DEFAULT 12,
    "stopReason" TEXT,
    "errorJson" JSONB,
    "traceJson" JSONB,
    "metadataJson" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeApproval" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "externalActionId" TEXT,
    "toolId" TEXT NOT NULL,
    "actionGroup" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "subject" TEXT,
    "payloadJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "riskLevel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "channel" TEXT NOT NULL,
    "requestedBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "executionResultJson" JSONB,
    "idempotencyKey" TEXT,
    "decisionMessageId" TEXT,
    "resolutionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeResource" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "KnowledgeResourceKind" NOT NULL,
    "scope" "KnowledgeResourceScope" NOT NULL,
    "targetKey" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "departmentId" TEXT,
    "logicalKey" TEXT NOT NULL,
    "status" "KnowledgeResourceStatus" NOT NULL DEFAULT 'draft',
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeFileAsset" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "knowledgeResourceId" TEXT,
    "provider" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "deliveryType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "inspectionVersion" TEXT NOT NULL DEFAULT 'strict-v1',
    "inspectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "threatScanProvider" TEXT,
    "threatScanVersion" TEXT,
    "threatScannedAt" TIMESTAMP(3),
    "status" "KnowledgeFileAssetStatus" NOT NULL DEFAULT 'staged',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attachedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletionLeaseToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeFileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeFileDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceVersion" INTEGER NOT NULL,
    "fileAssetId" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "status" "KnowledgeFileDocumentStatus" NOT NULL DEFAULT 'processing',
    "pageCount" INTEGER,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "warningsJson" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lockToken" TEXT,
    "indexedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeFileDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeFileChunk" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceVersion" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "sectionPath" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "tokenEstimate" INTEGER NOT NULL,
    "searchVector" tsvector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeFileChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeVersion" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentJson" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "searchText" TEXT,
    "searchVector" tsvector,
    "evidenceJson" JSONB,
    "sourceType" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeMutation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "resourceId" TEXT,
    "kind" "KnowledgeResourceKind" NOT NULL,
    "scope" "KnowledgeResourceScope" NOT NULL,
    "targetKey" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "departmentId" TEXT,
    "logicalKey" TEXT NOT NULL,
    "action" "KnowledgeMutationAction" NOT NULL,
    "baseVersion" INTEGER,
    "proposedContentJson" JSONB,
    "proposedContentHash" TEXT,
    "evidenceJson" JSONB,
    "sourceType" TEXT NOT NULL,
    "sourceRef" TEXT,
    "requesterId" TEXT NOT NULL,
    "requesterReviewRequired" BOOLEAN NOT NULL,
    "requesterReviewedAt" TIMESTAMP(3),
    "requiredAuthority" "KnowledgeApprovalAuthority" NOT NULL,
    "distinctApprover" BOOLEAN NOT NULL DEFAULT true,
    "policyId" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "runtimeApprovalId" TEXT,
    "appliedVersionId" TEXT,
    "fileAssetId" TEXT,
    "status" "KnowledgeMutationStatus" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "rejectionReason" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "KnowledgeMutation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgePolicy" (
    "id" TEXT NOT NULL,
    "tenantKey" TEXT NOT NULL DEFAULT 'global',
    "kind" "KnowledgeResourceKind" NOT NULL,
    "scope" "KnowledgeResourceScope" NOT NULL,
    "action" "KnowledgeMutationAction" NOT NULL,
    "requesterReviewRequired" BOOLEAN NOT NULL,
    "requiredAuthority" "KnowledgeApprovalAuthority" NOT NULL,
    "distinctApprover" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeOutbox" (
    "id" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "KnowledgeOutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeLearningJob" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "companyRole" TEXT NOT NULL,
    "userMessages" JSONB NOT NULL,
    "assistantText" TEXT,
    "pipelineVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "KnowledgeLearningJobStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "modelProvider" TEXT,
    "modelId" TEXT,
    "outcomesJson" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeLearningJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberTokenPolicy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "monthlyTokenLimit" INTEGER NOT NULL DEFAULT 2000000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberTokenPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberProxyPolicy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "monthlyBudgetUsd" DOUBLE PRECISION,
    "rateLimitRpm" INTEGER,
    "allowedModels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberProxyPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProxyProviderKey" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'deepseek',
    "scope" TEXT NOT NULL,
    "companyId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProxyProviderKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProxyRequestLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "executionRunId" TEXT,
    "model" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'desktop',
    "provider" TEXT NOT NULL DEFAULT 'deepseek',
    "agentTarget" TEXT NOT NULL DEFAULT 'pi',
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "httpStatus" INTEGER NOT NULL,
    "cacheHitTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheMissTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "keySource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProxyRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RegisteredTool_toolId_key" ON "RegisteredTool"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "UserDepartmentPreference_userId_key" ON "UserDepartmentPreference"("userId");

-- CreateIndex
CREATE INDEX "UserDepartmentPreference_userId_companyId_idx" ON "UserDepartmentPreference"("userId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "UserDepartmentPreference_companyId_userId_key" ON "UserDepartmentPreference"("companyId", "userId");

-- CreateIndex
CREATE INDEX "AdminMembership_userId_role_isActive_idx" ON "AdminMembership"("userId", "role", "isActive");

-- CreateIndex
CREATE INDEX "AdminMembership_companyId_role_isActive_idx" ON "AdminMembership"("companyId", "role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_sessionId_key" ON "AdminSession"("sessionId");

-- CreateIndex
CREATE INDEX "AdminSession_userId_role_expiresAt_idx" ON "AdminSession"("userId", "role", "expiresAt");

-- CreateIndex
CREATE INDEX "AdminSession_companyId_role_expiresAt_idx" ON "AdminSession"("companyId", "role", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ZohoConnection_companyId_environment_key" ON "ZohoConnection"("companyId", "environment");

-- CreateIndex
CREATE INDEX "ZohoConnectionProfile_companyId_isActive_status_idx" ON "ZohoConnectionProfile"("companyId", "isActive", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ZohoConnectionProfile_companyId_profileName_key" ON "ZohoConnectionProfile"("companyId", "profileName");

-- CreateIndex
CREATE UNIQUE INDEX "ZohoOAuthConfig_companyId_key" ON "ZohoOAuthConfig"("companyId");

-- CreateIndex
CREATE INDEX "ChannelIdentity_companyId_larkOpenId_idx" ON "ChannelIdentity"("companyId", "larkOpenId");

-- CreateIndex
CREATE INDEX "ChannelIdentity_companyId_larkUserId_idx" ON "ChannelIdentity"("companyId", "larkUserId");

-- CreateIndex
CREATE INDEX "ChannelIdentity_companyId_channel_idx" ON "ChannelIdentity"("companyId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelIdentity_channel_externalTenantId_externalUserId_com_key" ON "ChannelIdentity"("channel", "externalTenantId", "externalUserId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "LarkWorkspaceConfig_companyId_key" ON "LarkWorkspaceConfig"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "LarkOperationalConfig_companyId_key" ON "LarkOperationalConfig"("companyId");

-- CreateIndex
CREATE INDEX "LarkDirectorySyncRun_companyId_createdAt_idx" ON "LarkDirectorySyncRun"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "LarkDirectorySyncRun_companyId_status_createdAt_idx" ON "LarkDirectorySyncRun"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "LarkTenantBinding_companyId_isActive_idx" ON "LarkTenantBinding"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "LarkTenantBinding_larkTenantKey_key" ON "LarkTenantBinding"("larkTenantKey");

-- CreateIndex
CREATE INDEX "McpActionLog_companyId_createdAt_idx" ON "McpActionLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "McpActionLog_taskId_createdAt_idx" ON "McpActionLog"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "ZohoSyncJob_companyId_status_idx" ON "ZohoSyncJob"("companyId", "status");

-- CreateIndex
CREATE INDEX "ZohoSyncJob_connectionId_jobType_status_idx" ON "ZohoSyncJob"("connectionId", "jobType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ZohoDeltaEvent_eventKey_key" ON "ZohoDeltaEvent"("eventKey");

-- CreateIndex
CREATE INDEX "ZohoDeltaEvent_companyId_status_idx" ON "ZohoDeltaEvent"("companyId", "status");

-- CreateIndex
CREATE INDEX "ZohoSyncJobEvent_jobId_createdAt_idx" ON "ZohoSyncJobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundArtifact_companyId_createdAt_idx" ON "OutboundArtifact"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundArtifact_companyId_sourceSystem_sourceKind_idx" ON "OutboundArtifact"("companyId", "sourceSystem", "sourceKind");

-- CreateIndex
CREATE INDEX "OutboundArtifact_companyId_sourceRecordType_sourceRecordId_idx" ON "OutboundArtifact"("companyId", "sourceRecordType", "sourceRecordId");

-- CreateIndex
CREATE INDEX "ChannelDelivery_channel_status_nextAttemptAt_idx" ON "ChannelDelivery"("channel", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ChannelDelivery_runKey_idx" ON "ChannelDelivery"("runKey");

-- CreateIndex
CREATE INDEX "ChannelDelivery_channel_status_firstAttemptAt_idx" ON "ChannelDelivery"("channel", "status", "firstAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelDelivery_channel_idempotencyKey_key" ON "ChannelDelivery"("channel", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ExecutionLaneLease_channel_expiresAt_idx" ON "ExecutionLaneLease"("channel", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionLaneLease_channel_laneKey_key" ON "ExecutionLaneLease"("channel", "laneKey");

-- CreateIndex
CREATE INDEX "IngressIdempotencyKey_channel_createdAt_idx" ON "IngressIdempotencyKey"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "IngressIdempotencyKey_channel_tenantKey_eventId_idx" ON "IngressIdempotencyKey"("channel", "tenantKey", "eventId");

-- CreateIndex
CREATE INDEX "IngressIdempotencyKey_status_createdAt_idx" ON "IngressIdempotencyKey"("status", "createdAt");

-- CreateIndex
CREATE INDEX "IngressIdempotencyKey_channel_status_acceptedAt_idx" ON "IngressIdempotencyKey"("channel", "status", "acceptedAt");

-- CreateIndex
CREATE INDEX "IngressIdempotencyKey_channel_laneKey_status_acceptedAt_idx" ON "IngressIdempotencyKey"("channel", "laneKey", "status", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IngressIdempotencyKey_channel_tenantKey_messageId_key" ON "IngressIdempotencyKey"("channel", "tenantKey", "messageId");

-- CreateIndex
CREATE INDEX "RbacPermission_role_allowed_idx" ON "RbacPermission"("role", "allowed");

-- CreateIndex
CREATE UNIQUE INDEX "RbacPermission_role_action_key" ON "RbacPermission"("role", "action");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "AuditLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AdminControlState_companyId_updatedAt_idx" ON "AdminControlState"("companyId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminControlState_controlKey_companyId_key" ON "AdminControlState"("controlKey", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyInvite_token_key" ON "CompanyInvite"("token");

-- CreateIndex
CREATE INDEX "CompanyInvite_companyId_status_createdAt_idx" ON "CompanyInvite"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Department_companyId_status_updatedAt_idx" ON "Department"("companyId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Department_companyId_slug_key" ON "Department"("companyId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Department_id_companyId_key" ON "Department"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_knowledgeResourceId_key" ON "Skill"("knowledgeResourceId");

-- CreateIndex
CREATE INDEX "Skill_companyId_scope_status_sortOrder_idx" ON "Skill"("companyId", "scope", "status", "sortOrder");

-- CreateIndex
CREATE INDEX "Skill_departmentId_status_sortOrder_idx" ON "Skill"("departmentId", "status", "sortOrder");

-- CreateIndex
CREATE INDEX "Skill_folderId_status_sortOrder_idx" ON "Skill"("folderId", "status", "sortOrder");

-- CreateIndex
CREATE INDEX "Skill_companyId_scope_slug_idx" ON "Skill"("companyId", "scope", "slug");

-- CreateIndex
CREATE INDEX "SkillRoute_routerSkillId_sortOrder_idx" ON "SkillRoute"("routerSkillId", "sortOrder");

-- CreateIndex
CREATE INDEX "SkillRoute_targetSkillId_idx" ON "SkillRoute"("targetSkillId");

-- CreateIndex
CREATE INDEX "SkillFolder_companyId_departmentId_parentId_status_sortOrde_idx" ON "SkillFolder"("companyId", "departmentId", "parentId", "status", "sortOrder");

-- CreateIndex
CREATE INDEX "SkillVersion_skillId_createdAt_idx" ON "SkillVersion"("skillId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SkillVersion_skillId_revision_key" ON "SkillVersion"("skillId", "revision");

-- CreateIndex
CREATE INDEX "SkillAlias_alias_idx" ON "SkillAlias"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "SkillAlias_skillId_alias_key" ON "SkillAlias"("skillId", "alias");

-- CreateIndex
CREATE INDEX "SkillCapability_toolId_requirement_idx" ON "SkillCapability"("toolId", "requirement");

-- CreateIndex
CREATE UNIQUE INDEX "SkillCapability_skillId_toolId_actionGroup_key" ON "SkillCapability"("skillId", "toolId", "actionGroup");

-- CreateIndex
CREATE INDEX "SkillAccessGrant_companyId_granteeType_granteeId_idx" ON "SkillAccessGrant"("companyId", "granteeType", "granteeId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillAccessGrant_skillId_granteeType_granteeId_key" ON "SkillAccessGrant"("skillId", "granteeType", "granteeId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentAgentConfig_departmentId_key" ON "DepartmentAgentConfig"("departmentId");

-- CreateIndex
CREATE INDEX "DepartmentAgentConfig_departmentId_isActive_idx" ON "DepartmentAgentConfig"("departmentId", "isActive");

-- CreateIndex
CREATE INDEX "DepartmentRole_departmentId_isSystem_updatedAt_idx" ON "DepartmentRole"("departmentId", "isSystem", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentRole_departmentId_slug_key" ON "DepartmentRole"("departmentId", "slug");

-- CreateIndex
CREATE INDEX "BooksModulePermission_companyId_departmentRoleId_idx" ON "BooksModulePermission"("companyId", "departmentRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "BooksModulePermission_companyId_departmentRoleId_module_key" ON "BooksModulePermission"("companyId", "departmentRoleId", "module");

-- CreateIndex
CREATE INDEX "DepartmentMembership_departmentId_status_updatedAt_idx" ON "DepartmentMembership"("departmentId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "DepartmentMembership_userId_status_updatedAt_idx" ON "DepartmentMembership"("userId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "DepartmentMembership_roleId_status_idx" ON "DepartmentMembership"("roleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentMembership_departmentId_userId_key" ON "DepartmentMembership"("departmentId", "userId");

-- CreateIndex
CREATE INDEX "DepartmentToolPermission_departmentId_roleId_idx" ON "DepartmentToolPermission"("departmentId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentToolPermission_departmentId_roleId_toolId_actionG_key" ON "DepartmentToolPermission"("departmentId", "roleId", "toolId", "actionGroup");

-- CreateIndex
CREATE INDEX "DepartmentUserToolOverride_departmentId_userId_idx" ON "DepartmentUserToolOverride"("departmentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentUserToolOverride_departmentId_userId_toolId_actio_key" ON "DepartmentUserToolOverride"("departmentId", "userId", "toolId", "actionGroup");

-- CreateIndex
CREATE INDEX "ToolPermission_companyId_toolId_idx" ON "ToolPermission"("companyId", "toolId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolPermission_companyId_toolId_role_key" ON "ToolPermission"("companyId", "toolId", "role");

-- CreateIndex
CREATE INDEX "ToolActionPermission_companyId_toolId_idx" ON "ToolActionPermission"("companyId", "toolId");

-- CreateIndex
CREATE INDEX "ToolActionPermission_companyId_role_idx" ON "ToolActionPermission"("companyId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ToolActionPermission_companyId_toolId_role_actionGroup_key" ON "ToolActionPermission"("companyId", "toolId", "role", "actionGroup");

-- CreateIndex
CREATE INDEX "ZohoRoleAccessPolicy_companyId_role_idx" ON "ZohoRoleAccessPolicy"("companyId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ZohoRoleAccessPolicy_companyId_role_key" ON "ZohoRoleAccessPolicy"("companyId", "role");

-- CreateIndex
CREATE INDEX "AiRoleDefinition_companyId_isBuiltIn_idx" ON "AiRoleDefinition"("companyId", "isBuiltIn");

-- CreateIndex
CREATE UNIQUE INDEX "AiRoleDefinition_companyId_slug_key" ON "AiRoleDefinition"("companyId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "AiModelTargetConfig_targetKey_key" ON "AiModelTargetConfig"("targetKey");

-- CreateIndex
CREATE INDEX "AiModelTargetConfig_updatedAt_idx" ON "AiModelTargetConfig"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemberSession_sessionId_key" ON "MemberSession"("sessionId");

-- CreateIndex
CREATE INDEX "MemberSession_userId_channel_expiresAt_idx" ON "MemberSession"("userId", "channel", "expiresAt");

-- CreateIndex
CREATE INDEX "MemberSession_companyId_channel_expiresAt_idx" ON "MemberSession"("companyId", "channel", "expiresAt");

-- CreateIndex
CREATE INDEX "MemberSession_companyId_larkOpenId_idx" ON "MemberSession"("companyId", "larkOpenId");

-- CreateIndex
CREATE INDEX "LarkUserAuthLink_companyId_larkTenantKey_idx" ON "LarkUserAuthLink"("companyId", "larkTenantKey");

-- CreateIndex
CREATE INDEX "LarkUserAuthLink_companyId_larkEmail_idx" ON "LarkUserAuthLink"("companyId", "larkEmail");

-- CreateIndex
CREATE UNIQUE INDEX "LarkUserAuthLink_userId_companyId_key" ON "LarkUserAuthLink"("userId", "companyId");

-- CreateIndex
CREATE INDEX "IntegrationConnection_companyId_provider_status_idx" ON "IntegrationConnection"("companyId", "provider", "status");

-- CreateIndex
CREATE INDEX "IntegrationConnection_companyId_provider_accountEmail_idx" ON "IntegrationConnection"("companyId", "provider", "accountEmail");

-- CreateIndex
CREATE INDEX "IntegrationConnection_companyId_ownerUserId_idx" ON "IntegrationConnection"("companyId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_companyId_dedupeKey_key" ON "IntegrationConnection"("companyId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_id_companyId_ownerUserId_key" ON "IntegrationConnection"("id", "companyId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationOAuthAttempt_stateHash_key" ON "IntegrationOAuthAttempt"("stateHash");

-- CreateIndex
CREATE INDEX "IntegrationOAuthAttempt_companyId_provider_status_expiresAt_idx" ON "IntegrationOAuthAttempt"("companyId", "provider", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "IntegrationOAuthAttempt_status_expiresAt_idx" ON "IntegrationOAuthAttempt"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "IntegrationWebhookReceipt_provider_accountId_receivedAt_idx" ON "IntegrationWebhookReceipt"("provider", "accountId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationWebhookReceipt_provider_webhookId_key" ON "IntegrationWebhookReceipt"("provider", "webhookId");

-- CreateIndex
CREATE INDEX "ShopifyPrivacyRequest_companyId_shopDomain_state_createdAt_idx" ON "ShopifyPrivacyRequest"("companyId", "shopDomain", "state", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyPrivacyRequest_companyId_customerIdHash_state_idx" ON "ShopifyPrivacyRequest"("companyId", "customerIdHash", "state");

-- CreateIndex
CREATE INDEX "ShopifyPrivacyRequest_state_expiresAt_idx" ON "ShopifyPrivacyRequest"("state", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyPrivacyRequest_companyId_shopDomain_requestId_key" ON "ShopifyPrivacyRequest"("companyId", "shopDomain", "requestId");

-- CreateIndex
CREATE INDEX "ShopifyRunProvenance_companyId_shopDomain_createdAt_idx" ON "ShopifyRunProvenance"("companyId", "shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyRunProvenance_connectionId_createdAt_idx" ON "ShopifyRunProvenance"("connectionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyRunProvenance_executionRunId_connectionId_toolId_key" ON "ShopifyRunProvenance"("executionRunId", "connectionId", "toolId");

-- CreateIndex
CREATE INDEX "ShopifyRunErasureFence_createdAt_idx" ON "ShopifyRunErasureFence"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyRunErasureFence_companyId_sourceId_key" ON "ShopifyRunErasureFence"("companyId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionAuthorizationIntent_stateHash_key" ON "ConnectionAuthorizationIntent"("stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionAuthorizationIntent_activeDedupeKey_key" ON "ConnectionAuthorizationIntent"("activeDedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionAuthorizationIntent_continuationIdempotencyKey_key" ON "ConnectionAuthorizationIntent"("continuationIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionAuthorizationIntent_correlationId_key" ON "ConnectionAuthorizationIntent"("correlationId");

-- CreateIndex
CREATE INDEX "ConnectionAuthorizationIntent_companyId_userId_provider_sta_idx" ON "ConnectionAuthorizationIntent"("companyId", "userId", "provider", "status");

-- CreateIndex
CREATE INDEX "ConnectionAuthorizationIntent_status_expiresAt_idx" ON "ConnectionAuthorizationIntent"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ConnectionAuthorizationIntent_continuationStatus_continuati_idx" ON "ConnectionAuthorizationIntent"("continuationStatus", "continuationQueuedAt");

-- CreateIndex
CREATE INDEX "ConnectionAuthorizationIntent_connectionId_idx" ON "ConnectionAuthorizationIntent"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxSubscription_connectionId_key" ON "MailboxSubscription"("connectionId");

-- CreateIndex
CREATE INDEX "MailboxSubscription_status_nextPollAt_idx" ON "MailboxSubscription"("status", "nextPollAt");

-- CreateIndex
CREATE INDEX "MailboxSubscription_status_nextWatchRenewalAt_idx" ON "MailboxSubscription"("status", "nextWatchRenewalAt");

-- CreateIndex
CREATE INDEX "MailboxSubscription_claimedAt_idx" ON "MailboxSubscription"("claimedAt");

-- CreateIndex
CREATE INDEX "MailboxSubscription_companyId_userId_status_idx" ON "MailboxSubscription"("companyId", "userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxSubscription_connectionId_companyId_userId_key" ON "MailboxSubscription"("connectionId", "companyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxSubscription_id_companyId_key" ON "MailboxSubscription"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxSubscription_id_companyId_userId_key" ON "MailboxSubscription"("id", "companyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MailAutomationRule_dedupeKey_key" ON "MailAutomationRule"("dedupeKey");

-- CreateIndex
CREATE INDEX "MailAutomationRule_companyId_createdByUserId_status_idx" ON "MailAutomationRule"("companyId", "createdByUserId", "status");

-- CreateIndex
CREATE INDEX "MailAutomationRule_subscriptionId_status_idx" ON "MailAutomationRule"("subscriptionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MailAutomationRule_id_companyId_subscriptionId_key" ON "MailAutomationRule"("id", "companyId", "subscriptionId");

-- CreateIndex
CREATE INDEX "MailEvent_companyId_createdAt_idx" ON "MailEvent"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "MailEvent_subscriptionId_historyId_idx" ON "MailEvent"("subscriptionId", "historyId");

-- CreateIndex
CREATE UNIQUE INDEX "MailEvent_subscriptionId_providerMessageId_key" ON "MailEvent"("subscriptionId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "MailEvent_id_companyId_subscriptionId_key" ON "MailEvent"("id", "companyId", "subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "MailDelivery_idempotencyKey_key" ON "MailDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MailDelivery_companyId_status_nextAttemptAt_idx" ON "MailDelivery"("companyId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "MailDelivery_eventId_idx" ON "MailDelivery"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "MailDelivery_ruleId_eventId_key" ON "MailDelivery"("ruleId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnectionGovernance_connectionId_key" ON "IntegrationConnectionGovernance"("connectionId");

-- CreateIndex
CREATE INDEX "IntegrationConnectionGovernance_companyId_updatedAt_idx" ON "IntegrationConnectionGovernance"("companyId", "updatedAt");

-- CreateIndex
CREATE INDEX "CompanyCapabilityGovernance_companyId_updatedAt_idx" ON "CompanyCapabilityGovernance"("companyId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyCapabilityGovernance_companyId_capabilityId_key" ON "CompanyCapabilityGovernance"("companyId", "capabilityId");

-- CreateIndex
CREATE INDEX "CompanySerperConnection_companyId_status_priority_idx" ON "CompanySerperConnection"("companyId", "status", "priority");

-- CreateIndex
CREATE INDEX "CompanySerperConnection_companyId_status_unavailableUntil_idx" ON "CompanySerperConnection"("companyId", "status", "unavailableUntil");

-- CreateIndex
CREATE UNIQUE INDEX "CompanySerperConnection_companyId_keyFingerprint_key" ON "CompanySerperConnection"("companyId", "keyFingerprint");

-- CreateIndex
CREATE INDEX "CompanyOmsConnection_companyId_status_unavailableUntil_idx" ON "CompanyOmsConnection"("companyId", "status", "unavailableUntil");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyOmsConnection_companyId_keyFingerprint_key" ON "CompanyOmsConnection"("companyId", "keyFingerprint");

-- CreateIndex
CREATE INDEX "IntegrationConnectionGrant_companyId_granteeType_granteeId__idx" ON "IntegrationConnectionGrant"("companyId", "granteeType", "granteeId", "revokedAt");

-- CreateIndex
CREATE INDEX "IntegrationConnectionGrant_companyId_connectionId_revokedAt_idx" ON "IntegrationConnectionGrant"("companyId", "connectionId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnectionGrant_connectionId_granteeType_grantee_key" ON "IntegrationConnectionGrant"("connectionId", "granteeType", "granteeId");

-- CreateIndex
CREATE UNIQUE INDEX "DesktopAuthHandoff_code_key" ON "DesktopAuthHandoff"("code");

-- CreateIndex
CREATE INDEX "DesktopAuthHandoff_code_expiresAt_idx" ON "DesktopAuthHandoff"("code", "expiresAt");

-- CreateIndex
CREATE INDEX "DesktopWorkspace_userId_companyId_updatedAt_idx" ON "DesktopWorkspace"("userId", "companyId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DesktopWorkspace_companyId_userId_path_key" ON "DesktopWorkspace"("companyId", "userId", "path");

-- CreateIndex
CREATE INDEX "DesktopThread_userId_companyId_channel_updatedAt_idx" ON "DesktopThread"("userId", "companyId", "channel", "updatedAt");

-- CreateIndex
CREATE INDEX "DesktopThread_workspaceId_updatedAt_idx" ON "DesktopThread"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "DesktopThread_departmentId_channel_updatedAt_idx" ON "DesktopThread"("departmentId", "channel", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DesktopThread_companyId_userId_channel_canonicalThreadKey_key" ON "DesktopThread"("companyId", "userId", "channel", "canonicalThreadKey");

-- CreateIndex
CREATE INDEX "LarkChatContext_companyId_channel_updatedAt_idx" ON "LarkChatContext"("companyId", "channel", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LarkChatContext_companyId_channel_chatId_key" ON "LarkChatContext"("companyId", "channel", "chatId");

-- CreateIndex
CREATE INDEX "DesktopMessage_threadId_createdAt_idx" ON "DesktopMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduledWorkflow_companyId_status_updatedAt_idx" ON "ScheduledWorkflow"("companyId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "ScheduledWorkflow_companyId_status_nextRunAt_idx" ON "ScheduledWorkflow"("companyId", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduledWorkflow_departmentId_status_updatedAt_idx" ON "ScheduledWorkflow"("departmentId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "ScheduledWorkflow_status_nextRunAt_idx" ON "ScheduledWorkflow"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduledWorkflow_claimedAt_idx" ON "ScheduledWorkflow"("claimedAt");

-- CreateIndex
CREATE INDEX "ScheduledWorkflowMessage_workflowId_createdAt_idx" ON "ScheduledWorkflowMessage"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduledWorkflowRun_workflowId_createdAt_idx" ON "ScheduledWorkflowRun"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduledWorkflowRun_status_scheduledFor_idx" ON "ScheduledWorkflowRun"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ScheduledWorkflowRun_executionRunId_idx" ON "ScheduledWorkflowRun"("executionRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledWorkflowRun_workflowId_scheduledFor_key" ON "ScheduledWorkflowRun"("workflowId", "scheduledFor");

-- CreateIndex
CREATE INDEX "AiTokenUsage_userId_companyId_createdAt_idx" ON "AiTokenUsage"("userId", "companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AiTokenUsage_companyId_createdAt_idx" ON "AiTokenUsage"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AiTokenUsage_userId_createdAt_idx" ON "AiTokenUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiTokenUsage_companyId_modelId_createdAt_idx" ON "AiTokenUsage"("companyId", "modelId", "createdAt");

-- CreateIndex
CREATE INDEX "AiTokenUsage_executionRunId_idx" ON "AiTokenUsage"("executionRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionRun_requestId_key" ON "ExecutionRun"("requestId");

-- CreateIndex
CREATE INDEX "ExecutionRun_companyId_startedAt_idx" ON "ExecutionRun"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_userId_startedAt_idx" ON "ExecutionRun"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_channel_startedAt_idx" ON "ExecutionRun"("channel", "startedAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_mode_startedAt_idx" ON "ExecutionRun"("mode", "startedAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_status_startedAt_idx" ON "ExecutionRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_taskId_idx" ON "ExecutionRun"("taskId");

-- CreateIndex
CREATE INDEX "ExecutionRun_threadId_idx" ON "ExecutionRun"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonaLearningEvidence_executionRunId_key" ON "PersonaLearningEvidence"("executionRunId");

-- CreateIndex
CREATE INDEX "PersonaLearningEvidence_companyId_departmentId_managerId_ca_idx" ON "PersonaLearningEvidence"("companyId", "departmentId", "managerId", "capturedAt");

-- CreateIndex
CREATE INDEX "PersonaLearningEvidence_status_capturedAt_idx" ON "PersonaLearningEvidence"("status", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonaLearningJob_idempotencyKey_key" ON "PersonaLearningJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PersonaLearningJob_status_createdAt_idx" ON "PersonaLearningJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonaLearningJob_evidenceId_pipelineVersion_key" ON "PersonaLearningJob"("evidenceId", "pipelineVersion");

-- CreateIndex
CREATE INDEX "PersonaLearningCandidate_companyId_departmentId_managerId_s_idx" ON "PersonaLearningCandidate"("companyId", "departmentId", "managerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PersonaLearningCandidate_evidenceId_idx" ON "PersonaLearningCandidate"("evidenceId");

-- CreateIndex
CREATE INDEX "PersonaLearningCandidate_status_ruleKey_createdAt_idx" ON "PersonaLearningCandidate"("status", "ruleKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonaLearningCandidate_jobId_ordinal_key" ON "PersonaLearningCandidate"("jobId", "ordinal");

-- CreateIndex
CREATE INDEX "ManagerPersonaTree_companyId_departmentId_updatedAt_idx" ON "ManagerPersonaTree"("companyId", "departmentId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerPersonaTree_companyId_managerId_departmentId_key" ON "ManagerPersonaTree"("companyId", "managerId", "departmentId");

-- CreateIndex
CREATE INDEX "ManagerPersonaRevision_treeId_createdAt_idx" ON "ManagerPersonaRevision"("treeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerPersonaRevision_treeId_revision_key" ON "ManagerPersonaRevision"("treeId", "revision");

-- CreateIndex
CREATE INDEX "ManagerPersonaNode_companyId_departmentId_managerId_status__idx" ON "ManagerPersonaNode"("companyId", "departmentId", "managerId", "status", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerPersonaNode_treeId_kind_scopeKey_ruleKey_key" ON "ManagerPersonaNode"("treeId", "kind", "scopeKey", "ruleKey");

-- CreateIndex
CREATE INDEX "ManagerPersonaSkillLink_skillId_idx" ON "ManagerPersonaSkillLink"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerTeachSession_agentMutationKey_key" ON "ManagerTeachSession"("agentMutationKey");

-- CreateIndex
CREATE INDEX "ManagerTeachSession_companyId_departmentId_managerId_create_idx" ON "ManagerTeachSession"("companyId", "departmentId", "managerId", "createdAt");

-- CreateIndex
CREATE INDEX "ManagerTeachSession_parentSessionId_createdAt_idx" ON "ManagerTeachSession"("parentSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ManagerTeachSession_status_createdAt_idx" ON "ManagerTeachSession"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerTeachPersonaMutation_sessionId_key" ON "ManagerTeachPersonaMutation"("sessionId");

-- CreateIndex
CREATE INDEX "ManagerTeachPersonaMutation_treeId_createdAt_idx" ON "ManagerTeachPersonaMutation"("treeId", "createdAt");

-- CreateIndex
CREATE INDEX "ManagerTeachPersonaMutation_status_createdAt_idx" ON "ManagerTeachPersonaMutation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ManagerLearningProvenance_teachSessionId_createdAt_idx" ON "ManagerLearningProvenance"("teachSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ManagerLearningProvenance_mutationId_idx" ON "ManagerLearningProvenance"("mutationId");

-- CreateIndex
CREATE INDEX "ManagerLearningProvenance_personaNodeId_createdAt_idx" ON "ManagerLearningProvenance"("personaNodeId", "createdAt");

-- CreateIndex
CREATE INDEX "ManagerLearningProvenance_skillId_createdAt_idx" ON "ManagerLearningProvenance"("skillId", "createdAt");

-- CreateIndex
CREATE INDEX "ManagerTeachArtifact_status_expiresAt_idx" ON "ManagerTeachArtifact"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerTeachArtifact_sessionId_kind_key" ON "ManagerTeachArtifact"("sessionId", "kind");

-- CreateIndex
CREATE INDEX "ExecutionEvent_executionId_createdAt_idx" ON "ExecutionEvent"("executionId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionEvent_createdAt_idx" ON "ExecutionEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionEvent_executionId_sequence_key" ON "ExecutionEvent"("executionId", "sequence");

-- CreateIndex
CREATE INDEX "StepResult_executionId_createdAt_idx" ON "StepResult"("executionId", "createdAt");

-- CreateIndex
CREATE INDEX "StepResult_createdAt_idx" ON "StepResult"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StepResult_executionId_sequence_key" ON "StepResult"("executionId", "sequence");

-- CreateIndex
CREATE INDEX "RuntimeConversation_companyId_updatedAt_idx" ON "RuntimeConversation"("companyId", "updatedAt");

-- CreateIndex
CREATE INDEX "RuntimeConversation_companyId_channel_updatedAt_idx" ON "RuntimeConversation"("companyId", "channel", "updatedAt");

-- CreateIndex
CREATE INDEX "RuntimeConversation_departmentId_updatedAt_idx" ON "RuntimeConversation"("departmentId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeConversation_companyId_channel_channelConversationKe_key" ON "RuntimeConversation"("companyId", "channel", "channelConversationKey");

-- CreateIndex
CREATE INDEX "RuntimeConversationMessage_conversationId_createdAt_idx" ON "RuntimeConversationMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "RuntimeConversationMessage_runId_createdAt_idx" ON "RuntimeConversationMessage"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "RuntimeConversationMessage_sourceRunId_createdAt_idx" ON "RuntimeConversationMessage"("sourceRunId", "createdAt");

-- CreateIndex
CREATE INDEX "RuntimeConversationMessage_dedupeKey_idx" ON "RuntimeConversationMessage"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeConversationMessage_conversationId_sequence_key" ON "RuntimeConversationMessage"("conversationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeConversationMessage_conversationId_dedupeKey_key" ON "RuntimeConversationMessage"("conversationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "RuntimePendingAttachment_companyId_userId_channel_conversat_idx" ON "RuntimePendingAttachment"("companyId", "userId", "channel", "conversationKey", "consumedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "RuntimePendingAttachment_expiresAt_idx" ON "RuntimePendingAttachment"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimePendingAttachment_identity_file_key" ON "RuntimePendingAttachment"("companyId", "userId", "channel", "conversationKey", "requestId", "fileId");

-- CreateIndex
CREATE INDEX "RuntimeRun_conversationId_startedAt_idx" ON "RuntimeRun"("conversationId", "startedAt");

-- CreateIndex
CREATE INDEX "RuntimeRun_parentRunId_idx" ON "RuntimeRun"("parentRunId");

-- CreateIndex
CREATE INDEX "RuntimeRun_channel_startedAt_idx" ON "RuntimeRun"("channel", "startedAt");

-- CreateIndex
CREATE INDEX "RuntimeRun_status_startedAt_idx" ON "RuntimeRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "RuntimeApproval_conversationId_createdAt_idx" ON "RuntimeApproval"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "RuntimeApproval_runId_createdAt_idx" ON "RuntimeApproval"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "RuntimeApproval_status_createdAt_idx" ON "RuntimeApproval"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RuntimeApproval_externalActionId_idx" ON "RuntimeApproval"("externalActionId");

-- CreateIndex
CREATE INDEX "RuntimeApproval_idempotencyKey_idx" ON "RuntimeApproval"("idempotencyKey");

-- CreateIndex
CREATE INDEX "KnowledgeResource_companyId_scope_status_updatedAt_idx" ON "KnowledgeResource"("companyId", "scope", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "KnowledgeResource_ownerUserId_kind_status_updatedAt_idx" ON "KnowledgeResource"("ownerUserId", "kind", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "KnowledgeResource_departmentId_kind_status_updatedAt_idx" ON "KnowledgeResource"("departmentId", "kind", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeResource_companyId_kind_targetKey_logicalKey_key" ON "KnowledgeResource"("companyId", "kind", "targetKey", "logicalKey");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeResource_id_companyId_key" ON "KnowledgeResource"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeFileAsset_storageKey_key" ON "KnowledgeFileAsset"("storageKey");

-- CreateIndex
CREATE INDEX "KnowledgeFileAsset_companyId_uploadedById_status_createdAt_idx" ON "KnowledgeFileAsset"("companyId", "uploadedById", "status", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeFileAsset_knowledgeResourceId_status_idx" ON "KnowledgeFileAsset"("knowledgeResourceId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeFileAsset_status_expiresAt_idx" ON "KnowledgeFileAsset"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "KnowledgeFileAsset_companyId_sha256_idx" ON "KnowledgeFileAsset"("companyId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeFileDocument_fileAssetId_key" ON "KnowledgeFileDocument"("fileAssetId");

-- CreateIndex
CREATE INDEX "KnowledgeFileDocument_companyId_status_updatedAt_idx" ON "KnowledgeFileDocument"("companyId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "KnowledgeFileDocument_resourceId_status_resourceVersion_idx" ON "KnowledgeFileDocument"("resourceId", "status", "resourceVersion");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeFileDocument_resourceId_resourceVersion_key" ON "KnowledgeFileDocument"("resourceId", "resourceVersion");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeFileDocument_id_companyId_key" ON "KnowledgeFileDocument"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeFileDocument_tenant_binding_key" ON "KnowledgeFileDocument"("id", "companyId", "resourceId", "resourceVersion");

-- CreateIndex
CREATE INDEX "KnowledgeFileChunk_companyId_resourceId_resourceVersion_ord_idx" ON "KnowledgeFileChunk"("companyId", "resourceId", "resourceVersion", "ordinal");

-- CreateIndex
CREATE INDEX "KnowledgeFileChunk_documentId_pageStart_pageEnd_idx" ON "KnowledgeFileChunk"("documentId", "pageStart", "pageEnd");

-- CreateIndex
CREATE INDEX "KnowledgeFileChunk_searchVector_idx" ON "KnowledgeFileChunk" USING GIN ("searchVector");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeFileChunk_documentId_ordinal_key" ON "KnowledgeFileChunk"("documentId", "ordinal");

-- CreateIndex
CREATE INDEX "KnowledgeVersion_contentHash_idx" ON "KnowledgeVersion"("contentHash");

-- CreateIndex
CREATE INDEX "KnowledgeVersion_searchVector_idx" ON "KnowledgeVersion" USING GIN ("searchVector");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVersion_resourceId_version_key" ON "KnowledgeVersion"("resourceId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVersion_resourceId_contentHash_key" ON "KnowledgeVersion"("resourceId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeMutation_runtimeApprovalId_key" ON "KnowledgeMutation"("runtimeApprovalId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeMutation_idempotencyKey_key" ON "KnowledgeMutation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "KnowledgeMutation_companyId_requesterId_status_createdAt_idx" ON "KnowledgeMutation"("companyId", "requesterId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeMutation_companyId_departmentId_status_createdAt_idx" ON "KnowledgeMutation"("companyId", "departmentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeMutation_resourceId_createdAt_idx" ON "KnowledgeMutation"("resourceId", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeMutation_runtimeApprovalId_idx" ON "KnowledgeMutation"("runtimeApprovalId");

-- CreateIndex
CREATE INDEX "KnowledgeMutation_fileAssetId_status_idx" ON "KnowledgeMutation"("fileAssetId", "status");

-- CreateIndex
CREATE INDEX "KnowledgePolicy_tenantKey_enabled_idx" ON "KnowledgePolicy"("tenantKey", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgePolicy_tenantKey_kind_scope_action_key" ON "KnowledgePolicy"("tenantKey", "kind", "scope", "action");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeOutbox_dedupeKey_key" ON "KnowledgeOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "KnowledgeOutbox_status_availableAt_idx" ON "KnowledgeOutbox"("status", "availableAt");

-- CreateIndex
CREATE INDEX "KnowledgeOutbox_mutationId_idx" ON "KnowledgeOutbox"("mutationId");

-- CreateIndex
CREATE INDEX "KnowledgeLearningJob_status_lockedAt_createdAt_idx" ON "KnowledgeLearningJob"("status", "lockedAt", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeLearningJob_companyId_userId_createdAt_idx" ON "KnowledgeLearningJob"("companyId", "userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeLearningJob_identity_pipeline_key" ON "KnowledgeLearningJob"("companyId", "userId", "sourceId", "pipelineVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MemberTokenPolicy_userId_key" ON "MemberTokenPolicy"("userId");

-- CreateIndex
CREATE INDEX "MemberTokenPolicy_companyId_idx" ON "MemberTokenPolicy"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberProxyPolicy_userId_key" ON "MemberProxyPolicy"("userId");

-- CreateIndex
CREATE INDEX "MemberProxyPolicy_companyId_idx" ON "MemberProxyPolicy"("companyId");

-- CreateIndex
CREATE INDEX "ProxyProviderKey_companyId_idx" ON "ProxyProviderKey"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProxyProviderKey_provider_scopeKey_key" ON "ProxyProviderKey"("provider", "scopeKey");

-- CreateIndex
CREATE INDEX "ProxyRequestLog_companyId_createdAt_idx" ON "ProxyRequestLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "ProxyRequestLog_companyId_userId_createdAt_idx" ON "ProxyRequestLog"("companyId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "ProxyRequestLog_companyId_channel_createdAt_idx" ON "ProxyRequestLog"("companyId", "channel", "createdAt");

-- AddForeignKey
ALTER TABLE "UserDepartmentPreference" ADD CONSTRAINT "UserDepartmentPreference_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDepartmentPreference" ADD CONSTRAINT "UserDepartmentPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminMembership" ADD CONSTRAINT "AdminMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminMembership" ADD CONSTRAINT "AdminMembership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZohoConnection" ADD CONSTRAINT "ZohoConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZohoConnectionProfile" ADD CONSTRAINT "ZohoConnectionProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZohoConnectionProfile" ADD CONSTRAINT "ZohoConnectionProfile_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZohoConnectionProfile" ADD CONSTRAINT "ZohoConnectionProfile_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZohoOAuthConfig" ADD CONSTRAINT "ZohoOAuthConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelIdentity" ADD CONSTRAINT "ChannelIdentity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LarkWorkspaceConfig" ADD CONSTRAINT "LarkWorkspaceConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LarkOperationalConfig" ADD CONSTRAINT "LarkOperationalConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LarkDirectorySyncRun" ADD CONSTRAINT "LarkDirectorySyncRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LarkTenantBinding" ADD CONSTRAINT "LarkTenantBinding_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpActionLog" ADD CONSTRAINT "McpActionLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZohoSyncJob" ADD CONSTRAINT "ZohoSyncJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZohoSyncJob" ADD CONSTRAINT "ZohoSyncJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ZohoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZohoSyncJobEvent" ADD CONSTRAINT "ZohoSyncJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ZohoSyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundArtifact" ADD CONSTRAINT "OutboundArtifact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyInvite" ADD CONSTRAINT "CompanyInvite_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_knowledgeResourceId_fkey" FOREIGN KEY ("knowledgeResourceId") REFERENCES "KnowledgeResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "SkillFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRoute" ADD CONSTRAINT "SkillRoute_routerSkillId_fkey" FOREIGN KEY ("routerSkillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRoute" ADD CONSTRAINT "SkillRoute_targetSkillId_fkey" FOREIGN KEY ("targetSkillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillFolder" ADD CONSTRAINT "SkillFolder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillFolder" ADD CONSTRAINT "SkillFolder_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillFolder" ADD CONSTRAINT "SkillFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "SkillFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillVersion" ADD CONSTRAINT "SkillVersion_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillAlias" ADD CONSTRAINT "SkillAlias_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillCapability" ADD CONSTRAINT "SkillCapability_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRegistryRevision" ADD CONSTRAINT "SkillRegistryRevision_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillAccessGrant" ADD CONSTRAINT "SkillAccessGrant_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillAccessGrant" ADD CONSTRAINT "SkillAccessGrant_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentAgentConfig" ADD CONSTRAINT "DepartmentAgentConfig_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentAgentConfig" ADD CONSTRAINT "DepartmentAgentConfig_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentAgentConfig" ADD CONSTRAINT "DepartmentAgentConfig_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentRole" ADD CONSTRAINT "DepartmentRole_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BooksModulePermission" ADD CONSTRAINT "BooksModulePermission_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BooksModulePermission" ADD CONSTRAINT "BooksModulePermission_departmentRoleId_fkey" FOREIGN KEY ("departmentRoleId") REFERENCES "DepartmentRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "DepartmentRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentToolPermission" ADD CONSTRAINT "DepartmentToolPermission_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentToolPermission" ADD CONSTRAINT "DepartmentToolPermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "DepartmentRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentToolPermission" ADD CONSTRAINT "DepartmentToolPermission_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentUserToolOverride" ADD CONSTRAINT "DepartmentUserToolOverride_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentUserToolOverride" ADD CONSTRAINT "DepartmentUserToolOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentUserToolOverride" ADD CONSTRAINT "DepartmentUserToolOverride_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolPermission" ADD CONSTRAINT "ToolPermission_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolActionPermission" ADD CONSTRAINT "ToolActionPermission_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZohoRoleAccessPolicy" ADD CONSTRAINT "ZohoRoleAccessPolicy_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRoleDefinition" ADD CONSTRAINT "AiRoleDefinition_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSession" ADD CONSTRAINT "MemberSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSession" ADD CONSTRAINT "MemberSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LarkUserAuthLink" ADD CONSTRAINT "LarkUserAuthLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LarkUserAuthLink" ADD CONSTRAINT "LarkUserAuthLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationOAuthAttempt" ADD CONSTRAINT "IntegrationOAuthAttempt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationOAuthAttempt" ADD CONSTRAINT "IntegrationOAuthAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyPrivacyRequest" ADD CONSTRAINT "ShopifyPrivacyRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyRunProvenance" ADD CONSTRAINT "ShopifyRunProvenance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyRunProvenance" ADD CONSTRAINT "ShopifyRunProvenance_executionRunId_fkey" FOREIGN KEY ("executionRunId") REFERENCES "ExecutionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyRunErasureFence" ADD CONSTRAINT "ShopifyRunErasureFence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionAuthorizationIntent" ADD CONSTRAINT "ConnectionAuthorizationIntent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionAuthorizationIntent" ADD CONSTRAINT "ConnectionAuthorizationIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionAuthorizationIntent" ADD CONSTRAINT "ConnectionAuthorizationIntent_departmentId_companyId_fkey" FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionAuthorizationIntent" ADD CONSTRAINT "ConnectionAuthorizationIntent_connectionId_companyId_userI_fkey" FOREIGN KEY ("connectionId", "companyId", "userId") REFERENCES "IntegrationConnection"("id", "companyId", "ownerUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxSubscription" ADD CONSTRAINT "MailboxSubscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxSubscription" ADD CONSTRAINT "MailboxSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxSubscription" ADD CONSTRAINT "MailboxSubscription_connectionId_companyId_userId_fkey" FOREIGN KEY ("connectionId", "companyId", "userId") REFERENCES "IntegrationConnection"("id", "companyId", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAutomationRule" ADD CONSTRAINT "MailAutomationRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAutomationRule" ADD CONSTRAINT "MailAutomationRule_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAutomationRule" ADD CONSTRAINT "MailAutomationRule_departmentId_companyId_fkey" FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAutomationRule" ADD CONSTRAINT "MailAutomationRule_subscriptionId_companyId_createdByUserI_fkey" FOREIGN KEY ("subscriptionId", "companyId", "createdByUserId") REFERENCES "MailboxSubscription"("id", "companyId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailEvent" ADD CONSTRAINT "MailEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailEvent" ADD CONSTRAINT "MailEvent_subscriptionId_companyId_fkey" FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "MailboxSubscription"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_ruleId_companyId_subscriptionId_fkey" FOREIGN KEY ("ruleId", "companyId", "subscriptionId") REFERENCES "MailAutomationRule"("id", "companyId", "subscriptionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_eventId_companyId_subscriptionId_fkey" FOREIGN KEY ("eventId", "companyId", "subscriptionId") REFERENCES "MailEvent"("id", "companyId", "subscriptionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnectionGovernance" ADD CONSTRAINT "IntegrationConnectionGovernance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnectionGovernance" ADD CONSTRAINT "IntegrationConnectionGovernance_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyCapabilityGovernance" ADD CONSTRAINT "CompanyCapabilityGovernance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanySerperConnection" ADD CONSTRAINT "CompanySerperConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanySerperConnection" ADD CONSTRAINT "CompanySerperConnection_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyOmsConnection" ADD CONSTRAINT "CompanyOmsConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyOmsConnection" ADD CONSTRAINT "CompanyOmsConnection_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnectionGrant" ADD CONSTRAINT "IntegrationConnectionGrant_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnectionGrant" ADD CONSTRAINT "IntegrationConnectionGrant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnectionGrant" ADD CONSTRAINT "IntegrationConnectionGrant_grantedBy_fkey" FOREIGN KEY ("grantedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopAuthHandoff" ADD CONSTRAINT "DesktopAuthHandoff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopAuthHandoff" ADD CONSTRAINT "DesktopAuthHandoff_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopWorkspace" ADD CONSTRAINT "DesktopWorkspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopWorkspace" ADD CONSTRAINT "DesktopWorkspace_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopThread" ADD CONSTRAINT "DesktopThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopThread" ADD CONSTRAINT "DesktopThread_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopThread" ADD CONSTRAINT "DesktopThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "DesktopWorkspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopThread" ADD CONSTRAINT "DesktopThread_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LarkChatContext" ADD CONSTRAINT "LarkChatContext_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopMessage" ADD CONSTRAINT "DesktopMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "DesktopThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledWorkflow" ADD CONSTRAINT "ScheduledWorkflow_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledWorkflow" ADD CONSTRAINT "ScheduledWorkflow_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledWorkflow" ADD CONSTRAINT "ScheduledWorkflow_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledWorkflowMessage" ADD CONSTRAINT "ScheduledWorkflowMessage_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ScheduledWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledWorkflowRun" ADD CONSTRAINT "ScheduledWorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ScheduledWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningEvidence" ADD CONSTRAINT "PersonaLearningEvidence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningEvidence" ADD CONSTRAINT "PersonaLearningEvidence_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningEvidence" ADD CONSTRAINT "PersonaLearningEvidence_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningEvidence" ADD CONSTRAINT "PersonaLearningEvidence_executionRunId_fkey" FOREIGN KEY ("executionRunId") REFERENCES "ExecutionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningJob" ADD CONSTRAINT "PersonaLearningJob_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "PersonaLearningEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningCandidate" ADD CONSTRAINT "PersonaLearningCandidate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningCandidate" ADD CONSTRAINT "PersonaLearningCandidate_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningCandidate" ADD CONSTRAINT "PersonaLearningCandidate_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningCandidate" ADD CONSTRAINT "PersonaLearningCandidate_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "PersonaLearningEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningCandidate" ADD CONSTRAINT "PersonaLearningCandidate_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PersonaLearningJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaLearningCandidate" ADD CONSTRAINT "PersonaLearningCandidate_promotedNodeId_fkey" FOREIGN KEY ("promotedNodeId") REFERENCES "ManagerPersonaNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerPersonaTree" ADD CONSTRAINT "ManagerPersonaTree_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerPersonaTree" ADD CONSTRAINT "ManagerPersonaTree_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerPersonaTree" ADD CONSTRAINT "ManagerPersonaTree_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerPersonaRevision" ADD CONSTRAINT "ManagerPersonaRevision_treeId_fkey" FOREIGN KEY ("treeId") REFERENCES "ManagerPersonaTree"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerPersonaNode" ADD CONSTRAINT "ManagerPersonaNode_treeId_fkey" FOREIGN KEY ("treeId") REFERENCES "ManagerPersonaTree"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerPersonaNode" ADD CONSTRAINT "ManagerPersonaNode_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerPersonaNode" ADD CONSTRAINT "ManagerPersonaNode_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerPersonaNode" ADD CONSTRAINT "ManagerPersonaNode_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerPersonaSkillLink" ADD CONSTRAINT "ManagerPersonaSkillLink_personaNodeId_fkey" FOREIGN KEY ("personaNodeId") REFERENCES "ManagerPersonaNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerPersonaSkillLink" ADD CONSTRAINT "ManagerPersonaSkillLink_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerTeachSession" ADD CONSTRAINT "ManagerTeachSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerTeachSession" ADD CONSTRAINT "ManagerTeachSession_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerTeachSession" ADD CONSTRAINT "ManagerTeachSession_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerTeachSession" ADD CONSTRAINT "ManagerTeachSession_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "ManagerTeachSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerTeachPersonaMutation" ADD CONSTRAINT "ManagerTeachPersonaMutation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ManagerTeachSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerTeachPersonaMutation" ADD CONSTRAINT "ManagerTeachPersonaMutation_treeId_fkey" FOREIGN KEY ("treeId") REFERENCES "ManagerPersonaTree"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerLearningProvenance" ADD CONSTRAINT "ManagerLearningProvenance_teachSessionId_fkey" FOREIGN KEY ("teachSessionId") REFERENCES "ManagerTeachSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerLearningProvenance" ADD CONSTRAINT "ManagerLearningProvenance_mutationId_fkey" FOREIGN KEY ("mutationId") REFERENCES "ManagerTeachPersonaMutation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerLearningProvenance" ADD CONSTRAINT "ManagerLearningProvenance_personaNodeId_fkey" FOREIGN KEY ("personaNodeId") REFERENCES "ManagerPersonaNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerLearningProvenance" ADD CONSTRAINT "ManagerLearningProvenance_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerTeachArtifact" ADD CONSTRAINT "ManagerTeachArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ManagerTeachSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ExecutionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepResult" ADD CONSTRAINT "StepResult_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ExecutionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeConversationMessage" ADD CONSTRAINT "RuntimeConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "RuntimeConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeConversationMessage" ADD CONSTRAINT "RuntimeConversationMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RuntimeRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeRun" ADD CONSTRAINT "RuntimeRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "RuntimeConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeApproval" ADD CONSTRAINT "RuntimeApproval_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "RuntimeConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeApproval" ADD CONSTRAINT "RuntimeApproval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RuntimeRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeResource" ADD CONSTRAINT "KnowledgeResource_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeResource" ADD CONSTRAINT "KnowledgeResource_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeResource" ADD CONSTRAINT "KnowledgeResource_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeResource" ADD CONSTRAINT "KnowledgeResource_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFileAsset" ADD CONSTRAINT "KnowledgeFileAsset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFileAsset" ADD CONSTRAINT "KnowledgeFileAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFileAsset" ADD CONSTRAINT "KnowledgeFileAsset_knowledgeResourceId_fkey" FOREIGN KEY ("knowledgeResourceId") REFERENCES "KnowledgeResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFileDocument" ADD CONSTRAINT "KnowledgeFileDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFileDocument" ADD CONSTRAINT "KnowledgeFileDocument_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "KnowledgeResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFileDocument" ADD CONSTRAINT "KnowledgeFileDocument_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "KnowledgeFileAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFileChunk" ADD CONSTRAINT "KnowledgeFileChunk_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFileChunk" ADD CONSTRAINT "KnowledgeFileChunk_documentId_companyId_resourceId_resourc_fkey" FOREIGN KEY ("documentId", "companyId", "resourceId", "resourceVersion") REFERENCES "KnowledgeFileDocument"("id", "companyId", "resourceId", "resourceVersion") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFileChunk" ADD CONSTRAINT "KnowledgeFileChunk_resourceId_companyId_fkey" FOREIGN KEY ("resourceId", "companyId") REFERENCES "KnowledgeResource"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "KnowledgeResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "KnowledgeResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_runtimeApprovalId_fkey" FOREIGN KEY ("runtimeApprovalId") REFERENCES "RuntimeApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_appliedVersionId_fkey" FOREIGN KEY ("appliedVersionId") REFERENCES "KnowledgeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeMutation" ADD CONSTRAINT "KnowledgeMutation_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "KnowledgeFileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeOutbox" ADD CONSTRAINT "KnowledgeOutbox_mutationId_fkey" FOREIGN KEY ("mutationId") REFERENCES "KnowledgeMutation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeLearningJob" ADD CONSTRAINT "KnowledgeLearningJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeLearningJob" ADD CONSTRAINT "KnowledgeLearningJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
