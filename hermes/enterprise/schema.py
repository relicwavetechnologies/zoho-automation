"""Enterprise schema contract for the transformed Hermes runtime."""

from __future__ import annotations

from dataclasses import dataclass


REQUIRED_IDENTITY_CONTEXT_KEYS = (
    "HERMES_COMPANY_ID",
    "HERMES_COMPANY_USER_ID",
    "HERMES_CHANNEL_IDENTITY_ID",
    "HERMES_COMPANY_ROLE",
    "HERMES_DEPARTMENT_ID",
    "HERMES_SESSION_KEY",
)


@dataclass(frozen=True)
class EnterpriseTable:
    name: str
    required_columns: tuple[str, ...]


@dataclass(frozen=True)
class LocalCacheStore:
    name: str
    purpose: str
    rebuild_from_tables: tuple[str, ...]


ENTERPRISE_TABLES = (
    EnterpriseTable("Company", ("id", "slug", "name")),
    EnterpriseTable("User", ("id", "email", "name")),
    EnterpriseTable("CompanyUser", ("id", "companyId", "userId", "role", "departmentId")),
    EnterpriseTable(
        "ChannelIdentity",
        (
            "id",
            "companyId",
            "companyUserId",
            "channel",
            "identityKey",
            "identityKind",
            "platformChatId",
            "platformWorkspaceId",
        ),
    ),
    EnterpriseTable(
        "RuntimeConversation",
        ("id", "companyId", "departmentId", "channel", "channelConversationKey"),
    ),
    EnterpriseTable(
        "RuntimeConversationMessage",
        (
            "id",
            "conversationId",
            "runId",
            "sequence",
            "actingCompanyUserId",
            "actingChannelIdentityId",
            "senderExternalId",
            "senderDisplayName",
            "hermesMessageId",
            "active",
            "toolCallId",
        ),
    ),
    EnterpriseTable(
        "RuntimeRun",
        (
            "id",
            "conversationId",
            "parentRunId",
            "hermesSessionId",
            "parentHermesSessionId",
            "modelId",
            "cwd",
        ),
    ),
    EnterpriseTable("RuntimeApproval", ("id", "conversationId", "runId", "toolId", "status")),
    EnterpriseTable(
        "HermesSessionBinding",
        (
            "id",
            "companyId",
            "hermesSessionId",
            "sessionKey",
            "conversationId",
            "runId",
            "channelIdentityId",
            "resolvedUserId",
        ),
    ),
    EnterpriseTable(
        "HermesRunStats",
        (
            "id",
            "runId",
            "cacheReadTokens",
            "cacheWriteTokens",
            "reasoningTokens",
            "estimatedCostUsd",
            "actualCostUsd",
        ),
    ),
    EnterpriseTable(
        "HermesConnectorCredential",
        (
            "id",
            "companyId",
            "provider",
            "scope",
            "payloadEncrypted",
            "status",
        ),
    ),
    EnterpriseTable(
        "PolicySchemaVersion",
        ("id", "companyId", "schemaText", "checksum", "status", "createdAt"),
    ),
    EnterpriseTable(
        "PolicyTemplate",
        ("id", "companyId", "name", "templateText", "status", "createdAt"),
    ),
    EnterpriseTable(
        "PolicyBinding",
        (
            "id",
            "companyId",
            "templateId",
            "principalType",
            "principalId",
            "resourceType",
            "resourceId",
            "action",
            "effect",
            "contextJson",
            "status",
        ),
    ),
    EnterpriseTable(
        "PolicySnapshot",
        ("id", "companyId", "schemaVersionId", "snapshotJson", "checksum", "status", "createdAt"),
    ),
    EnterpriseTable(
        "PolicyDecisionLog",
        ("id", "companyId", "principalId", "action", "resourceType", "resourceId", "decision", "createdAt"),
    ),
    EnterpriseTable(
        "PolicyToolCatalog",
        ("id", "companyId", "toolName", "toolset", "action", "riskClass"),
    ),
    EnterpriseTable(
        "PolicyRouteCatalog",
        ("id", "companyId", "routeKey", "method", "pathPattern", "action", "riskClass"),
    ),
    EnterpriseTable(
        "CompanyUserHomeChannel",
        (
            "id",
            "companyId",
            "companyUserId",
            "platform",
            "chatId",
        ),
    ),
    EnterpriseTable(
        "HermesMemoryEntry",
        (
            "id",
            "companyId",
            "companyUserId",
            "scope",
            "kind",
            "content",
            "source",
            "deletedAt",
        ),
    ),
    EnterpriseTable(
        "HermesMemoryAudit",
        ("id", "companyId", "entryId", "action", "createdAt"),
    ),
    EnterpriseTable(
        "HermesFollowUp",
        (
            "id",
            "companyId",
            "larkTaskGuid",
            "delegatorCompanyUserId",
            "assigneeCompanyUserId",
            "status",
        ),
    ),
    EnterpriseTable(
        "HermesFollowUpEvent",
        ("id", "followUpId", "eventType", "createdAt"),
    ),
    EnterpriseTable(
        "HermesRagChunk",
        (
            "id",
            "companyId",
            "sourceType",
            "sourceId",
            "chunkIndex",
            "documentKey",
            "visibility",
            "chunkText",
            "embedding",
            "payload",
            "embeddingSchemaVersion",
        ),
    ),
)


LOCAL_CACHE_STORES = (
    LocalCacheStore(
        "state.db",
        "Local transcript/session cache for Hermes desktop, CLI, resume, and search UX.",
        (
            "RuntimeConversation",
            "RuntimeConversationMessage",
            "RuntimeRun",
            "HermesSessionBinding",
        ),
    ),
    LocalCacheStore(
        "sessions.json",
        "Local session-key index used by gateway processes between restarts.",
        ("HermesSessionBinding",),
    ),
    LocalCacheStore(
        "company.db",
        "Local/dev identity fallback; disabled when enterprise Postgres is enabled.",
        ("Company", "CompanyUser", "ChannelIdentity"),
    ),
)
