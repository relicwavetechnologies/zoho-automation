import { ChatGoogle } from '@langchain/google';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

import config from '../../config';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { aiRoleService } from '../tools/ai-role.service';
import { toolPermissionService } from '../tools/tool-permission.service';
import { auditService } from '../../modules/audit/audit.service';
import { channelIdentityRepository } from '../channels/channel-identity.repository';
import { resolveChannelAdapter } from '../channels';
import { personalVectorMemoryService } from '../integrations/vector/personal-vector-memory.service';
import { vectorDocumentRepository } from '../integrations/vector/vector-document.repository';
import { qdrantAdapter } from '../integrations/vector/qdrant.adapter';
import { fileUploadService } from '../../modules/file-upload/file-upload.service';
import { aiModelControlService, type AiControlTargetKey, type AiModelProvider } from '../ai-models';

type ShareTargetType = 'conversation' | 'file_asset';
type ShareClassification = 'safe' | 'review' | 'critical';
type ShareRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'auto_shared'
  | 'shared_notified'
  | 'delivery_failed'
  | 'already_shared';

type ShareMeta = {
  version: 1;
  targetType: ShareTargetType;
  requesterAiRole?: string;
  snapshotAt?: string;
  summary?: string;
  classification?: ShareClassification;
  confidence?: number;
  reasons?: string[];
  riskFlags?: string[];
  humanReason?: string;
  fileAssetId?: string;
  fileName?: string;
  previousAllowedRoles?: string[];
  delivery?: {
    recipientCount: number;
    successCount: number;
    failedCount: number;
    mode: 'approval' | 'notification';
  };
};

const shareClassificationSchema = z.object({
  classification: z.enum(['safe', 'review', 'critical']),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1)).min(1).max(5),
  riskFlags: z.array(z.string()).max(8).default([]),
});

const SHARE_TOOL_ID = 'share_chat_vectors';
const SHARE_MODEL_TARGET = 'runtime.fast' as const;
const FILE_PREFIX = 'file:';
const SUMMARY_MODEL_TIMEOUT_MS = 4_000;

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const parseMeta = (reason?: string | null): ShareMeta | null => {
  if (!reason) return null;
  try {
    const parsed = JSON.parse(reason) as ShareMeta;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
};

const serializeMeta = (meta: ShareMeta): string => JSON.stringify(meta);

const buildFileConversationKey = (fileAssetId: string): string => `${FILE_PREFIX}${fileAssetId}`;

const isFileConversationKey = (conversationKey: string): boolean =>
  conversationKey.startsWith(FILE_PREFIX);

const maybeEscalateClassification = (
  classification: ShareClassification,
  confidence: number,
): ShareClassification => {
  if (confidence >= 0.65) {
    return classification;
  }
  if (classification === 'safe') return 'review';
  return 'critical';
};

const parseIsoDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const extractTextContent = (content: unknown): string => {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (
          item &&
          typeof item === 'object' &&
          'text' in item &&
          typeof (item as { text?: unknown }).text === 'string'
        ) {
          return (item as { text: string }).text;
        }
        return '';
      })
      .join(' ')
      .trim();
  }
  return '';
};

const hasProviderCredentials = (provider: AiModelProvider): boolean => {
  if (provider === 'google') {
    return Boolean((config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim());
  }
  if (provider === 'groq') {
    return Boolean(config.GROQ_API_KEY.trim());
  }
  return Boolean((process.env.OPENAI_API_KEY || '').trim());
};

const invokeControlTarget = async (
  targetKey: AiControlTargetKey,
  prompt: string,
): Promise<string | null> => {
  try {
    const resolved = await aiModelControlService.resolveTarget(targetKey);
    if (!hasProviderCredentials(resolved.effectiveProvider)) {
      return null;
    }

    const model =
      resolved.effectiveProvider === 'google'
        ? new ChatGoogle({
            model: resolved.effectiveModelId,
            apiKey: config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
            thinkingLevel: resolved.effectiveThinkingLevel,
          })
        : new ChatOpenAI({
            model: resolved.effectiveModelId,
            temperature: 0,
            apiKey:
              resolved.effectiveProvider === 'groq'
                ? config.GROQ_API_KEY
                : process.env.OPENAI_API_KEY,
            configuration:
              resolved.effectiveProvider === 'groq'
                ? { baseURL: 'https://api.groq.com/openai/v1' }
                : undefined,
          });

    const response = await model.invoke(prompt);
    const text = extractTextContent(response.content);
    return text.length > 0 ? text : null;
  } catch (error) {
    logger.warn('knowledge_share.model.invoke_failed', {
      targetKey,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return null;
  }
};

const extractFirstJsonObject = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return trimmed.slice(start, end + 1);
};

const heuristicClassification = (input: {
  targetType: ShareTargetType;
  preview: string;
  humanReason?: string;
}): z.infer<typeof shareClassificationSchema> => {
  const normalized = `${input.humanReason ?? ''}\n${input.preview}`.toLowerCase();
  const criticalPatterns = [
    /\b(password|passcode|otp|secret|client secret|private key|api[_\s-]?key|access[_\s-]?token|refresh[_\s-]?token|credential)\b/i,
    /\b(ssn|aadhaar|pan number|bank account|iban|swift|cvv|salary|payroll|contract|nda)\b/i,
    /\b(customer[-\s]?sensitive|confidential|proprietary|legal hold)\b/i,
    /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i,
  ];
  if (criticalPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      classification: 'critical',
      confidence: 0.82,
      reasons: [
        'Detected content that appears to include sensitive or approval-gated information.',
      ],
      riskFlags: ['heuristic_sensitive_content'],
    };
  }

  const safePatterns = [
    /\b(sop|process note|playbook|workflow|runbook|guideline|checklist)\b/i,
    /\b(lead qualification|handoff criteria|escalation path|team responsibilities)\b/i,
    /\b(reusable|internal process|company process|best practice)\b/i,
  ];
  if (safePatterns.some((pattern) => pattern.test(normalized))) {
    return {
      classification: 'safe',
      confidence: 0.72,
      reasons: [
        'Content looks like reusable internal process knowledge rather than sensitive data.',
      ],
      riskFlags: ['classifier_unavailable'],
    };
  }

  return {
    classification: 'review',
    confidence: 0.66,
    reasons: [
      'Classifier was unavailable, so the request was conservatively downgraded to notification-level review.',
    ],
    riskFlags: ['classifier_unavailable'],
  };
};

const fallbackSummary = (preview: string, targetType: ShareTargetType): string => {
  const normalized = preview
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');

  if (!normalized) {
    return targetType === 'file_asset'
      ? 'Shared a file-based knowledge snapshot with company scope.'
      : 'Shared a conversation knowledge snapshot with company scope.';
  }

  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
};

const summarizeSharedContent = async (input: {
  targetType: ShareTargetType;
  preview: string;
}): Promise<string> => {
  if (!config.GROQ_API_KEY.trim()) {
    return fallbackSummary(input.preview, input.targetType);
  }

  try {
    const prompt = [
      'Summarize the knowledge that was shared to company scope.',
      'Return one concise plain-text sentence under 180 characters.',
      'Do not mention approvals, risk, or system behavior.',
      `Target type: ${input.targetType}`,
      'Shared content preview:',
      input.preview.slice(0, 2200),
    ].join('\n');
    const model = new ChatOpenAI({
      model: 'llama-8b',
      temperature: 0,
      apiKey: config.GROQ_API_KEY,
      configuration: {
        baseURL: 'https://api.groq.com/openai/v1',
      },
    });
    const response = await model.invoke(prompt, {
      signal: AbortSignal.timeout(SUMMARY_MODEL_TIMEOUT_MS),
    });
    const summary = readString(extractTextContent(response.content))?.replace(/\s+/g, ' ');
    return summary
      ? summary.length > 180
        ? `${summary.slice(0, 177)}...`
        : summary
      : fallbackSummary(input.preview, input.targetType);
  } catch (error) {
    logger.warn('knowledge_share.summary.failed', {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return fallbackSummary(input.preview, input.targetType);
  }
};

const classifyShareContent = async (input: {
  targetType: ShareTargetType;
  preview: string;
  humanReason?: string;
}): Promise<z.infer<typeof shareClassificationSchema>> => {
  try {
    const prompt = [
      'You classify internal knowledge-sharing requests for a company workspace.',
      'Return valid JSON only with keys: classification, confidence, reasons, riskFlags.',
      'classification must be one of: safe, review, critical.',
      'Use critical for secrets, credentials, personal data, contracts, financial data, customer-sensitive info, or anything that obviously needs human approval.',
      'Use review for potentially sensitive internal operational content that is probably okay to share but should notify admins.',
      'Use safe for generic reusable company knowledge that is not sensitive.',
      `Target type: ${input.targetType}`,
      input.humanReason
        ? `Requester reason: ${input.humanReason}`
        : 'Requester reason: none provided',
      'Content preview:',
      input.preview.slice(0, 4000),
    ].join('\n');
    const text = await invokeControlTarget(SHARE_MODEL_TARGET, prompt);
    if (!text) {
      throw new Error('share_classifier_empty_response');
    }
    const json = extractFirstJsonObject(text);
    if (!json) {
      throw new Error(`share_classifier_no_json:${text.slice(0, 200)}`);
    }
    const parsed = shareClassificationSchema.parse(JSON.parse(json));

    return {
      ...parsed,
      classification: maybeEscalateClassification(parsed.classification, parsed.confidence),
    };
  } catch (error) {
    logger.warn('knowledge_share.classifier.failed', {
      error: error instanceof Error ? error.message : 'unknown_error',
      target: SHARE_MODEL_TARGET,
    });
    return heuristicClassification(input);
  }
};

const buildNotificationText = (input: {
  targetType: ShareTargetType;
  requesterLabel: string;
  requestId: string;
  preview: string;
  summary?: string;
  classification: ShareClassification;
  mode: 'approval' | 'notification';
}): string => {
  const title =
    input.mode === 'approval'
      ? '**Knowledge Share Approval Required**'
      : '**Knowledge Shared With Admin Notification**';
  return [
    title,
    `*Requested by:* ${input.requesterLabel}`,
    `*Target:* ${input.targetType === 'conversation' ? 'Conversation' : 'File'}`,
    `*Classification:* ${input.classification}`,
    input.summary ? `*Summary:* ${input.summary}` : '',
    '',
    '*Preview:*',
    input.preview || '_No preview available._',
  ].join('\n');
};

class KnowledgeShareService {
  async canRequestShare(companyId: string, role: string): Promise<boolean> {
    return toolPermissionService.isAllowed(companyId, SHARE_TOOL_ID, role);
  }

  private async resolveRequesterLabel(input: {
    companyId: string;
    requesterUserId: string;
  }): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: input.requesterUserId },
      select: { name: true, email: true },
    });
    const identity = user?.email
      ? await channelIdentityRepository.findLarkIdentityForProvisioning({
          companyId: input.companyId,
          email: user.email,
        })
      : null;

    const displayName = readString(identity?.displayName) ?? readString(user?.name);
    const email = readString(identity?.email) ?? readString(user?.email);

    if (displayName && email) {
      return `${displayName} (${email})`;
    }
    if (email) {
      return email;
    }
    if (displayName) {
      return displayName;
    }
    return input.requesterUserId;
  }

  private async promoteConversation(input: {
    companyId: string;
    requesterUserId: string;
    conversationKey: string;
    sharedThroughAt?: Date;
  }): Promise<number> {
    const shared = await personalVectorMemoryService.shareConversation(input);
    return shared.sharedCount;
  }

  private async getLatestConversationRequest(input: {
    companyId: string;
    requesterUserId: string;
    conversationKey: string;
    statuses?: ShareRequestStatus[];
  }) {
    return prisma.vectorShareRequest.findFirst({
      where: {
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        ...(input.statuses ? { status: { in: input.statuses } } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async promoteFile(input: {
    companyId: string;
    fileAssetId: string;
    updatedBy: string;
  }): Promise<number> {
    const allowedRoles = await aiRoleService.getRoleSlugs(input.companyId);
    await fileUploadService.updateAccessPolicy({
      fileAssetId: input.fileAssetId,
      companyId: input.companyId,
      allowedRoles,
      updatedBy: input.updatedBy,
    });

    const docs = await vectorDocumentRepository.findByFileAsset({
      companyId: input.companyId,
      fileAssetId: input.fileAssetId,
    });
    if (docs.length === 0) {
      return 0;
    }

    const records = docs.map((doc) => {
      const payload = (doc.payload ?? {}) as Record<string, unknown>;
      const content =
        typeof payload._chunk === 'string'
          ? payload._chunk
          : typeof payload.text === 'string'
            ? payload.text
            : '';
      const title =
        typeof payload.title === 'string'
          ? payload.title
          : typeof payload.citationTitle === 'string'
            ? payload.citationTitle
            : 'document';
      return {
        companyId: doc.companyId,
        connectionId: doc.connectionId ?? undefined,
        fileAssetId: doc.fileAssetId ?? undefined,
        sourceType: doc.sourceType as 'file_document',
        sourceId: doc.sourceId,
        chunkIndex: doc.chunkIndex,
        contentHash: doc.contentHash,
        visibility: doc.visibility,
        ownerUserId: doc.ownerUserId ?? undefined,
        conversationKey: doc.conversationKey ?? undefined,
        payload: {
          ...payload,
          allowedRoles,
        },
        allowedRoles,
        embedding: doc.embedding,
        denseEmbedding: doc.embedding,
        documentKey: doc.documentKey ?? `${doc.companyId}:file_document:${doc.sourceId}`,
        chunkText: content,
        retrievalProfile: (payload.retrievalProfile as 'file' | undefined) ?? 'file',
        embeddingSchemaVersion:
          typeof payload.embeddingSchemaVersion === 'string'
            ? payload.embeddingSchemaVersion
            : undefined,
        updatedAt:
          typeof payload.sourceUpdatedAt === 'string'
            ? payload.sourceUpdatedAt
            : typeof payload.updatedAt === 'string'
              ? payload.updatedAt
              : undefined,
        sourceUpdatedAt:
          typeof payload.sourceUpdatedAt === 'string' ? payload.sourceUpdatedAt : undefined,
        title,
        content,
      };
    });

    await vectorDocumentRepository.upsertMany(records);
    await qdrantAdapter.upsertVectors(records);
    return records.length;
  }

  private async revertConversation(input: {
    companyId: string;
    requesterUserId: string;
    conversationKey: string;
    sharedThroughAt: Date;
  }): Promise<number> {
    const docsToRevert = await vectorDocumentRepository.findByConversation({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      createdAtLte: input.sharedThroughAt,
      visibility: 'shared',
    });
    if (docsToRevert.length === 0) {
      return 0;
    }

    await vectorDocumentRepository.reassignConversationVisibility({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      visibility: 'personal',
      createdAtLte: input.sharedThroughAt,
    });

    await qdrantAdapter.upsertVectors(
      docsToRevert.map((doc) => {
        const payload = (doc.payload ?? {}) as Record<string, unknown>;
        const content =
          typeof payload._chunk === 'string'
            ? payload._chunk
            : typeof payload.text === 'string'
              ? payload.text
              : '';
        const title = typeof payload.title === 'string' ? payload.title : 'chat turn';
        return {
          companyId: doc.companyId,
          sourceType: doc.sourceType as 'chat_turn',
          sourceId: doc.sourceId,
          chunkIndex: doc.chunkIndex,
          contentHash: doc.contentHash,
          visibility: 'personal' as const,
          ownerUserId: doc.ownerUserId ?? undefined,
          conversationKey: doc.conversationKey ?? undefined,
          documentKey: doc.documentKey ?? `${doc.companyId}:chat_turn:${doc.sourceId}`,
          chunkText: content,
          payload,
          denseEmbedding: doc.embedding as number[],
          retrievalProfile: (payload.retrievalProfile as 'chat' | undefined) ?? 'chat',
          embeddingSchemaVersion:
            typeof payload.embeddingSchemaVersion === 'string'
              ? payload.embeddingSchemaVersion
              : undefined,
          updatedAt:
            typeof payload.sourceUpdatedAt === 'string'
              ? payload.sourceUpdatedAt
              : typeof payload.updatedAt === 'string'
                ? payload.updatedAt
                : undefined,
          sourceUpdatedAt:
            typeof payload.sourceUpdatedAt === 'string' ? payload.sourceUpdatedAt : undefined,
          title,
          content,
        };
      }),
    );

    return docsToRevert.length;
  }

  private async getFileAllowedRoles(companyId: string, fileAssetId: string): Promise<string[]> {
    const asset = await prisma.fileAsset.findFirst({
      where: { id: fileAssetId, companyId },
      select: {
        accessPolicies: {
          select: { aiRole: true },
          orderBy: { aiRole: 'asc' },
        },
      },
    });
    if (!asset) {
      throw new Error('File asset not found');
    }
    return asset.accessPolicies.map((policy) => policy.aiRole);
  }

  private async revertFileShare(input: {
    companyId: string;
    fileAssetId: string;
    previousAllowedRoles: string[];
    updatedBy: string;
  }): Promise<number> {
    await fileUploadService.updateAccessPolicy({
      fileAssetId: input.fileAssetId,
      companyId: input.companyId,
      allowedRoles: input.previousAllowedRoles,
      updatedBy: input.updatedBy,
    });

    const docs = await vectorDocumentRepository.findByFileAsset({
      companyId: input.companyId,
      fileAssetId: input.fileAssetId,
    });
    if (docs.length === 0) {
      return 0;
    }

    const records = docs.map((doc) => {
      const payload = (doc.payload ?? {}) as Record<string, unknown>;
      const content =
        typeof payload._chunk === 'string'
          ? payload._chunk
          : typeof payload.text === 'string'
            ? payload.text
            : '';
      const title =
        typeof payload.title === 'string'
          ? payload.title
          : typeof payload.citationTitle === 'string'
            ? payload.citationTitle
            : 'document';
      return {
        companyId: doc.companyId,
        connectionId: doc.connectionId ?? undefined,
        fileAssetId: doc.fileAssetId ?? undefined,
        sourceType: doc.sourceType as 'file_document',
        sourceId: doc.sourceId,
        chunkIndex: doc.chunkIndex,
        contentHash: doc.contentHash,
        visibility: doc.visibility,
        ownerUserId: doc.ownerUserId ?? undefined,
        conversationKey: doc.conversationKey ?? undefined,
        payload: {
          ...payload,
          allowedRoles: input.previousAllowedRoles,
        },
        allowedRoles: input.previousAllowedRoles,
        embedding: doc.embedding,
        denseEmbedding: doc.embedding,
        documentKey: doc.documentKey ?? `${doc.companyId}:file_document:${doc.sourceId}`,
        chunkText: content,
        retrievalProfile: (payload.retrievalProfile as 'file' | undefined) ?? 'file',
        embeddingSchemaVersion:
          typeof payload.embeddingSchemaVersion === 'string'
            ? payload.embeddingSchemaVersion
            : undefined,
        updatedAt:
          typeof payload.sourceUpdatedAt === 'string'
            ? payload.sourceUpdatedAt
            : typeof payload.updatedAt === 'string'
              ? payload.updatedAt
              : undefined,
        sourceUpdatedAt:
          typeof payload.sourceUpdatedAt === 'string' ? payload.sourceUpdatedAt : undefined,
        title,
        content,
      };
    });

    await vectorDocumentRepository.upsertMany(records);
    await qdrantAdapter.upsertVectors(records);
    return records.length;
  }

  private async notifyAdmins(input: {
    companyId: string;
    requestId: string;
    requesterUserId: string;
    targetType: ShareTargetType;
    preview: string;
    classification: ShareClassification;
    mode: 'approval' | 'notification';
  }): Promise<{
    recipientCount: number;
    successCount: number;
    failedCount: number;
    mode: 'approval' | 'notification';
  }> {
    const admins = await channelIdentityRepository.findAdminsByCompany(input.companyId);
    const adapter = resolveChannelAdapter('lark');

    if (admins.length === 0) {
      await auditService.recordLog({
        actorId: input.requesterUserId,
        companyId: input.companyId,
        action: 'knowledge_share.delivery.failed',
        outcome: 'failure',
        metadata: {
          requestId: input.requestId,
          reason: 'no_admin_recipients',
        },
      });
      return { recipientCount: 0, successCount: 0, failedCount: 0, mode: input.mode };
    }

    const requesterLabel = await this.resolveRequesterLabel({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
    });

    const text = buildNotificationText({
      targetType: input.targetType,
      requesterLabel,
      requestId: input.requestId,
      preview: input.preview,
      summary: await summarizeSharedContent({
        targetType: input.targetType,
        preview: input.preview,
      }),
      classification: input.classification,
      mode: input.mode,
    });

    const results = await Promise.allSettled(
      admins.map(async (admin) => {
        const outbound = await adapter.sendMessage({
          chatId: admin.larkOpenId,
          text,
          correlationId: input.requestId,
          actions:
            input.mode === 'approval'
              ? [
                  {
                    id: 'admin_share_decision',
                    label: 'Approve',
                    value: { requestId: input.requestId, decision: 'approve' },
                    style: 'primary',
                  },
                  {
                    id: 'admin_share_decision',
                    label: 'Reject',
                    value: { requestId: input.requestId, decision: 'reject' },
                    style: 'danger',
                  },
                ]
              : [
                  {
                    id: 'admin_share_revert',
                    label: 'Revert',
                    value: { requestId: input.requestId },
                    style: 'danger',
                  },
                ],
        });

        await auditService.recordLog({
          actorId: input.requesterUserId,
          companyId: input.companyId,
          action:
            outbound.status === 'sent'
              ? 'knowledge_share.delivery.sent'
              : 'knowledge_share.delivery.failed',
          outcome: outbound.status === 'sent' ? 'success' : 'failure',
          metadata: {
            requestId: input.requestId,
            recipientIdentityId: admin.id,
            recipientEmail: admin.email,
            recipientName: admin.displayName,
            providerMessageId: outbound.messageId,
            failureReason: outbound.error?.classifiedReason ?? outbound.error?.rawMessage,
          },
        });

        return outbound.status === 'sent';
      }),
    );

    const successCount = results.filter(
      (result) => result.status === 'fulfilled' && result.value,
    ).length;
    const failedCount = admins.length - successCount;
    return { recipientCount: admins.length, successCount, failedCount, mode: input.mode };
  }

  private async getConversationPreview(
    companyId: string,
    requesterUserId: string,
    conversationKey: string,
  ): Promise<string> {
    const preview = await personalVectorMemoryService.getConversationPreview(
      companyId,
      requesterUserId,
      conversationKey,
    );
    if (!preview) {
      throw new Error('No personal conversation vectors found for this request');
    }
    return preview;
  }

  private async getFilePreview(
    companyId: string,
    fileAssetId: string,
  ): Promise<{ preview: string; fileName: string }> {
    const asset = await prisma.fileAsset.findFirst({
      where: { id: fileAssetId, companyId },
      select: { fileName: true, ingestionStatus: true, ingestionError: true },
    });
    if (!asset) {
      throw new Error('File asset not found');
    }
    if (asset.ingestionStatus !== 'done') {
      throw new Error(
        asset.ingestionError || 'File must finish indexing before it can be shared company-wide',
      );
    }

    let docs = await vectorDocumentRepository.findByFileAsset({ companyId, fileAssetId });
    let preview = docs
      .slice(0, 5)
      .map((doc) => {
        const payload = (doc.payload ?? {}) as Record<string, unknown>;
        return readString(payload._chunk) ?? readString(payload.text) ?? '';
      })
      .filter(Boolean)
      .join('\n');

    if (!preview) {
      await fileUploadService.backfillVectorsFromSource(fileAssetId, companyId);
      docs = await vectorDocumentRepository.findByFileAsset({ companyId, fileAssetId });
      preview = docs
        .slice(0, 5)
        .map((doc) => {
          const payload = (doc.payload ?? {}) as Record<string, unknown>;
          return readString(payload._chunk) ?? readString(payload.text) ?? '';
        })
        .filter(Boolean)
        .join('\n');
    }

    if (!preview) {
      throw new Error(
        'No extractable indexed content found for this file. Re-upload a text-readable version or retry indexing.',
      );
    }

    return { preview: preview.slice(0, 2000), fileName: asset.fileName };
  }

  private async upsertRequest(input: {
    companyId: string;
    requesterUserId: string;
    requesterChannelIdentityId?: string;
    conversationKey: string;
    status: ShareRequestStatus;
    meta: ShareMeta;
    promotedVectorCount?: number;
  }) {
    const existingPending = await prisma.vectorShareRequest.findFirst({
      where: {
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        status: 'pending',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingPending) {
      return prisma.vectorShareRequest.update({
        where: { id: existingPending.id },
        data: {
          status: input.status,
          requesterChannelIdentityId:
            input.requesterChannelIdentityId ?? existingPending.requesterChannelIdentityId,
          reason: serializeMeta(input.meta),
          promotedVectorCount: input.promotedVectorCount ?? existingPending.promotedVectorCount,
        },
      });
    }

    return prisma.vectorShareRequest.create({
      data: {
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        requesterChannelIdentityId: input.requesterChannelIdentityId,
        conversationKey: input.conversationKey,
        status: input.status,
        reason: serializeMeta(input.meta),
        promotedVectorCount: input.promotedVectorCount ?? 0,
      },
    });
  }

  async requestConversationShare(input: {
    companyId: string;
    requesterUserId: string;
    requesterChannelIdentityId?: string;
    requesterAiRole: string;
    conversationKey: string;
    humanReason?: string;
  }) {
    const existingPending = await this.getLatestConversationRequest({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
      statuses: ['pending'],
    });
    if (existingPending) {
      const meta = parseMeta(existingPending.reason);
      return {
        id: existingPending.id,
        status: existingPending.status as ShareRequestStatus,
        classification: meta?.classification ?? 'review',
        promotedVectorCount: existingPending.promotedVectorCount,
      };
    }

    const pendingDocs = await vectorDocumentRepository.findByConversation({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
    });
    if (pendingDocs.length === 0) {
      const latestShared = await this.getLatestConversationRequest({
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        statuses: ['approved', 'auto_shared', 'shared_notified', 'already_shared'],
      });
      const meta = latestShared ? parseMeta(latestShared.reason) : null;
      return {
        id: latestShared?.id ?? '',
        status: 'already_shared' as const,
        classification: meta?.classification ?? 'review',
        promotedVectorCount: 0,
      };
    }

    const preview = await this.getConversationPreview(
      input.companyId,
      input.requesterUserId,
      input.conversationKey,
    );
    const snapshotAt =
      pendingDocs[pendingDocs.length - 1]?.createdAt?.toISOString() ?? new Date().toISOString();
    const summary = await summarizeSharedContent({
      targetType: 'conversation',
      preview,
    });
    const classification = await classifyShareContent({
      targetType: 'conversation',
      preview,
      humanReason: input.humanReason,
    });

    const baseMeta: ShareMeta = {
      version: 1,
      targetType: 'conversation',
      requesterAiRole: input.requesterAiRole,
      snapshotAt,
      summary,
      classification: classification.classification,
      confidence: classification.confidence,
      reasons: classification.reasons,
      riskFlags: classification.riskFlags,
      humanReason: input.humanReason,
    };

    let status: ShareRequestStatus = 'pending';
    let promotedVectorCount = 0;

    if (classification.classification === 'safe') {
      promotedVectorCount = await this.promoteConversation({
        ...input,
        sharedThroughAt: parseIsoDate(snapshotAt) ?? undefined,
      });
      status = 'auto_shared';
    } else if (classification.classification === 'review') {
      promotedVectorCount = await this.promoteConversation({
        ...input,
        sharedThroughAt: parseIsoDate(snapshotAt) ?? undefined,
      });
      status = 'shared_notified';
    }

    const row = await this.upsertRequest({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      requesterChannelIdentityId: input.requesterChannelIdentityId,
      conversationKey: input.conversationKey,
      status,
      meta: baseMeta,
      promotedVectorCount,
    });

    if (
      classification.classification === 'review' ||
      classification.classification === 'critical'
    ) {
      const delivery = await this.notifyAdmins({
        companyId: input.companyId,
        requestId: row.id,
        requesterUserId: input.requesterUserId,
        targetType: 'conversation',
        preview,
        classification: classification.classification,
        mode: classification.classification === 'critical' ? 'approval' : 'notification',
      });
      const finalStatus =
        delivery.recipientCount === 0 || delivery.successCount === 0 ? 'delivery_failed' : status;
      const updatedMeta: ShareMeta = { ...baseMeta, delivery };
      await prisma.vectorShareRequest.update({
        where: { id: row.id },
        data: {
          status: finalStatus,
          reason: serializeMeta(updatedMeta),
        },
      });
      return {
        id: row.id,
        status: finalStatus,
        classification: classification.classification,
        promotedVectorCount,
      };
    }

    await auditService.recordLog({
      actorId: input.requesterUserId,
      companyId: input.companyId,
      action: 'knowledge_share.auto_shared',
      outcome: 'success',
      metadata: {
        requestId: row.id,
        targetType: 'conversation',
        conversationKey: input.conversationKey,
        classification: classification.classification,
        promotedVectorCount,
      },
    });

    return {
      id: row.id,
      status,
      classification: classification.classification,
      promotedVectorCount,
    };
  }

  async requestFileShare(input: {
    companyId: string;
    requesterUserId: string;
    requesterAiRole: string;
    fileAssetId: string;
    humanReason?: string;
  }) {
    const conversationKey = buildFileConversationKey(input.fileAssetId);
    const existingPending = await this.getLatestConversationRequest({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey,
      statuses: ['pending'],
    });
    if (existingPending) {
      const meta = parseMeta(existingPending.reason);
      return {
        id: existingPending.id,
        status: existingPending.status as ShareRequestStatus,
        classification: meta?.classification ?? 'review',
        promotedVectorCount: existingPending.promotedVectorCount,
        summary: meta?.summary,
      };
    }

    const currentAllowedRoles = await this.getFileAllowedRoles(input.companyId, input.fileAssetId);
    const allRoles = await aiRoleService.getRoleSlugs(input.companyId);
    const isAlreadyShared =
      allRoles.length > 0 && allRoles.every((role) => currentAllowedRoles.includes(role));
    if (isAlreadyShared) {
      const latestShared = await this.getLatestConversationRequest({
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        conversationKey,
        statuses: ['approved', 'auto_shared', 'shared_notified', 'already_shared'],
      });
      const meta = latestShared ? parseMeta(latestShared.reason) : null;
      return {
        id: latestShared?.id ?? '',
        status: 'already_shared' as const,
        classification: meta?.classification ?? 'review',
        promotedVectorCount: 0,
        summary: meta?.summary,
      };
    }

    const { preview, fileName } = await this.getFilePreview(input.companyId, input.fileAssetId);
    const summary = await summarizeSharedContent({
      targetType: 'file_asset',
      preview,
    });
    const classification = await classifyShareContent({
      targetType: 'file_asset',
      preview,
      humanReason: input.humanReason,
    });
    const baseMeta: ShareMeta = {
      version: 1,
      targetType: 'file_asset',
      requesterAiRole: input.requesterAiRole,
      summary,
      classification: classification.classification,
      confidence: classification.confidence,
      reasons: classification.reasons,
      riskFlags: classification.riskFlags,
      humanReason: input.humanReason,
      fileAssetId: input.fileAssetId,
      fileName,
      previousAllowedRoles: currentAllowedRoles,
    };

    let status: ShareRequestStatus = 'pending';
    let promotedVectorCount = 0;

    if (classification.classification === 'safe') {
      promotedVectorCount = await this.promoteFile({
        companyId: input.companyId,
        fileAssetId: input.fileAssetId,
        updatedBy: input.requesterUserId,
      });
      status = 'auto_shared';
    } else if (classification.classification === 'review') {
      promotedVectorCount = await this.promoteFile({
        companyId: input.companyId,
        fileAssetId: input.fileAssetId,
        updatedBy: input.requesterUserId,
      });
      status = 'shared_notified';
    }

    const row = await this.upsertRequest({
      companyId: input.companyId,
      requesterUserId: input.requesterUserId,
      conversationKey,
      status,
      meta: baseMeta,
      promotedVectorCount,
    });

    if (
      classification.classification === 'safe' ||
      classification.classification === 'review' ||
      classification.classification === 'critical'
    ) {
      const delivery = await this.notifyAdmins({
        companyId: input.companyId,
        requestId: row.id,
        requesterUserId: input.requesterUserId,
        targetType: 'file_asset',
        preview,
        classification: classification.classification,
        mode: classification.classification === 'critical' ? 'approval' : 'notification',
      });
      const finalStatus =
        delivery.recipientCount === 0 || delivery.successCount === 0 ? 'delivery_failed' : status;
      await prisma.vectorShareRequest.update({
        where: { id: row.id },
        data: {
          status: finalStatus,
          reason: serializeMeta({ ...baseMeta, delivery }),
        },
      });
      return {
        id: row.id,
        status: finalStatus,
        classification: classification.classification,
        promotedVectorCount,
      };
    }

    return {
      id: row.id,
      status,
      classification: classification.classification,
      promotedVectorCount,
    };
  }

  async listRequests(companyId: string) {
    const rows = await prisma.vectorShareRequest.findMany({
      where: { companyId },
      orderBy: [{ createdAt: 'desc' }],
      take: 50,
    });

    return rows.map((row) => {
      const meta = parseMeta(row.reason);
      return {
        id: row.id,
        companyId: row.companyId,
        requesterUserId: row.requesterUserId,
        requesterChannelIdentityId: row.requesterChannelIdentityId ?? undefined,
        conversationKey: row.conversationKey,
        targetType:
          meta?.targetType ??
          (isFileConversationKey(row.conversationKey) ? 'file_asset' : 'conversation'),
        fileAssetId: meta?.fileAssetId,
        fileName: meta?.fileName,
        summary: meta?.summary,
        snapshotAt: meta?.snapshotAt,
        classification: meta?.classification,
        confidence: meta?.confidence,
        reasons: meta?.reasons ?? [],
        riskFlags: meta?.riskFlags ?? [],
        delivery: meta?.delivery,
        status: row.status,
        reason: meta?.humanReason ?? row.reason ?? undefined,
        decisionNote: row.decisionNote ?? undefined,
        reviewedBy: row.reviewedBy ?? undefined,
        reviewedAt: row.reviewedAt?.toISOString(),
        expiresAt: row.expiresAt?.toISOString(),
        promotedVectorCount: row.promotedVectorCount,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async approveRequest(input: {
    requestId: string;
    reviewerUserId: string;
    decisionNote?: string;
  }) {
    const row = await prisma.vectorShareRequest.findUnique({ where: { id: input.requestId } });
    if (!row) {
      throw new Error('Vector share request not found');
    }
    if (row.status !== 'pending' && row.status !== 'delivery_failed') {
      return {
        id: row.id,
        status: row.status,
        promotedVectorCount: row.promotedVectorCount,
        reviewedAt: row.reviewedAt?.toISOString(),
      };
    }

    const meta = parseMeta(row.reason);
    let promotedVectorCount = row.promotedVectorCount;
    if (meta?.targetType === 'file_asset' && meta.fileAssetId) {
      promotedVectorCount = await this.promoteFile({
        companyId: row.companyId,
        fileAssetId: meta.fileAssetId,
        updatedBy: input.reviewerUserId,
      });
    } else {
      promotedVectorCount = await this.promoteConversation({
        companyId: row.companyId,
        requesterUserId: row.requesterUserId,
        conversationKey: row.conversationKey,
        sharedThroughAt: parseIsoDate(meta?.snapshotAt) ?? undefined,
      });
    }

    const updated = await prisma.vectorShareRequest.update({
      where: { id: input.requestId },
      data: {
        status: 'approved',
        decisionNote: input.decisionNote ?? null,
        reviewedBy: input.reviewerUserId,
        reviewedAt: new Date(),
        promotedVectorCount,
      },
    });

    await auditService.recordLog({
      actorId: input.reviewerUserId,
      companyId: row.companyId,
      action: 'knowledge_share.approve',
      outcome: 'success',
      metadata: {
        requestId: row.id,
        targetType: meta?.targetType ?? 'conversation',
        conversationKey: row.conversationKey,
        fileAssetId: meta?.fileAssetId,
        promotedVectorCount,
      },
    });

    return {
      id: updated.id,
      status: updated.status,
      promotedVectorCount: updated.promotedVectorCount,
      summary: meta?.summary,
      reviewedAt: updated.reviewedAt?.toISOString(),
    };
  }

  async rejectRequest(input: { requestId: string; reviewerUserId: string; decisionNote?: string }) {
    const row = await prisma.vectorShareRequest.findUnique({ where: { id: input.requestId } });
    if (!row) {
      throw new Error('Vector share request not found');
    }

    const updated = await prisma.vectorShareRequest.update({
      where: { id: input.requestId },
      data: {
        status: 'rejected',
        decisionNote: input.decisionNote ?? null,
        reviewedBy: input.reviewerUserId,
        reviewedAt: new Date(),
      },
    });

    await auditService.recordLog({
      actorId: input.reviewerUserId,
      companyId: row.companyId,
      action: 'knowledge_share.reject',
      outcome: 'success',
      metadata: {
        requestId: row.id,
        conversationKey: row.conversationKey,
      },
    });

    return {
      id: updated.id,
      status: updated.status,
      promotedVectorCount: updated.promotedVectorCount,
      reviewedAt: updated.reviewedAt?.toISOString(),
    };
  }

  async revertRequest(input: { requestId: string; reviewerUserId: string; decisionNote?: string }) {
    const row = await prisma.vectorShareRequest.findUnique({ where: { id: input.requestId } });
    if (!row) {
      throw new Error('Vector share request not found');
    }
    if (!['approved', 'auto_shared', 'shared_notified'].includes(row.status)) {
      return {
        id: row.id,
        status: row.status,
        revertedVectorCount: 0,
        reviewedAt: row.reviewedAt?.toISOString(),
      };
    }

    const meta = parseMeta(row.reason);
    let revertedVectorCount = 0;
    if (meta?.targetType === 'file_asset' && meta.fileAssetId) {
      revertedVectorCount = await this.revertFileShare({
        companyId: row.companyId,
        fileAssetId: meta.fileAssetId,
        previousAllowedRoles: meta.previousAllowedRoles ?? [],
        updatedBy: input.reviewerUserId,
      });
    } else {
      revertedVectorCount = await this.revertConversation({
        companyId: row.companyId,
        requesterUserId: row.requesterUserId,
        conversationKey: row.conversationKey,
        sharedThroughAt: parseIsoDate(meta?.snapshotAt) ?? row.reviewedAt ?? row.createdAt,
      });
    }

    const updated = await prisma.vectorShareRequest.update({
      where: { id: input.requestId },
      data: {
        status: 'reverted',
        decisionNote: input.decisionNote ?? row.decisionNote ?? null,
        reviewedBy: input.reviewerUserId,
        reviewedAt: new Date(),
      },
    });

    await auditService.recordLog({
      actorId: input.reviewerUserId,
      companyId: row.companyId,
      action: 'knowledge_share.reverted',
      outcome: 'success',
      metadata: {
        requestId: row.id,
        targetType: meta?.targetType ?? 'conversation',
        conversationKey: row.conversationKey,
        fileAssetId: meta?.fileAssetId,
        revertedVectorCount,
      },
    });

    return {
      id: updated.id,
      status: updated.status,
      revertedVectorCount,
      summary: meta?.summary,
      reviewedAt: updated.reviewedAt?.toISOString(),
    };
  }
}

export const knowledgeShareService = new KnowledgeShareService();
