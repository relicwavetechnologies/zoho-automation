import { randomUUID } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';

import {
  type LarkWebhookVerificationResult,
  verifyLarkWebhookRequest,
} from '../../security/lark/lark-webhook-verifier';
import type { NormalizedIncomingMessageDTO } from '../../contracts';
import config from '../../../config';
import { logger } from '../../../utils/logger';
import { LarkChannelAdapter } from './lark.adapter';
import type { LarkIngressParseResult } from './lark-ingress.contract';
import { parseLarkIngressPayload } from './lark-ingress.contract';
import { buildLarkTextHash, buildLarkTraceMeta } from './lark-observability';
import { emitRuntimeTrace } from '../../observability';
import { larkWorkspaceConfigRepository } from './lark-workspace-config.repository';
import { larkUserAuthLinkRepository } from './lark-user-auth-link.repository';
import { extractLarkMentionsFromMessage, inferLarkMessageType, parseLarkAttachmentKeys, replaceLarkMentionTokens, type LarkMention } from './lark-message-content';
import { ingestLarkAttachments } from './lark-file-ingestion';
import { larkRecentFilesStore } from './lark-recent-files.store';
import { larkChatContextService } from './lark-chat-context.service';
import { orangeDebug } from '../../../utils/orange-debug';
import { desktopThreadsService } from '../../../modules/desktop-threads/desktop-threads.service';
import {
  applyActionResultToTaskState,
  createEmptyTaskState,
  isAttentionOnlyText,
  parseDesktopTaskState,
  upsertDesktopSourceArtifacts,
} from '../../../modules/desktop-chat/desktop-thread-memory';
import { desktopWorkflowsService } from '../../../modules/desktop-workflows/desktop-workflows.service';
import { conversationMemoryStore } from '../../state/conversation';
import { createRateLimitMiddleware, createRedisAvailabilityMiddleware } from '../../../middlewares/rate-limit.middleware';
import type { MemberSessionDTO } from '../../../modules/member-auth/member-auth.service';
import { toolPermissionService } from '../../tools/tool-permission.service';
import { LarkStatusCoordinator } from '../../orchestration/engine/lark-status.coordinator';
import { runtimeTaskStore } from '../../orchestration/runtime-task.store';
import { memoryService } from '../../memory';
import { resolveAllowedRolesForVisibilityScope } from '../../../modules/file-upload/file-visibility-scope';
import { knowledgeShareService } from '../../knowledge-share/knowledge-share.service';
import { departmentService } from '../../departments/department.service';

type IngressIdempotencyKeyType = 'event' | 'message';
type WebhookVerificationFailureReason = Exclude<LarkWebhookVerificationResult['reason'], undefined>;
type AllowedRejectionReason = Exclude<WebhookVerificationFailureReason, 'replay_window_exceeded'>;

type UpsertChannelIdentityInput = {
  channel: string;
  externalUserId: string;
  externalTenantId: string;
  companyId: string;
  larkOpenId?: string;
  larkUserId?: string;
};

type NormalizedLarkMessage = NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const buildSourceArtifactEntriesFromNormalizedFiles = (
  files: NonNullable<NormalizedIncomingMessageDTO['attachedFiles']>,
): Array<{
  fileAssetId: string;
  fileName: string;
  sourceType: 'uploaded_file';
}> =>
  files.map((file) => ({
    fileAssetId: file.fileAssetId,
    fileName: file.fileName,
    sourceType: 'uploaded_file' as const,
  }));

type PendingApprovalContext =
  | {
    storageScope: 'thread';
    threadId: string;
    userId: string;
    pendingApproval: ReturnType<typeof parseDesktopTaskState>['pendingApproval'];
  }
  | {
    storageScope: 'group_chat';
    contextId: string;
    companyId: string;
    chatId: string;
    pendingApproval: ReturnType<typeof parseDesktopTaskState>['pendingApproval'];
  };

type LarkWebhookRouteDependencies = {
  adapter: Pick<LarkChannelAdapter, 'normalizeIncomingEvent' | 'sendMessage' | 'updateMessage' | 'downloadFile' | 'getMessage'>;
  log: Pick<typeof logger, 'debug' | 'info' | 'warn' | 'error' | 'success'>;
  verifyRequest: typeof verifyLarkWebhookRequest;
  parsePayload: typeof parseLarkIngressPayload;
  claimIngressKey: (channel: string, keyType: IngressIdempotencyKeyType, key: string) => Promise<boolean>;
  enqueueTask: (
    normalized: NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>>,
  ) => Promise<{ taskId: string }>;
  requeueTask: (
    taskId: string,
    normalized: NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>>,
  ) => Promise<{ taskId: string }>;
  resolveHitlAction: (actionId: string, decision: 'confirmed' | 'cancelled') => Promise<boolean>;
  getStoredHitlAction: (actionId: string) => Promise<Record<string, unknown> | null>;
  getLatestPendingHitlAction: (channel: 'lark', chatId: string) => Promise<Record<string, unknown> | null>;
  executeStoredHitlAction: (action: Record<string, unknown>) => Promise<{ kind?: string; ok: boolean; summary: string; payload?: Record<string, unknown> }>;
  resolveCompanyIdByTenantKey: (larkTenantKey: string) => Promise<string | null>;
  resolveWorkspaceVerificationConfig: (
    companyId: string,
  ) => Promise<{ signingSecret?: string; verificationToken?: string; maxSkewSeconds?: number } | null>;
  upsertChannelIdentity: (
    input: UpsertChannelIdentityInput,
  ) => Promise<{ id: string; isNew: boolean; aiRole: string; email?: string | null }>;
  /**
   * Looks up whether the Lark sender has an active linked Desktop account.
   * Returns the internal User.id if found, or null otherwise.
   * Used to unify personal vector memory ownership across channels.
   */
  resolveLinkedUserId: (input: {
    companyId: string;
    larkOpenId?: string | null;
    larkUserId?: string | null;
  }) => Promise<string | null>;
  listLarkChannelIdentities: (companyId: string) => Promise<Array<{
    externalUserId: string;
    displayName?: string | null;
    larkOpenId?: string | null;
    larkUserId?: string | null;
    email?: string | null;
  }>>;
};

const parseAttachedFilesFromUnknown = (
  value: unknown,
): NonNullable<NormalizedIncomingMessageDTO['attachedFiles']> => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const fileAssetId = typeof record.fileAssetId === 'string' ? record.fileAssetId.trim() : '';
    const cloudinaryUrl = typeof record.cloudinaryUrl === 'string' ? record.cloudinaryUrl.trim() : '';
    const mimeType = typeof record.mimeType === 'string' ? record.mimeType.trim() : '';
    const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
    if (!fileAssetId || !cloudinaryUrl || !mimeType || !fileName) {
      return [];
    }
    return [{ fileAssetId, cloudinaryUrl, mimeType, fileName }];
  });
};

const dedupeAttachedFiles = (
  files: NonNullable<NormalizedIncomingMessageDTO['attachedFiles']>,
): NonNullable<NormalizedIncomingMessageDTO['attachedFiles']> => {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = file.fileAssetId.trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const buildReferencedMessageSupplement = (input: {
  currentText: string;
  referencedText?: string;
}): string => {
  const referenced = input.referencedText?.trim();
  if (!referenced) {
    return input.currentText;
  }
  if (input.currentText.includes(referenced)) {
    return input.currentText;
  }
  return [
    input.currentText,
    '',
    '[Referenced message]',
    referenced,
  ].join('\n');
};

type CachedLarkMentionDirectory = {
  expiresAt: number;
  byId: Map<string, { displayName?: string | null; email?: string | null }>;
  byName: Map<string, { displayName?: string | null; email?: string | null }>;
};

const larkMentionDirectoryCache = new Map<string, CachedLarkMentionDirectory>();
const LARK_MENTION_DIRECTORY_TTL_MS = 60_000;
const LARK_BOT_ALIASES = ['divo', 'divo ai'];

const normalizeMentionLookupKey = (value: string | null | undefined): string => {
  const trimmed = value?.trim().toLowerCase() ?? '';
  if (!trimmed) {
    return '';
  }
  return trimmed
    .replace(/^@+/, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const buildLarkMentionDirectory = (rows: Array<{
  externalUserId: string;
  displayName?: string | null;
  larkOpenId?: string | null;
  larkUserId?: string | null;
  email?: string | null;
}>): CachedLarkMentionDirectory => {
  const byId = new Map<string, { displayName?: string | null; email?: string | null }>();
  const byName = new Map<string, { displayName?: string | null; email?: string | null }>();

  for (const row of rows) {
    const payload = {
      displayName: row.displayName ?? null,
      email: row.email ?? null,
    };
    for (const id of [row.externalUserId, row.larkOpenId ?? undefined, row.larkUserId ?? undefined]) {
      const normalized = normalizeMentionLookupKey(id);
      if (normalized) {
        byId.set(normalized, payload);
      }
    }
    for (const name of [row.displayName ?? undefined, row.email ?? undefined]) {
      const normalized = normalizeMentionLookupKey(name);
      if (normalized) {
        byName.set(normalized, payload);
      }
    }
  }

  return {
    expiresAt: Date.now() + LARK_MENTION_DIRECTORY_TTL_MS,
    byId,
    byName,
  };
};

const getCachedLarkMentionDirectory = async (
  companyId: string,
  dependencies: Pick<LarkWebhookRouteDependencies, 'listLarkChannelIdentities'>,
): Promise<CachedLarkMentionDirectory> => {
  const cached = larkMentionDirectoryCache.get(companyId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const directory = buildLarkMentionDirectory(await dependencies.listLarkChannelIdentities(companyId));
  larkMentionDirectoryCache.set(companyId, directory);
  return directory;
};

const resolveLarkMentionDisplayName = (mention: LarkMention, directory?: CachedLarkMentionDirectory | null): string | null => {
  const id = normalizeMentionLookupKey(mention.id);
  if (directory && id) {
    const matched = directory.byId.get(id);
    if (matched?.displayName) {
      return matched.displayName;
    }
  }

  const rawName = normalizeMentionLookupKey(mention.name);
  if (directory && rawName) {
    const matched = directory.byName.get(rawName) ?? directory.byId.get(rawName);
    if (matched?.displayName) {
      return matched.displayName;
    }
  }

  if (mention.name && !/^@?_user_\d+$/i.test(mention.name.trim())) {
    return mention.name.replace(/^@+/, '').trim();
  }
  return null;
};

const isDivoMention = (mention: LarkMention, directory?: CachedLarkMentionDirectory | null): boolean => {
  const resolved = normalizeMentionLookupKey(resolveLarkMentionDisplayName(mention, directory));
  if (resolved && LARK_BOT_ALIASES.includes(resolved)) {
    return true;
  }
  const raw = normalizeMentionLookupKey(mention.name);
  return Boolean(raw && LARK_BOT_ALIASES.includes(raw));
};

const textDirectlyMentionsDivo = (text: string): boolean => {
  const normalized = normalizeMentionLookupKey(text);
  if (!normalized) {
    return false;
  }
  return LARK_BOT_ALIASES.some((alias) => new RegExp(`(^|\\s)@${alias.replace(/\s+/g, '\\s+')}(?=\\s|$)`, 'i').test(normalized));
};

const mentionHasStructuredIdentity = (mention: LarkMention): boolean =>
  Boolean(
    mention.id?.trim()
    || (mention.name && !/^@?_user_\d+$/i.test(mention.name.trim())),
  );

type PrimaryIngressIdempotencyKey = {
  keyType: IngressIdempotencyKeyType;
  key: string;
  idempotencyKey: string;
};

const getRequestId = (req: Request): string =>
  ((req as Request & { requestId?: string }).requestId ?? 'missing_request_id');

const buildIngressTraceMeta = (input: {
  requestId: string;
  message: Pick<NormalizedIncomingMessageDTO, 'channel' | 'messageId' | 'chatId' | 'userId'>;
  eventId?: string;
  taskId?: string;
  idempotencyKey?: string;
  keyType?: IngressIdempotencyKeyType;
  textHash?: string;
  larkTenantKey?: string;
  companyId?: string;
}): Record<string, unknown> =>
  buildLarkTraceMeta({
    requestId: input.requestId,
    channel: input.message.channel,
    eventId: input.eventId,
    messageId: input.message.messageId,
    chatId: input.message.chatId,
    userId: input.message.userId,
    taskId: input.taskId,
    idempotencyKey: input.idempotencyKey,
    keyType: input.keyType,
    textHash: input.textHash,
    larkTenantKey: input.larkTenantKey,
    companyId: input.companyId,
  });

const toCompactJson = (value: unknown, maxLength = 1200): string | undefined => {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    if (!json) return undefined;
    return json.length > maxLength ? `${json.slice(0, maxLength)}...<truncated>` : json;
  } catch {
    return undefined;
  }
};

const buildIngressAckText = (input: { text: string; queuedBehindActive?: boolean; queuedCountAhead?: number }): string => {
  void input.text;
  if (input.queuedBehindActive) {
    const ahead = Math.max(1, input.queuedCountAhead ?? 1);
    return [
      'Queued your message.',
      '',
      `There ${ahead === 1 ? 'is' : 'are'} ${ahead} request${ahead === 1 ? '' : 's'} ahead of it in this Lark chat.`,
      'I will respond here after the current run finishes.',
      'Send /q to interrupt the active run.',
    ].join('\n');
  }
  return 'Working on it.';
};

const buildAttachmentAckMessage = (
  files: NonNullable<NormalizedIncomingMessageDTO['attachedFiles']>,
): string => {
  const names = files
    .map((file) => {
      const fileName = file.fileName?.trim();
      if (fileName) return fileName;
      const mimeLabel = file.mimeType?.split('/').pop()?.trim();
      return mimeLabel || 'file';
    })
    .join(', ');
  const noun = files.length === 1 ? 'file' : 'files';
  const pronoun = files.length === 1 ? 'it' : 'them';
  const subject = names ? ` (${names})` : '';
  return `Got your ${noun}${subject}. Send me a message and I'll work with ${pronoun}.`;
};

const buildApprovalContinuationText = (input: {
  kind?: string;
  ok?: boolean;
  summary?: string;
  actionSummary?: string;
  payload?: Record<string, unknown>;
}): string => {
  const payloadJson = input.payload
    ? JSON.stringify(input.payload)
    : '';
  const compactPayload = payloadJson.length > 6000 ? `${payloadJson.slice(0, 6000)}...` : payloadJson;
  return [
    'Continue from this local action result.',
    `kind: ${input.kind ?? 'local_action'}`,
    `ok: ${String(Boolean(input.ok))}`,
    'summary:',
    input.summary?.trim() || input.actionSummary?.trim() || 'No summary available.',
    compactPayload ? `payload:\n${compactPayload}` : '',
    input.ok
      ? 'Do not repeat the same successful action unless a different verification or follow-up step is required.'
      : 'Use the failure details above to choose a different next step or a corrected retry.',
  ].filter(Boolean).join('\n');
};

const shouldAutoContinueAfterApproval = (input: {
  approvalAction: Record<string, unknown>;
  executionOk?: boolean;
}): boolean => {
  void input.approvalAction;
  void input.executionOk;
  return true;
};

const loadPendingLarkApprovalContext = async (input: {
  companyId?: string;
  linkedUserId?: string;
  chatId?: string;
  chatType?: string;
}): Promise<PendingApprovalContext | null> => {
  if (!input.companyId) {
    return null;
  }

  if (input.chatType === 'group' && input.chatId) {
    const context = await larkChatContextService.load({
      companyId: input.companyId,
      chatId: input.chatId,
      chatType: input.chatType,
    });
    if (!context.taskState.pendingApproval) {
      return null;
    }
    return {
      storageScope: 'group_chat',
      contextId: context.id,
      companyId: input.companyId,
      chatId: input.chatId,
      pendingApproval: context.taskState.pendingApproval,
    };
  }

  if (!input.linkedUserId) {
    return null;
  }

  const thread = await desktopThreadsService.findOrCreateLarkLifetimeThread(input.linkedUserId, input.companyId);
  const meta = await desktopThreadsService.getThreadMeta(thread.id, input.linkedUserId);
  const taskState = parseDesktopTaskState((meta as Record<string, unknown>).taskStateJson);
  if (!taskState.pendingApproval) {
    return null;
  }

  return {
    storageScope: 'thread',
    threadId: thread.id,
    userId: input.linkedUserId,
    pendingApproval: taskState.pendingApproval,
  };
};

const buildStoredActionFromPendingApproval = (input: {
  pendingContext: PendingApprovalContext;
  chatId: string;
  companyId: string;
  requesterEmail?: string;
  requesterAiRole: string;
}): Record<string, unknown> => {
  const now = new Date().toISOString();
  const pendingApproval = input.pendingContext.pendingApproval;
  return {
    actionId: pendingApproval?.approvalId ?? randomUUID(),
    actionType: 'tool_action',
    summary: pendingApproval?.summary ?? 'Approval pending',
    toolId: pendingApproval?.toolId ?? 'unknown-tool',
    actionGroup: pendingApproval?.actionGroup ?? 'execute',
    channel: 'lark',
    subject: pendingApproval?.subject ?? '',
    requestedAt: pendingApproval?.updatedAt ?? now,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 'pending',
    taskId: '',
    _chatId: input.chatId,
    ...(input.pendingContext.storageScope === 'thread'
      ? { _threadId: input.pendingContext.threadId }
      : { _groupChatContextId: input.pendingContext.contextId }),
    _channel: 'lark',
    payload: pendingApproval?.payload ?? {},
    metadata: {
      companyId: input.companyId,
      ...(input.pendingContext.storageScope === 'thread'
        ? { userId: input.pendingContext.userId }
        : { chatId: input.pendingContext.chatId }),
      requesterEmail: input.requesterEmail,
      requesterAiRole: input.requesterAiRole,
    },
  };
};

const persistPendingApprovalResult = async (input: {
  pendingContext: PendingApprovalContext | null;
  actionResult: { kind: string; ok: boolean; summary: string; payload?: Record<string, unknown> };
}) => {
  if (!input.pendingContext) {
    return;
  }

  if (input.pendingContext.storageScope === 'group_chat') {
    const context = await larkChatContextService.load({
      companyId: input.pendingContext.companyId,
      chatId: input.pendingContext.chatId,
      chatType: 'group',
    });
    const nextTaskState = applyActionResultToTaskState({
      taskState: context.taskState,
      actionResult: input.actionResult,
    });
    await larkChatContextService.updateMemory({
      companyId: input.pendingContext.companyId,
      chatId: input.pendingContext.chatId,
      chatType: 'group',
      taskState: nextTaskState,
    });
    return;
  }

  const meta = await desktopThreadsService.getThreadMeta(input.pendingContext.threadId, input.pendingContext.userId);
  const taskState = parseDesktopTaskState((meta as Record<string, unknown>).taskStateJson);
  const nextTaskState = applyActionResultToTaskState({
    taskState,
    actionResult: input.actionResult,
  });
  await desktopThreadsService.updateOwnedThreadMemory(
    input.pendingContext.threadId,
    input.pendingContext.userId,
    { taskStateJson: nextTaskState as unknown as Record<string, unknown> },
  );
};

const continueAfterApproval = async (input: {
  dependencies: Pick<LarkWebhookRouteDependencies, 'enqueueTask' | 'requeueTask'>;
  taskId?: string;
  tracedMessage: NormalizedLarkMessage;
  requestId: string;
  sourceActionId: string;
  sourceMessageId: string;
  continuationText: string;
  parsedKind: LarkIngressParseResult['kind'];
  executionSummary?: string;
  executionOk?: boolean;
  executionPayload?: Record<string, unknown>;
}): Promise<string> => {
  const continuationMessage: NormalizedLarkMessage = {
    ...input.tracedMessage,
    messageId: randomUUID(),
    timestamp: new Date().toISOString(),
    text: input.continuationText,
    rawEvent: {
      kind: 'hitl_approval_continuation',
      sourceActionId: input.sourceActionId,
      sourceMessageId: input.sourceMessageId,
      executionSummary: input.executionSummary,
      executionOk: input.executionOk,
      executionPayload: input.executionPayload,
    },
    trace: {
      ...input.tracedMessage.trace,
      requestId: input.requestId,
      receivedAt: new Date().toISOString(),
      textHash: buildLarkTextHash(input.continuationText),
      statusMessageId:
        input.tracedMessage.trace?.statusMessageId
        ?? (input.parsedKind === 'event_callback_card_action'
          ? input.tracedMessage.messageId
          : undefined),
    },
  };

  if (input.taskId?.trim()) {
    await input.dependencies.requeueTask(input.taskId, continuationMessage);
    return input.taskId;
  }

  const enqueued = await input.dependencies.enqueueTask(continuationMessage);
  return enqueued.taskId;
};

const isAuthorizedApprovalActor = async (input: {
  companyId?: string;
  linkedUserId?: string;
  larkOpenId?: string;
  action: Record<string, unknown> | null | undefined;
}): Promise<boolean> => {
  const metadata = asRecord(input.action?.metadata);
  const companyId = asString(metadata?.companyId) ?? input.companyId;
  if (!companyId) {
    return true;
  }

  const departmentId = asString(metadata?.departmentId);
  const approver = await departmentService.resolveDepartmentApprover({
    companyId,
    departmentId,
  });
  if (!approver) {
    return true;
  }

  if (input.linkedUserId && approver.userId === input.linkedUserId) {
    return true;
  }
  if (input.larkOpenId && approver.larkOpenId === input.larkOpenId) {
    return true;
  }
  return false;
};

const maybeSendManagerAuditDm = async (input: {
  adapter: Pick<LarkChannelAdapter, 'sendMessage'>;
  action: Record<string, unknown> | null | undefined;
  executionOk?: boolean;
  executionSummary?: string;
}): Promise<void> => {
  const metadata = asRecord(input.action?.metadata);
  const managerApprovalConfig = asRecord(metadata?.departmentManagerApprovalConfig);
  const auditToolIds = Array.isArray(managerApprovalConfig?.managerDmAuditToolIds)
    ? managerApprovalConfig.managerDmAuditToolIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const toolId = asString(input.action?.toolId);
  if (!toolId || !auditToolIds.includes(toolId)) {
    return;
  }
  const companyId = asString(metadata?.companyId);
  if (!companyId) {
    return;
  }
  const approver = await departmentService.resolveDepartmentApprover({
    companyId,
    departmentId: asString(metadata?.departmentId),
  });
  if (!approver?.larkOpenId) {
    return;
  }
  const requesterLabel = asString(metadata?.requesterEmail) ?? asString(metadata?.userId) ?? 'unknown requester';
  const summary = asString(input.action?.summary) ?? 'mutating action';
  await input.adapter.sendMessage({
    chatId: approver.larkOpenId,
    text: `Audit: ${requesterLabel} requested ${summary}. Outcome: ${input.executionOk ? 'completed' : 'failed'}${input.executionSummary ? ` (${input.executionSummary})` : ''}`,
    format: 'text',
  });
};

const parseHitlDecision = (text: string): { actionId: string; decision: 'confirmed' | 'cancelled' } | null => {
  const normalized = text.trim().toLowerCase();
  const match = normalized.match(/^(confirm|cancel)\s+([0-9a-f-]{36})$/i);
  if (!match) {
    return null;
  }
  return {
    decision: match[1] === 'confirm' ? 'confirmed' : 'cancelled',
    actionId: match[2],
  };
};

const normalizeLarkCommandText = (text: string): string => {
  let current = text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();
  while (current) {
    const strippedPunctuation = current.replace(/^[-–—:>\s]+/, '').trim();
    const strippedBotMention = strippedPunctuation
      .replace(/^@?(?:divo(?: ai)?)\b[\s,:\-]*/i, '')
      .trim();
    const slashIndex = strippedBotMention.search(/\/[a-z]/i);
    if (slashIndex > 0) {
      return strippedBotMention.slice(slashIndex).trim();
    }
    if (strippedBotMention === current) {
      const directSlashIndex = current.search(/\/[a-z]/i);
      return directSlashIndex >= 0 ? current.slice(directSlashIndex).trim() : current;
    }
    current = strippedBotMention;
  }
  return current;
};

const isLarkClearContextCommand = (text: string): boolean => {
  const normalized = normalizeLarkCommandText(text).toLowerCase();
  return normalized === '/clear'
    || normalized === '/new'
    || normalized === '/newchat'
    || normalized === 'clear chat'
    || normalized === 'clear context'
    || normalized === 'start new chat'
    || normalized === 'new chat';
};

const parseLarkWorkflowCommand = (
  text: string,
): { kind: 'list' } | { kind: 'run'; reference: string } | null => {
  const trimmed = normalizeLarkCommandText(text);
  const normalized = trimmed.toLowerCase();
  if (normalized === '/prompts' || normalized === '/workflows') {
    return { kind: 'list' };
  }
  if (normalized.startsWith('/workflow ')) {
    const reference = trimmed.slice('/workflow '.length).trim();
    return reference ? { kind: 'run', reference } : { kind: 'list' };
  }
  if (normalized.startsWith('/workflows ')) {
    const reference = trimmed.slice('/workflows '.length).trim();
    return reference ? { kind: 'run', reference } : { kind: 'list' };
  }
  return null;
};

const parseLarkMemoryCommand = (
  text: string,
): { kind: 'list' | 'help' | 'clear' } | { kind: 'forget'; reference: string } | null => {
  const trimmed = normalizeLarkCommandText(text);
  const normalized = trimmed.toLowerCase();
  if (normalized === '/memory') {
    return { kind: 'list' };
  }
  if (normalized === '/memory help') {
    return { kind: 'help' };
  }
  if (normalized === '/memory clear') {
    return { kind: 'clear' };
  }
  if (normalized.startsWith('/memory forget ')) {
    const reference = trimmed.slice('/memory forget '.length).trim();
    return reference ? { kind: 'forget', reference } : { kind: 'help' };
  }
  return null;
};

const parseLarkShareCommand = (
  text: string,
): { kind: 'share'; reason?: string } | null => {
  const trimmed = normalizeLarkCommandText(text);
  const normalized = trimmed.toLowerCase();
  if (normalized === '/share') {
    return { kind: 'share' };
  }
  if (normalized.startsWith('/share ')) {
    const reason = trimmed.slice('/share '.length).trim();
    return reason ? { kind: 'share', reason } : { kind: 'share' };
  }
  return null;
};

const isLarkCommandMenuCommand = (text: string): boolean => {
  const normalized = normalizeLarkCommandText(text).toLowerCase();
  return normalized === '/'
    || normalized === '/help'
    || normalized === '/commands';
};

const buildLarkCommandMenuText = (): string => [
  'Available commands:',
  '',
  '/clear',
  'Start a fresh chat context for this Lark conversation.',
  '',
  '/prompts',
  'List your saved reusable prompts/workflows.',
  '',
  '/workflows',
  'List your saved reusable prompts/workflows.',
  '',
  '/workflow <id-or-name>',
  'Run one saved workflow by exact id or name.',
  '',
  '/workflows <id-or-name>',
  'Same as /workflow <id-or-name>.',
  '',
  '/memory',
  'List durable personal memories for your linked account.',
  '',
  '/memory forget <number-or-id>',
  'Forget one stored memory item.',
  '',
  '/memory clear',
  'Clear all durable personal memories for your linked account.',
  '',
  '/share [optional reason]',
  'Share this chat knowledge up to the current point for admin review/approval.',
].join('\n');

const buildLarkMemoryHelpText = (): string => [
  'Memory commands:',
  '',
  '/memory',
  'List your active durable memories.',
  '',
  '/memory forget <number-or-id>',
  'Forget one memory from the latest list order or by exact id.',
  '',
  '/memory clear',
  'Clear all durable personal memories.',
].join('\n');

const formatLarkMemoryListText = (
  items: Array<{ id: string; kindLabel: string; summary: string; scopeLabel?: string }>,
): string => {
  if (items.length === 0) {
    return 'No durable personal memories are stored yet.';
  }
  return [
    `Active memories (${items.length}):`,
    '',
    ...items.slice(0, 20).map((item, index) => {
      const scopeSuffix = item.scopeLabel ? ` • ${item.scopeLabel}` : '';
      return `${index + 1}. [${item.kindLabel}${scopeSuffix}] ${item.summary} (${item.id})`;
    }),
    '',
    'Use /memory forget <number-or-id> to remove one item.',
  ].join('\n');
};

const buildLarkWorkflowSession = (input: {
  userId: string;
  companyId: string;
  aiRole: string;
  email?: string;
  larkTenantKey?: string;
  larkOpenId?: string;
  larkUserId?: string;
}): MemberSessionDTO => ({
  userId: input.userId,
  companyId: input.companyId,
  role: input.aiRole,
  aiRole: input.aiRole,
  sessionId: randomUUID(),
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  authProvider: 'lark',
  email: input.email ?? '',
  larkTenantKey: input.larkTenantKey,
  larkOpenId: input.larkOpenId,
  larkUserId: input.larkUserId,
});

const buildLarkConversationKeyForShare = async (input: {
  companyId: string;
  linkedUserId: string;
  chatId: string;
  chatType: string;
}): Promise<string> => {
  if (input.chatType === 'group') {
    return `lark-chat:${input.chatId}`;
  }
  const thread = await desktopThreadsService.findOrCreateLarkLifetimeThread(
    input.linkedUserId,
    input.companyId,
  );
  return `lark-thread:${thread.id}`;
};

const formatLarkShareCommandResult = (input: {
  status: string;
  classification: string;
  promotedVectorCount?: number;
}): string => {
  const ratingLine =
    input.classification === 'safe'
      ? 'AI rating: safe'
      : input.classification === 'review'
        ? 'AI rating: review'
        : input.classification === 'critical'
          ? 'AI rating: critical'
          : null;

  const detail =
    input.status === 'already_shared'
      ? 'This chat knowledge is already shared.'
      : input.status === 'auto_shared'
        ? `Shared now. Promoted ${input.promotedVectorCount ?? 0} vectors.`
        : input.status === 'shared_notified'
          ? `Shared and admins were notified. Promoted ${input.promotedVectorCount ?? 0} vectors.`
          : input.status === 'pending'
            ? 'Queued for admin approval.'
            : input.status === 'delivery_failed'
              ? `Shared, but admin notification failed. Promoted ${input.promotedVectorCount ?? 0} vectors.`
              : 'Share request processed.';

  return [
    'Knowledge share status:',
    detail,
    ...(ratingLine ? [ratingLine] : []),
  ].join('\n');
};

const formatWorkflowListText = (rows: Array<Record<string, unknown>>): string => {
  if (rows.length === 0) {
    return 'No saved workflows were found. You can ask me to turn a repeatable task into a reusable workflow.';
  }
  return [
    `Saved workflows (${rows.length}):`,
    '',
    ...rows.slice(0, 20).map((row, index) => {
      const name = typeof row.name === 'string' ? row.name : 'Unnamed workflow';
      const id = typeof row.id === 'string' ? row.id : 'unknown';
      const status = typeof row.status === 'string' ? row.status : 'unknown';
      const nextRunAt = typeof row.nextRunAt === 'string' && row.nextRunAt.trim()
        ? `, next run ${row.nextRunAt}`
        : '';
      return `${index + 1}. ${name} (${id}) [${status}${nextRunAt}]`;
    }),
  ].join('\n');
};

const formatWorkflowAmbiguityText = (reference: string, candidates: Array<Record<string, unknown>>): string => [
  `Multiple saved workflows matched "${reference}".`,
  '',
  ...candidates.slice(0, 10).map((candidate, index) => {
    const name = typeof candidate.name === 'string' ? candidate.name : 'Unnamed workflow';
    const id = typeof candidate.id === 'string' ? candidate.id : 'unknown';
    const status = typeof candidate.status === 'string' ? candidate.status : 'unknown';
    return `${index + 1}. ${name} (${id}) [${status}]`;
  }),
  '',
  'Run /workflow <exact-id-or-name> with one of the entries above.',
].join('\n');

const formatWorkflowRunResultText = (input: {
  workflowName: string;
  status: 'succeeded' | 'failed' | 'blocked';
  resultSummary?: string | null;
  errorSummary?: string | null;
  threadId?: string | null;
}): string => {
  if (input.status === 'failed') {
    return [
      `Workflow "${input.workflowName}" failed.`,
      '',
      input.errorSummary?.trim() || 'Unknown error',
    ].join('\n');
  }

  if (input.status === 'blocked') {
    return [
      `Workflow "${input.workflowName}" is blocked pending approval.`,
      '',
      input.resultSummary?.trim() || input.errorSummary?.trim() || 'Execution paused for approval.',
      input.threadId ? `Thread: ${input.threadId}` : '',
    ].filter(Boolean).join('\n');
  }

  return [
    `Workflow "${input.workflowName}" completed.`,
    '',
    input.resultSummary?.trim() || 'Execution succeeded.',
    input.threadId ? `Thread: ${input.threadId}` : '',
  ].filter(Boolean).join('\n');
};

const isLarkInterruptCommand = (text: string): boolean => {
  const normalized = normalizeLarkCommandText(text).toLowerCase();
  return normalized === '/q' || normalized === '/stop' || normalized === '/cancel';
};

const parseImplicitHitlDecision = (text: string): { decision: 'confirmed' | 'cancelled' } | null => {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, '');
  if (!normalized || normalized.length > 40) {
    return null;
  }

  const affirmative = new Set([
    'yes',
    'yeah',
    'yep',
    'ok',
    'okay',
    'ok go ahead',
    'okay go ahead',
    'go ahead',
    'approve',
    'approved',
    'confirm',
    'confirmed',
    'continue',
    'do it',
    'please do it',
  ]);
  if (affirmative.has(normalized)) {
    return { decision: 'confirmed' };
  }

  const negative = new Set([
    'no',
    'nope',
    'cancel',
    'reject',
    'rejected',
    'stop',
    'dont',
    "don't",
    'do not',
    'not now',
  ]);
  if (negative.has(normalized)) {
    return { decision: 'cancelled' };
  }

  return null;
};

const parseHitlCardDecision = (value: unknown): { actionId: string; decision: 'confirmed' | 'cancelled' } | null => {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
  if (!record) {
    return null;
  }
  if (record.kind !== 'hitl_tool_action') {
    return null;
  }
  const actionId = typeof record.actionId === 'string' ? record.actionId.trim() : '';
  const decision = record.decision === 'confirmed' || record.decision === 'cancelled'
    ? record.decision
    : null;
  if (!actionId || !decision) {
    return null;
  }
  return { actionId, decision };
};

const parseKnowledgeShareCardAction = (
  value: unknown,
):
  | { kind: 'request'; conversationKey: string }
  | { kind: 'decision'; requestId: string; decision: 'approve' | 'reject' }
  | { kind: 'revert'; requestId: string }
  | null => {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
  if (!record) {
    return null;
  }
  if (record.kind === 'conversation_share_request') {
    const conversationKey = typeof record.conversationKey === 'string' ? record.conversationKey.trim() : '';
    if (!conversationKey) {
      return null;
    }
    return {
      kind: 'request',
      conversationKey,
    };
  }
  const requestId = typeof record.requestId === 'string' ? record.requestId.trim() : '';
  if (!requestId) {
    return null;
  }
  if (record.decision === 'approve' || record.decision === 'reject') {
    return {
      kind: 'decision',
      requestId,
      decision: record.decision,
    };
  }
  return { kind: 'revert', requestId };
};

const sanitizeCardActionMessageText = (value: string | null | undefined): string => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed.startsWith('[Interactive Card Action]')) {
    return '';
  }
  return trimmed;
};

const buildLarkCardActionResponse = (
  content: string,
  type: 'success' | 'info' | 'warning' | 'error' = 'success',
): { toast: { type: 'success' | 'info' | 'warning' | 'error'; content: string } } => ({
  toast: {
    type,
    content: content.trim().slice(0, 200) || 'Done.',
  },
});

const readMessageAgeMs = (timestamp: string): number | null => {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return Date.now() - parsed.getTime();
};

const toIdempotencyStorageKey = (channel: string, keyType: IngressIdempotencyKeyType, key: string): string =>
  `company:idempotent:${channel}:${keyType}:${key}`;

const larkWebhookRateLimit = createRateLimitMiddleware({
  name: 'lark_webhook',
  max: 120,
  windowMs: 60_000,
  message: 'Lark webhook rate limit exceeded. Please retry shortly.',
  key: (req) => {
    const parsed = parseLarkIngressPayload(req.body);
    if ('larkTenantKey' in parsed && typeof parsed.larkTenantKey === 'string' && parsed.larkTenantKey.trim()) {
      return parsed.larkTenantKey.trim();
    }
    return req.ip;
  },
  skip: (req) => parseLarkIngressPayload(req.body).kind === 'url_verification',
});

const larkWebhookRedisGuard = createRedisAvailabilityMiddleware({
  name: 'lark_webhook_runtime',
  message: 'Lark runtime is temporarily unavailable while infrastructure recovers.',
  skip: (req) => parseLarkIngressPayload(req.body).kind === 'url_verification',
});

export const buildPrimaryIngressIdempotencyKey = (input: {
  channel: string;
  eventId?: string;
  messageId: string;
}): PrimaryIngressIdempotencyKey => {
  const eventId = input.eventId?.trim();
  if (eventId) {
    return {
      keyType: 'event',
      key: eventId,
      idempotencyKey: toIdempotencyStorageKey(input.channel, 'event', eventId),
    };
  }

  return {
    keyType: 'message',
    key: input.messageId,
    idempotencyKey: toIdempotencyStorageKey(input.channel, 'message', input.messageId),
  };
};

export const mapVerificationReasonToHttpStatus = (
  reason: LarkWebhookVerificationResult['reason'],
): 401 | 403 => {
  if (reason === 'replay_window_exceeded') {
    return 403;
  }

  const acceptedReasons: Record<AllowedRejectionReason, true> = {
    missing_verification_config: true,
    missing_headers: true,
    signature_required: true,
    invalid_signature: true,
    missing_verification_token: true,
    invalid_verification_token: true,
    invalid_timestamp: true,
  };

  if (!reason || !acceptedReasons[reason as AllowedRejectionReason]) {
    return 401;
  }

  return 401;
};

const buildDuplicateIgnoredResponse = (input: {
  message: Pick<NormalizedIncomingMessageDTO, 'channel' | 'messageId' | 'chatId'>;
  keyType: IngressIdempotencyKeyType;
  idempotencyKey: string;
}) => ({
  success: true,
  message: 'Duplicate ingress ignored (idempotency hit)',
  data: {
    channel: input.message.channel,
    messageId: input.message.messageId,
    chatId: input.message.chatId,
    keyType: input.keyType,
    idempotencyKey: input.idempotencyKey,
  },
});

const defaultClaimIngressKey: LarkWebhookRouteDependencies['claimIngressKey'] = async (
  channel,
  keyType,
  key,
) => {
  const { idempotencyRepository } = require('../../state') as typeof import('../../state');
  return idempotencyRepository.claimIngressKey(channel, keyType, key);
};

const defaultEnqueueTask: LarkWebhookRouteDependencies['enqueueTask'] = async (normalized) => {
  const { orchestrationRuntime } = require('../../queue/runtime') as typeof import('../../queue/runtime');
  return orchestrationRuntime.enqueue(normalized);
};

const defaultRequeueTask: LarkWebhookRouteDependencies['requeueTask'] = async (taskId, normalized) => {
  const { orchestrationRuntime } = require('../../queue/runtime') as typeof import('../../queue/runtime');
  return orchestrationRuntime.requeue(taskId, normalized);
};

const defaultResolveHitlAction: LarkWebhookRouteDependencies['resolveHitlAction'] = async (
  actionId,
  decision,
) => {
  const { hitlActionService } = require('../../state') as typeof import('../../state');
  return hitlActionService.resolveByActionId(actionId, decision);
};

const defaultGetStoredHitlAction: LarkWebhookRouteDependencies['getStoredHitlAction'] = async (actionId) => {
  const { hitlActionService } = require('../../state') as typeof import('../../state');
  return hitlActionService.getStoredAction(actionId) as unknown as Record<string, unknown> | null;
};

const defaultGetLatestPendingHitlAction: LarkWebhookRouteDependencies['getLatestPendingHitlAction'] = async (
  channel,
  chatId,
) => {
  const { hitlActionService } = require('../../state') as typeof import('../../state');
  return hitlActionService.getLatestPendingByChat(channel, chatId) as unknown as Record<string, unknown> | null;
};

const defaultExecuteStoredHitlAction: LarkWebhookRouteDependencies['executeStoredHitlAction'] = async (action) => {
  const metadata = typeof action.metadata === 'object' && action.metadata !== null && !Array.isArray(action.metadata)
    ? action.metadata as Record<string, unknown>
    : {};
  const remoteLocalAction = metadata.desktopRemoteLocalAction;
  if (remoteLocalAction && typeof remoteLocalAction === 'object' && !Array.isArray(remoteLocalAction)) {
    const companyId = typeof metadata.companyId === 'string' ? metadata.companyId.trim() : '';
    const userId = typeof metadata.userId === 'string' ? metadata.userId.trim() : '';
    if (!companyId || !userId) {
      throw new Error('Stored desktop remote action is missing companyId or userId');
    }
    const { desktopWsGateway } = require('../../../modules/desktop-live/desktop-ws.gateway') as typeof import('../../../modules/desktop-live/desktop-ws.gateway');
    const result = await desktopWsGateway.dispatchRemoteLocalAction({
      companyId,
      userId,
      action: remoteLocalAction as import('../../../modules/desktop-live/desktop-ws.gateway').RemoteLocalAction,
      reason: typeof metadata.desktopRemoteLocalExplanation === 'string'
        ? metadata.desktopRemoteLocalExplanation
        : undefined,
      overrideAsk: true,
    });
    return {
      kind: result.kind,
      ok: result.ok,
      summary: result.summary,
      payload: result.payload,
    };
  }
  const { executeStoredRemoteToolAction } = require('../../state') as typeof import('../../state');
  return executeStoredRemoteToolAction(action as any);
};

const defaultResolveCompanyIdByTenantKey: LarkWebhookRouteDependencies['resolveCompanyIdByTenantKey'] = async (
  larkTenantKey,
) => {
  const { larkTenantBindingRepository } = require('./lark-tenant-binding.repository') as typeof import('./lark-tenant-binding.repository');
  return larkTenantBindingRepository.resolveCompanyId(larkTenantKey);
};

const defaultResolveWorkspaceVerificationConfig: LarkWebhookRouteDependencies['resolveWorkspaceVerificationConfig'] = async (
  companyId,
) => {
  const workspaceConfig = await larkWorkspaceConfigRepository.findByCompanyId(companyId);
  if (workspaceConfig) {
    return {
      signingSecret: workspaceConfig.signingSecret,
      verificationToken: workspaceConfig.verificationToken,
      maxSkewSeconds: config.LARK_WEBHOOK_MAX_SKEW_SECONDS,
    };
  }

  const verificationToken = config.LARK_VERIFICATION_TOKEN.trim();
  const signingSecret = config.LARK_WEBHOOK_SIGNING_SECRET.trim();
  if (!verificationToken && !signingSecret) {
    return null;
  }
  return {
    signingSecret: signingSecret || undefined,
    verificationToken: verificationToken || undefined,
    maxSkewSeconds: config.LARK_WEBHOOK_MAX_SKEW_SECONDS,
  };
};

const defaultUpsertChannelIdentity: LarkWebhookRouteDependencies['upsertChannelIdentity'] = async (input) => {
  const { channelIdentityRepository } = require('../channel-identity.repository') as typeof import('../channel-identity.repository');
  return channelIdentityRepository.upsert(input);
};

const defaultResolveLinkedUserId: LarkWebhookRouteDependencies['resolveLinkedUserId'] = async (input) =>
  larkUserAuthLinkRepository.findLinkedUserId(input);

const defaultListLarkChannelIdentities: LarkWebhookRouteDependencies['listLarkChannelIdentities'] = async (companyId) => {
  const { channelIdentityRepository } = require('../channel-identity.repository') as typeof import('../channel-identity.repository');
  const rows = await channelIdentityRepository.listByCompany(companyId, 'lark');
  return rows.map((row) => ({
    externalUserId: row.externalUserId,
    displayName: row.displayName ?? null,
    larkOpenId: row.larkOpenId ?? null,
    larkUserId: row.larkUserId ?? null,
    email: row.email ?? null,
  }));
};

const createDefaultDependencies = (): LarkWebhookRouteDependencies => ({
  adapter: new LarkChannelAdapter(),
  log: logger,
  verifyRequest: verifyLarkWebhookRequest,
  parsePayload: parseLarkIngressPayload,
  claimIngressKey: defaultClaimIngressKey,
  enqueueTask: defaultEnqueueTask,
  requeueTask: defaultRequeueTask,
  resolveHitlAction: defaultResolveHitlAction,
  getStoredHitlAction: defaultGetStoredHitlAction,
  getLatestPendingHitlAction: defaultGetLatestPendingHitlAction,
  executeStoredHitlAction: defaultExecuteStoredHitlAction,
  resolveCompanyIdByTenantKey: defaultResolveCompanyIdByTenantKey,
  resolveWorkspaceVerificationConfig: defaultResolveWorkspaceVerificationConfig,
  upsertChannelIdentity: defaultUpsertChannelIdentity,
  resolveLinkedUserId: defaultResolveLinkedUserId,
  listLarkChannelIdentities: defaultListLarkChannelIdentities,
});

const isMetadataParseResult = (
  parsed: LarkIngressParseResult,
): parsed is Extract<
  LarkIngressParseResult,
  { eventType?: string; eventId?: string; larkTenantKey?: string }
> =>
  parsed.kind === 'event_callback_message'
  || parsed.kind === 'event_callback_card_action'
  || parsed.kind === 'event_callback_ignored';

export const createLarkWebhookEventHandler = (
  overrides: Partial<LarkWebhookRouteDependencies> = {},
) => {
  const dependencies: LarkWebhookRouteDependencies = {
    ...createDefaultDependencies(),
    ...overrides,
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = getRequestId(req);
      const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      dependencies.log.info('lark.ingress.received', {
        requestId,
        method: req.method,
        path: req.originalUrl || req.url,
      });
      const parsed = dependencies.parsePayload(req.body);
      const larkTenantKey = isMetadataParseResult(parsed) ? parsed.larkTenantKey : undefined;
      const scopedCompanyId = larkTenantKey
        ? await dependencies.resolveCompanyIdByTenantKey(larkTenantKey)
        : null;

      if (
        config.LARK_TENANT_BINDING_ENFORCED
        && larkTenantKey
        && !scopedCompanyId
        && parsed.kind !== 'url_verification'
      ) {
        dependencies.log.warn('lark.ingress.rejected', {
          requestId,
          reason: 'company_context_missing',
          statusCode: 403,
          larkTenantKey,
        });
        return res.status(403).json({
          success: false,
          message: 'Lark tenant is not mapped to any company workspace',
          data: {
            reason: 'company_context_missing',
            larkTenantKey,
          },
        });
      }

      const verificationConfig = scopedCompanyId
        ? await dependencies.resolveWorkspaceVerificationConfig(scopedCompanyId)
        : null;
      const verification = dependencies.verifyRequest({
        headers: req.headers,
        rawBody,
        parsedBody: req.body,
      }, {
        config: verificationConfig ?? undefined,
      });
      if (!verification.ok) {
        const statusCode = mapVerificationReasonToHttpStatus(verification.reason);
        dependencies.log.warn('lark.ingress.rejected', {
          requestId,
          reason: verification.reason,
          statusCode,
        });
        emitRuntimeTrace({
          event: 'lark.ingress.rejected',
          level: 'warn',
          requestId,
          metadata: {
            reason: verification.reason,
            statusCode,
          },
        });
        return res.status(statusCode).json({
          success: false,
          message: `Lark webhook rejected: ${verification.reason}`,
        });
      }
      dependencies.log.info('lark.ingress.verified', {
        requestId,
        larkTenantKey,
        companyId: scopedCompanyId ?? undefined,
      });
      dependencies.log.debug('lark.webhook.contract.parsed', {
        requestId,
        kind: parsed.kind,
        reason: parsed.kind === 'invalid' || parsed.kind === 'event_callback_ignored' ? parsed.reason : undefined,
        eventType: isMetadataParseResult(parsed) ? parsed.eventType : undefined,
        eventId: isMetadataParseResult(parsed) ? parsed.eventId : undefined,
        larkTenantKey: isMetadataParseResult(parsed) ? parsed.larkTenantKey : undefined,
      });

      if (parsed.kind === 'url_verification') {
        dependencies.log.success('lark.webhook.url_verification.accepted', {
          requestId,
        });
        return res.status(200).json({
          challenge: parsed.challenge,
        });
      }

      if (parsed.kind === 'event_callback_ignored') {
        dependencies.log.info('lark.webhook.event.ignored', {
          requestId,
          reason: parsed.reason,
          eventType: parsed.eventType,
          eventId: parsed.eventId,
          larkTenantKey: parsed.larkTenantKey,
        });
        return res.status(202).json({
          success: true,
          message: 'Lark event ignored by ingress contract',
          data: {
            reason: parsed.reason,
            eventType: parsed.eventType,
            eventId: parsed.eventId,
            larkTenantKey: parsed.larkTenantKey,
          },
        });
      }

      if (parsed.kind === 'invalid') {
        dependencies.log.warn('lark.webhook.contract.invalid', {
          requestId,
          reason: parsed.reason,
          details: parsed.details,
        });
        return res.status(400).json({
          success: false,
          message: 'Invalid Lark webhook payload',
          data: {
            reason: parsed.reason,
            details: parsed.details,
          },
        });
      }

      const normalized = dependencies.adapter.normalizeIncomingEvent(parsed.envelope);
      if (!normalized) {
        const envelopeRecord = parsed.envelope as Record<string, unknown>;
        const eventRecord =
          envelopeRecord.event && typeof envelopeRecord.event === 'object'
            ? (envelopeRecord.event as Record<string, unknown>)
            : undefined;
        const operatorRecord =
          eventRecord?.operator && typeof eventRecord.operator === 'object'
            ? (eventRecord.operator as Record<string, unknown>)
            : undefined;
        const contextRecord =
          eventRecord?.context && typeof eventRecord.context === 'object'
            ? (eventRecord.context as Record<string, unknown>)
            : undefined;
        const actionRecord =
          eventRecord?.action && typeof eventRecord.action === 'object'
            ? (eventRecord.action as Record<string, unknown>)
            : undefined;
        const hostRecord =
          eventRecord?.host && typeof eventRecord.host === 'object'
            ? (eventRecord.host as Record<string, unknown>)
            : undefined;
        dependencies.log.warn('lark.webhook.contract.invalid', {
          requestId,
          reason: 'unsupported_message_shape',
          eventType: parsed.eventType,
          topLevelKeys: Object.keys(envelopeRecord),
          eventKeys: eventRecord ? Object.keys(eventRecord) : [],
          operatorKeys: operatorRecord ? Object.keys(operatorRecord) : [],
          contextKeys: contextRecord ? Object.keys(contextRecord) : [],
          actionKeys: actionRecord ? Object.keys(actionRecord) : [],
          hostKeys: hostRecord ? Object.keys(hostRecord) : [],
          operatorPreview: toCompactJson(operatorRecord),
          contextPreview: toCompactJson(contextRecord),
          actionPreview: toCompactJson(actionRecord),
          hostPreview: toCompactJson(hostRecord),
        });
        return res.status(400).json({
          success: false,
          message: 'Invalid Lark message callback payload',
          data: {
            reason: 'unsupported_message_shape',
          },
        });
      }

      // File ingestion is moved to after linkedUserId resolution below
      // so we can attribute files to the correct internal User.id when possible.
      const rawMessage = (parsed.envelope as any)?.event?.message as Record<string, unknown> | undefined;
      const msgContent = rawMessage?.content;
      const msgType = inferLarkMessageType({
        msgType: typeof rawMessage?.msg_type === 'string' ? rawMessage.msg_type : undefined,
        altMsgType: typeof rawMessage?.message_type === 'string' ? rawMessage.message_type : undefined,
        content: msgContent,
      });
      const msgId = normalized.messageId;
      const attachmentKeys = parseLarkAttachmentKeys(msgContent, msgType);
      let mentions = extractLarkMentionsFromMessage({
        content: msgContent,
        rawMentions: {
          mentions: rawMessage?.mentions,
          userMentions: rawMessage?.user_mentions,
          atUsers: rawMessage?.at_users,
        },
      });
      const hasPlaceholderMentions = /@_user_\d+\b/i.test(normalized.text);
      if (hasPlaceholderMentions && !mentions.some((mention) => mentionHasStructuredIdentity(mention))) {
        try {
          const fetchedMessage = await dependencies.adapter.getMessage({ messageId: normalized.messageId });
          if (fetchedMessage?.mentions.length) {
            const mergedMentions = [
              ...mentions,
              ...fetchedMessage.mentions,
            ];
            const seen = new Set<string>();
            mentions = mergedMentions.filter((mention) => {
              const key = `${mention.id ?? ''}|${mention.token ?? ''}|${mention.name ?? ''}`;
              if (!key.trim() || seen.has(key)) {
                return false;
              }
              seen.add(key);
              return true;
            });
            dependencies.log.debug('lark.webhook.message.mentions_fetched', {
              requestId,
              eventId: parsed.eventId,
              messageId: normalized.messageId,
              mentionCount: mentions.length,
            });
          }
        } catch (error) {
          dependencies.log.warn('lark.webhook.message.mentions_fetch_failed', {
            requestId,
            eventId: parsed.eventId,
            messageId: normalized.messageId,
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }
      }
      orangeDebug('lark.ingress.normalized', {
        requestId,
        eventId: parsed.eventId,
        msgType: msgType ?? 'text',
        messageId: normalized.messageId,
        chatId: normalized.chatId,
        userId: normalized.userId,
        textPreview: normalized.text.slice(0, 120),
        attachmentKeyCount: attachmentKeys.length,
        mentionCount: mentions.length,
      });

      dependencies.log.info('lark.webhook.message.normalized', {
        requestId,
        eventId: parsed.eventId,
        larkTenantKey,
        companyId: scopedCompanyId ?? undefined,
        channel: normalized.channel,
        userId: normalized.userId,
        chatId: normalized.chatId,
        chatType: normalized.chatType,
        messageId: normalized.messageId,
        timestamp: normalized.timestamp,
        messageAgeMs: readMessageAgeMs(normalized.timestamp),
        textPreview: normalized.text.slice(0, 120),
        textLength: normalized.text.length,
        mentionCount: mentions.length,
      });
      if (parsed.kind === 'event_callback_message') {
        const messageAgeMs = readMessageAgeMs(normalized.timestamp);
        const maxAcceptedAgeMs = config.LARK_WEBHOOK_MAX_SKEW_SECONDS * 1000;

        if (messageAgeMs !== null && messageAgeMs > maxAcceptedAgeMs) {
          dependencies.log.info('lark.webhook.event.ignored', {
            requestId,
            reason: 'stale_message_delivery',
            eventType: parsed.eventType,
            eventId: parsed.eventId,
            larkTenantKey,
            companyId: scopedCompanyId ?? undefined,
            messageId: normalized.messageId,
            chatId: normalized.chatId,
            messageAgeMs,
            maxAcceptedAgeMs,
          });
          return res.status(202).json({
            success: true,
            message: 'Lark event ignored because the message is too old to process safely',
            data: {
              reason: 'stale_message_delivery',
              eventType: parsed.eventType,
              eventId: parsed.eventId,
              messageId: normalized.messageId,
              chatId: normalized.chatId,
              messageAgeMs,
              maxAcceptedAgeMs,
            },
          });
        }
      }

      let channelIdentityId: string | undefined;
      let requesterEmail: string | undefined;
      let userRole = 'MEMBER';
      let mentionDirectory: CachedLarkMentionDirectory | null = null;
      let resolvedText = normalized.text;
      let botMentioned = false;
      let resolvedMentionNames: string[] = [];
      // linkedUserId bridges the Lark channel identity to the user's internal Desktop account.
      // When set, the orchestration engine will use this as the ownerUserId in Qdrant so that
      // personal vector memory is shared across both channels for the same person.
      let linkedUserId: string | undefined;

      if (!scopedCompanyId || !normalized.userId || !larkTenantKey) {
        dependencies.log.debug('lark.channel_identity.skipped', {
          requestId,
          reason: !scopedCompanyId ? 'no_company_binding' : !larkTenantKey ? 'no_tenant_key' : 'no_user_id',
          larkTenantKey,
          userId: normalized.userId,
        });
      } else {
        try {
          const identity = await dependencies.upsertChannelIdentity({
            channel: 'lark',
            externalUserId: normalized.userId,
            externalTenantId: larkTenantKey,
            companyId: scopedCompanyId,
            larkOpenId: normalized.trace?.larkOpenId,
            larkUserId: normalized.trace?.larkUserId,
          });
          channelIdentityId = identity.id;
          if (typeof identity.email === 'string' && identity.email.trim().length > 0) {
            requesterEmail = identity.email.trim();
          }
          userRole = identity.aiRole;
          if (identity.isNew) {
            dependencies.log.info('lark.channel_identity.provisioned', {
              requestId,
              channelIdentityId: identity.id,
              channel: 'lark',
              externalUserId: normalized.userId,
              externalTenantId: larkTenantKey,
              companyId: scopedCompanyId,
              aiRole: identity.aiRole,
            });
          } else {
            dependencies.log.debug('lark.channel_identity.resolved', {
              requestId,
              channelIdentityId: identity.id,
              channel: 'lark',
              externalUserId: normalized.userId,
              companyId: scopedCompanyId,
              aiRole: identity.aiRole,
            });
          }
        } catch (error) {
          dependencies.log.warn('lark.channel_identity.upsert_failed', {
            requestId,
            channel: 'lark',
            externalUserId: normalized.userId,
            externalTenantId: larkTenantKey,
            companyId: scopedCompanyId,
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }

        // Resolve linked internal user ID for cross-channel vector memory unification.
        // This lookup is non-critical — a failure here degrades gracefully (memory stays
        // channel-scoped) but does NOT break message processing.
        try {
          const resolved = await dependencies.resolveLinkedUserId({
            companyId: scopedCompanyId,
            larkOpenId: normalized.trace?.larkOpenId,
            larkUserId: normalized.trace?.larkUserId,
          });
          if (resolved) {
            linkedUserId = resolved;
            dependencies.log.debug('lark.linked_user.resolved', {
              requestId,
              channelIdentityId,
              linkedUserId,
              companyId: scopedCompanyId,
            });
          }
        } catch (error) {
          dependencies.log.warn('lark.linked_user.resolve_failed', {
            requestId,
            companyId: scopedCompanyId,
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }
      }

      if (scopedCompanyId) {
        try {
          mentionDirectory = await getCachedLarkMentionDirectory(scopedCompanyId, dependencies);
          resolvedText = replaceLarkMentionTokens({
            text: normalized.text,
            mentions,
            resolveDisplayName: (mention) => resolveLarkMentionDisplayName(mention, mentionDirectory),
          });
        } catch (error) {
          dependencies.log.warn('lark.mention_directory.resolve_failed', {
            requestId,
            companyId: scopedCompanyId,
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }
      }

      resolvedMentionNames = mentions
        .map((mention) => resolveLarkMentionDisplayName(mention, mentionDirectory))
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      botMentioned = mentions.some((mention) => isDivoMention(mention, mentionDirectory))
        || textDirectlyMentionsDivo(resolvedText);

      dependencies.log.info('lark.webhook.message.mentions_resolved', {
        requestId,
        eventId: parsed.eventId,
        companyId: scopedCompanyId ?? undefined,
        messageId: normalized.messageId,
        chatId: normalized.chatId,
        mentionCount: mentions.length,
        botMentioned,
        resolvedMentionNames,
        textPreview: resolvedText.slice(0, 120),
      });

      const textHash = buildLarkTextHash(resolvedText);
      const attentionOnly = isAttentionOnlyText(resolvedText);

      const tracedMessageBase: NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>> = {
        ...normalized,
        text: resolvedText,
        trace: {
          ...(normalized.trace ?? {}),
          requestId,
          eventId: parsed.eventId,
          textHash,
          receivedAt: new Date().toISOString(),
          larkTenantKey,
          channelTenantId: larkTenantKey,
          companyId: scopedCompanyId ?? undefined,
          channelIdentityId,
          linkedUserId,
          userRole,
          requesterEmail,
          attentionOnly,
          replyToMessageId: normalized.messageId,
        },
      };
      const sendLarkReply = async (input: {
        text: string;
        format?: 'interactive' | 'text';
      }) => dependencies.adapter.sendMessage({
        chatId: tracedMessageBase.chatId,
        text: input.text,
        format: input.format,
        correlationId: requestId,
        replyToMessageId: tracedMessageBase.messageId,
        replyInThread: tracedMessageBase.chatType === 'group',
      });

      let attachedFiles = normalized.attachedFiles ?? [];
      const effectiveUploaderId = linkedUserId ?? channelIdentityId ?? normalized.userId;
      const allowedRoles = scopedCompanyId
        ? await resolveAllowedRolesForVisibilityScope({
          companyId: scopedCompanyId,
          visibilityScope: tracedMessageBase.chatType === 'group' ? 'same_role' : 'personal',
          uploaderRole: userRole || 'MEMBER',
        })
        : [];

      const primaryIdempotency = buildPrimaryIngressIdempotencyKey({
        channel: tracedMessageBase.channel,
        eventId: parsed.eventId,
        messageId: tracedMessageBase.messageId,
      });
      let claimedPrimary = false;
      try {
        claimedPrimary = await dependencies.claimIngressKey(
          tracedMessageBase.channel,
          primaryIdempotency.keyType,
          primaryIdempotency.key,
        );
      } catch (error) {
        dependencies.log.error('lark.ingress.idempotency_unavailable', {
          ...buildIngressTraceMeta({
            requestId,
            message: tracedMessageBase,
            eventId: parsed.eventId,
            idempotencyKey: primaryIdempotency.idempotencyKey,
            keyType: primaryIdempotency.keyType,
            textHash,
            larkTenantKey,
            companyId: scopedCompanyId ?? undefined,
          }),
          error,
        });
        return res.status(503).json({
          success: false,
          message: 'Ingress idempotency store unavailable, please retry.',
        });
      }

      if (!claimedPrimary) {
        orangeDebug('lark.ingress.duplicate', {
          requestId,
          eventId: parsed.eventId,
          messageId: tracedMessageBase.messageId,
          chatId: tracedMessageBase.chatId,
          keyType: primaryIdempotency.keyType,
        });
        dependencies.log.info('lark.ingress.duplicate_ignored', {
          ...buildIngressTraceMeta({
            requestId,
            message: tracedMessageBase,
            eventId: parsed.eventId,
            idempotencyKey: primaryIdempotency.idempotencyKey,
            keyType: primaryIdempotency.keyType,
            textHash,
            larkTenantKey,
            companyId: scopedCompanyId ?? undefined,
          }),
        });
        return res.status(202).json(buildDuplicateIgnoredResponse({
          message: tracedMessageBase,
          keyType: primaryIdempotency.keyType,
          idempotencyKey: primaryIdempotency.idempotencyKey,
        }));
      }

      if (parsed.kind === 'event_callback_message' && primaryIdempotency.keyType === 'event' && tracedMessageBase.messageId) {
        const messageAliasIdempotencyKey = toIdempotencyStorageKey(
          tracedMessageBase.channel,
          'message',
          tracedMessageBase.messageId,
        );
        try {
          const claimedMessageAlias = await dependencies.claimIngressKey(
            tracedMessageBase.channel,
            'message',
            tracedMessageBase.messageId,
          );
          if (!claimedMessageAlias) {
            dependencies.log.info('lark.ingress.duplicate_ignored', {
              ...buildIngressTraceMeta({
                requestId,
                message: tracedMessageBase,
                eventId: parsed.eventId,
                idempotencyKey: messageAliasIdempotencyKey,
                keyType: 'message',
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId ?? undefined,
              }),
            });
            return res.status(202).json(buildDuplicateIgnoredResponse({
              message: tracedMessageBase,
              keyType: 'message',
              idempotencyKey: messageAliasIdempotencyKey,
            }));
          }
        } catch (error) {
          dependencies.log.warn('lark.webhook.idempotency.alias_claim_failed', {
            ...buildIngressTraceMeta({
              requestId,
              message: tracedMessageBase,
              eventId: parsed.eventId,
              textHash,
              larkTenantKey,
              companyId: scopedCompanyId ?? undefined,
            }),
            error,
          });
        }
      }

      if (attachmentKeys.length > 0 && scopedCompanyId && normalized.userId) {
        try {
          const ingested = await ingestLarkAttachments({
            messageId: msgId,
            chatId: normalized.chatId,
            attachmentKeys,
            adapter: dependencies.adapter,
            companyId: scopedCompanyId,
            uploaderUserId: effectiveUploaderId,
            allowedRoles,
          });
          if (ingested.length > 0) {
            attachedFiles = [...attachedFiles, ...ingested];
            orangeDebug('lark.ingress.attachments.ingested', {
              requestId,
              eventId: parsed.eventId,
              messageId: msgId,
              chatId: normalized.chatId,
              linkedUserId: linkedUserId ?? null,
              effectiveUploaderId,
              fileAssetIds: ingested.map((file) => file.fileAssetId),
              allowedRoles,
            });
            dependencies.log.info('lark.file.ingestion.completed', {
              requestId,
              messageId: msgId,
              fileCount: ingested.length,
              fileAssetIds: ingested.map((f) => f.fileAssetId),
              linkedUserId: linkedUserId ?? null,
              effectiveUploaderId,
              allowedRoles,
            });
          }
        } catch (fileErr) {
          dependencies.log.warn('lark.file.ingestion.batch_failed', {
            requestId,
            messageId: msgId,
            error: fileErr instanceof Error ? fileErr.message : 'unknown_error',
          });
        }
      }

      if (parsed.kind === 'event_callback_message' && isLarkCommandMenuCommand(tracedMessageBase.text)) {
        await sendLarkReply({ text: buildLarkCommandMenuText() });
        return res.status(202).json({
          success: true,
          message: 'Command menu handled',
        });
      }

      if (parsed.kind === 'event_callback_message' && isLarkInterruptCommand(tracedMessageBase.text)) {
        const { orchestrationRuntime } = require('../../queue/runtime') as typeof import('../../queue/runtime');
        const conversationState = runtimeTaskStore.getConversationExecutionState('lark', tracedMessageBase.chatId);
        if (!conversationState.runningTask) {
          await sendLarkReply({ text: 'No active run is currently executing in this Lark chat.' });
          return res.status(202).json({
            success: true,
            message: 'Interrupt command handled with no active run',
          });
        }

        await orchestrationRuntime.control(conversationState.runningTask.taskId, 'cancelled');
        await sendLarkReply({
          text: [
            'Interrupt requested.',
            '',
            `Stopped active task ${conversationState.runningTask.taskId}.`,
            'Any queued message in this chat will continue after cancellation settles.',
          ].join('\n'),
        });
        return res.status(202).json({
          success: true,
          message: 'Interrupt command handled',
          data: {
            taskId: conversationState.runningTask.taskId,
          },
        });
      }

      const workflowCommand = parsed.kind === 'event_callback_message'
        ? parseLarkWorkflowCommand(tracedMessageBase.text)
        : null;
      const memoryCommand = parsed.kind === 'event_callback_message'
        ? parseLarkMemoryCommand(tracedMessageBase.text)
        : null;
      const shareCommand = parsed.kind === 'event_callback_message'
        ? parseLarkShareCommand(tracedMessageBase.text)
        : null;
      const shouldStoreGroupContextMessage =
        parsed.kind === 'event_callback_message'
        && tracedMessageBase.chatType === 'group'
        && Boolean(scopedCompanyId)
        && (msgType === 'text' || msgType === 'post' || attachedFiles.length > 0)
        && !isLarkCommandMenuCommand(tracedMessageBase.text)
        && !isLarkInterruptCommand(tracedMessageBase.text)
        && !workflowCommand
        && !memoryCommand
        && !shareCommand
        && !isLarkClearContextCommand(tracedMessageBase.text);

      if (shouldStoreGroupContextMessage) {
        try {
          await larkChatContextService.appendMessage({
            companyId: scopedCompanyId!,
            chatId: tracedMessageBase.chatId,
            chatType: tracedMessageBase.chatType,
            messageId: tracedMessageBase.messageId,
            role: 'user',
            content: tracedMessageBase.text,
            metadata: {
              userId: tracedMessageBase.userId,
              requesterEmail,
              larkOpenId: tracedMessageBase.trace?.larkOpenId,
              larkUserId: tracedMessageBase.trace?.larkUserId,
              referencedMessageId: tracedMessageBase.trace?.referencedMessageId,
              mentionCount: mentions.length,
              botMentioned,
              resolvedMentions: resolvedMentionNames.length > 0 ? resolvedMentionNames : undefined,
              attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
            },
          });
          if (attachedFiles.length > 0 && scopedCompanyId) {
            const context = await larkChatContextService.load({
              companyId: scopedCompanyId,
              chatId: tracedMessageBase.chatId,
              chatType: tracedMessageBase.chatType,
            });
            await larkChatContextService.updateMemory({
              companyId: scopedCompanyId,
              chatId: tracedMessageBase.chatId,
              chatType: tracedMessageBase.chatType,
              taskState: upsertDesktopSourceArtifacts({
                taskState: context.taskState ?? createEmptyTaskState(),
                artifacts: buildSourceArtifactEntriesFromNormalizedFiles(attachedFiles),
              }),
            });
          }
        } catch (error) {
          dependencies.log.warn('lark.chat_context.append_failed', {
            ...buildIngressTraceMeta({
              requestId,
              message: tracedMessageBase,
              eventId: parsed.eventId,
              textHash,
              larkTenantKey,
              companyId: scopedCompanyId ?? undefined,
            }),
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }
      }

      if (
        parsed.kind === 'event_callback_message'
        && tracedMessageBase.chatType === 'group'
        && !botMentioned
      ) {
        dependencies.log.info('lark.webhook.event.ignored', {
          requestId,
          reason: 'group_message_without_bot_mention',
          eventType: parsed.eventType,
          eventId: parsed.eventId,
          larkTenantKey,
          companyId: scopedCompanyId ?? undefined,
          messageId: tracedMessageBase.messageId,
          chatId: tracedMessageBase.chatId,
          chatType: tracedMessageBase.chatType,
          mentionCount: mentions.length,
          resolvedMentionNames,
        });
        return res.status(202).json({
          success: true,
          message: 'Lark group message stored in shared chat context but not executed because the bot was not mentioned',
          data: {
            reason: 'group_message_without_bot_mention',
            eventType: parsed.eventType,
            eventId: parsed.eventId,
            messageId: tracedMessageBase.messageId,
            chatId: tracedMessageBase.chatId,
          },
        });
      }

      if (parsed.kind === 'event_callback_message' && memoryCommand) {
        if (!scopedCompanyId || !linkedUserId) {
          await sendLarkReply({ text: 'Memory commands need a linked desktop account for this Lark user. Link your account first, then retry.' });
          return res.status(202).json({
            success: true,
            message: 'Memory command handled without linked account',
          });
        }

        if (memoryCommand.kind === 'help') {
          await sendLarkReply({ text: buildLarkMemoryHelpText() });
          return res.status(202).json({
            success: true,
            message: 'Memory help command handled',
          });
        }

        if (memoryCommand.kind === 'clear') {
          await memoryService.clearUserMemory({
            companyId: scopedCompanyId,
            userId: linkedUserId,
          });
          await sendLarkReply({ text: 'Cleared durable personal memories for your linked account.' });
          return res.status(202).json({
            success: true,
            message: 'Memory clear command handled',
          });
        }

        const listed = await memoryService.listForUser({
          companyId: scopedCompanyId,
          userId: linkedUserId,
        });

        if (memoryCommand.kind === 'list') {
          await sendLarkReply({
            text: formatLarkMemoryListText(listed.items.map((item) => ({
              id: item.id,
              kindLabel: item.kindLabel,
              summary: item.summary,
              scopeLabel: item.scope === 'thread_pinned' ? 'thread' : 'global',
            }))),
          });
          return res.status(202).json({
            success: true,
            message: 'Memory list command handled',
            data: { count: listed.items.length },
          });
        }

        const reference = memoryCommand.reference.trim();
        const byIndex = Number.parseInt(reference, 10);
        const target = Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= listed.items.length
          ? listed.items[byIndex - 1]
          : listed.items.find((item) => item.id === reference);
        if (!target) {
          await sendLarkReply({ text: `No active memory matched "${reference}". Use /memory to list current entries.` });
          return res.status(202).json({
            success: true,
            message: 'Memory forget command handled with no match',
          });
        }

        await memoryService.forgetMemory({
          companyId: scopedCompanyId,
          userId: linkedUserId,
          memoryId: target.id,
        });
        await sendLarkReply({ text: `Forgot memory: ${target.summary}` });
        return res.status(202).json({
          success: true,
          message: 'Memory forget command handled',
          data: { memoryId: target.id },
        });
      }

      if (parsed.kind === 'event_callback_message' && shareCommand) {
        if (!scopedCompanyId || !linkedUserId) {
          await sendLarkReply({ text: 'Share commands need a linked desktop account for this Lark user. Link your account first, then retry.' });
          return res.status(202).json({
            success: true,
            message: 'Share command handled without linked account',
          });
        }

        const shareToolsAllowed = await toolPermissionService.isAllowed(
          scopedCompanyId,
          'share_chat_vectors',
          userRole,
        );
        if (!shareToolsAllowed) {
          await sendLarkReply({ text: 'You do not currently have permission to share chat knowledge.' });
          return res.status(202).json({
            success: true,
            message: 'Share command blocked by permissions',
          });
        }

        const statusCoordinator = new LarkStatusCoordinator({
          adapter: dependencies.adapter,
          chatId: tracedMessageBase.chatId,
          correlationId: requestId,
          replyToMessageId: tracedMessageBase.messageId,
          replyInThread: tracedMessageBase.chatType === 'group',
        });

        try {
          await statusCoordinator.update({
            text: 'Checking the current chat context and preparing the share request...',
          }, { force: true });

          const conversationKey = await buildLarkConversationKeyForShare({
            companyId: scopedCompanyId,
            linkedUserId,
            chatId: tracedMessageBase.chatId,
            chatType: tracedMessageBase.chatType,
          });

          await statusCoordinator.update({
            text: 'Reviewing this chat and deciding whether it can be shared directly or needs admin approval...',
          });

          const result = await knowledgeShareService.requestConversationShare({
            companyId: scopedCompanyId,
            requesterUserId: linkedUserId,
            requesterChannelIdentityId: channelIdentityId ?? undefined,
            requesterAiRole: userRole,
            conversationKey,
            humanReason: shareCommand.reason,
          });

          await statusCoordinator.replace(formatLarkShareCommandResult({
            status: result.status,
            classification: result.classification,
            promotedVectorCount: result.promotedVectorCount ?? 0,
          }));
          await statusCoordinator.close();
          return res.status(202).json({
            success: true,
            message: 'Share command handled',
            data: {
              conversationKey,
              status: result.status,
              classification: result.classification,
              promotedVectorCount: result.promotedVectorCount ?? 0,
            },
          });
        } catch (error) {
          await statusCoordinator.replace(
            `Share command failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
          await statusCoordinator.close();
          return res.status(202).json({
            success: true,
            message: 'Share command failed gracefully',
          });
        }
      }

      if (parsed.kind === 'event_callback_message' && workflowCommand) {
        if (!scopedCompanyId || !linkedUserId) {
          await sendLarkReply({ text: 'Workflow commands need a linked desktop account for this Lark user. Link your account first, then retry.' });
          return res.status(202).json({
            success: true,
            message: 'Workflow command handled without linked account',
          });
        }

        const workflowSession = buildLarkWorkflowSession({
          userId: linkedUserId,
          companyId: scopedCompanyId,
          aiRole: userRole,
          email: requesterEmail,
          larkTenantKey,
          larkOpenId: normalized.trace?.larkOpenId,
          larkUserId: normalized.trace?.larkUserId,
        });

        try {
          const statusCoordinator = new LarkStatusCoordinator({
            adapter: dependencies.adapter,
            chatId: tracedMessageBase.chatId,
            correlationId: requestId,
            replyToMessageId: tracedMessageBase.messageId,
            replyInThread: tracedMessageBase.chatType === 'group',
          });
          const workflowToolsAllowed = await toolPermissionService.isAllowed(
            scopedCompanyId,
            'workflow-authoring',
            userRole,
          );
          if (!workflowToolsAllowed) {
            await statusCoordinator.replace('You do not currently have permission to use saved workflow commands in this workspace.');
            await statusCoordinator.close();
            return res.status(202).json({
              success: true,
              message: 'Workflow command blocked by permissions',
            });
          }

          if (workflowCommand.kind === 'list') {
            await statusCoordinator.update({
              text: 'Checking your saved workflows...',
            }, { force: true });
            const workflows = await desktopWorkflowsService.listVisibleSummaries(workflowSession);
            await statusCoordinator.replace(formatWorkflowListText(workflows));
            await statusCoordinator.close();
            return res.status(202).json({
              success: true,
              message: 'Workflow list command handled',
              data: { count: workflows.length },
            });
          }

          await statusCoordinator.update({
            text: `Looking up saved workflow "${workflowCommand.reference}"...`,
          }, { force: true });
          const resolved = await desktopWorkflowsService.resolveVisibleWorkflow(workflowSession, workflowCommand.reference);
          if (resolved.status === 'not_found') {
            await statusCoordinator.replace(`No saved workflow matched "${workflowCommand.reference}". Use /workflows to list your saved workflows.`);
            await statusCoordinator.close();
            return res.status(202).json({
              success: true,
              message: 'Workflow command handled with no match',
            });
          }
          if (resolved.status === 'ambiguous') {
            await statusCoordinator.replace(formatWorkflowAmbiguityText(workflowCommand.reference, resolved.candidates));
            await statusCoordinator.close();
            return res.status(202).json({
              success: true,
              message: 'Workflow command handled with ambiguity',
              data: { count: resolved.candidates.length },
            });
          }

          await statusCoordinator.update({
            text: `Running workflow "${resolved.workflow.name}"...`,
          }, { force: true });
          statusCoordinator.startHeartbeat(() => ({
            text: `Workflow "${resolved.workflow.name}" is still running...`,
          }));
          const run = await desktopWorkflowsService.runNow(
            workflowSession,
            typeof resolved.workflow.id === 'string' ? resolved.workflow.id : workflowCommand.reference,
            null,
            async (phase) => {
              await statusCoordinator.update({
                text: [
                  `Running workflow "${resolved.workflow.name}"...`,
                  '',
                  phase.trim(),
                ].join('\n'),
              });
            },
          );
          await statusCoordinator.replace(formatWorkflowRunResultText({
            workflowName: resolved.workflow.name,
            status: run.status,
            resultSummary: run.resultSummary,
            errorSummary: run.errorSummary,
            threadId: run.threadId,
          }));
          await statusCoordinator.close();
          return res.status(202).json({
            success: true,
            message: 'Workflow run command handled',
            data: {
              workflowId: run.workflowId,
              runId: run.runId,
              status: run.status,
            },
          });
        } catch (error) {
          dependencies.log.warn('lark.workflow_command.failed', {
            ...buildIngressTraceMeta({
              requestId,
              message: tracedMessageBase,
              eventId: parsed.eventId,
              textHash,
              larkTenantKey,
              companyId: scopedCompanyId,
            }),
            command: tracedMessageBase.text,
            error: error instanceof Error ? error.message : 'unknown_error',
          });
          await sendLarkReply({ text: `Workflow command failed: ${error instanceof Error ? error.message : 'Unknown error'}` });
          return res.status(202).json({
            success: true,
            message: 'Workflow command failed gracefully',
          });
        }
      }

      if (parsed.kind === 'event_callback_message' && isLarkClearContextCommand(tracedMessageBase.text)) {
        try {
          if (scopedCompanyId && tracedMessageBase.chatType === 'group') {
            await larkChatContextService.clear({
              companyId: scopedCompanyId,
              chatId: tracedMessageBase.chatId,
            });
            conversationMemoryStore.clearConversation(`lark-chat:${tracedMessageBase.chatId}`);
            dependencies.log.info('lark.chat_context.cleared', {
              ...buildIngressTraceMeta({
                requestId,
                message: tracedMessageBase,
                eventId: parsed.eventId,
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId,
              }),
              mode: 'shared_group_context_cleared',
            });
          } else if (scopedCompanyId && linkedUserId) {
            const rotated = await desktopThreadsService.clearLarkLifetimeThreadContext(
              linkedUserId,
              scopedCompanyId,
            );
            dependencies.log.info('lark.chat_context.cleared', {
              ...buildIngressTraceMeta({
                requestId,
                message: tracedMessageBase,
                eventId: parsed.eventId,
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId,
              }),
              previousThreadId: rotated.previous?.id ?? null,
              currentThreadId: rotated.current.id,
              mode: 'persistent_thread_rotated',
            });
          } else {
            conversationMemoryStore.clearConversation(`${tracedMessageBase.channel}:${tracedMessageBase.chatId}`);
            dependencies.log.info('lark.chat_context.cleared', {
              ...buildIngressTraceMeta({
                requestId,
                message: tracedMessageBase,
                eventId: parsed.eventId,
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId ?? undefined,
              }),
              mode: 'conversation_memory_only',
            });
          }

          await sendLarkReply({
            text: [
              'Started a fresh chat context.',
              '',
              'Previous Lark chat context will not be used for the next turns.',
              'Stored memories and vectors were kept.',
            ].join('\n'),
          });

          return res.status(202).json({
            success: true,
            message: 'Lark chat context cleared',
            data: {
              channel: tracedMessageBase.channel,
              messageId: tracedMessageBase.messageId,
              chatId: tracedMessageBase.chatId,
              cleared: true,
            },
          });
        } catch (error) {
          dependencies.log.warn('lark.chat_context.clear_failed', {
            ...buildIngressTraceMeta({
              requestId,
              message: tracedMessageBase,
              eventId: parsed.eventId,
              textHash,
              larkTenantKey,
              companyId: scopedCompanyId ?? undefined,
            }),
            error: error instanceof Error ? error.message : 'unknown_error',
          });
          throw error;
        }
      }

      const shouldConsumeRecentFiles =
        parsed.kind === 'event_callback_message'
        && attachmentKeys.length === 0
        && (msgType === 'text' || msgType === 'post');

      if (shouldConsumeRecentFiles) {
        const recentFiles = larkRecentFilesStore.consume(normalized.chatId);
        if (recentFiles.length > 0) {
          attachedFiles = [...attachedFiles, ...recentFiles];
          dependencies.log.info('lark.ingress.recent_attachments_consumed', {
            ...buildIngressTraceMeta({
              requestId,
              message: tracedMessageBase,
              eventId: parsed.eventId,
              textHash,
              larkTenantKey,
              companyId: scopedCompanyId ?? undefined,
            }),
            consumedFileCount: recentFiles.length,
            fileAssetIds: recentFiles.map((file) => file.fileAssetId),
          });
        }
      }

      let referencedMessageText: string | undefined;
      const referencedMessageId = normalized.trace?.referencedMessageId?.trim();
      if (parsed.kind === 'event_callback_message' && referencedMessageId) {
        let referencedAttachedFiles: NonNullable<NormalizedIncomingMessageDTO['attachedFiles']> = [];

        if (scopedCompanyId && tracedMessageBase.chatType === 'group') {
          try {
            const context = await larkChatContextService.load({
              companyId: scopedCompanyId,
              chatId: tracedMessageBase.chatId,
              chatType: tracedMessageBase.chatType,
            });
            const referencedMessage = [...context.recentMessages]
              .reverse()
              .find((message) => message.id === referencedMessageId);
            if (referencedMessage) {
              referencedMessageText = referencedMessage.content.trim() || undefined;
              referencedAttachedFiles = parseAttachedFilesFromUnknown(referencedMessage.metadata?.attachedFiles);
            }
          } catch (error) {
            dependencies.log.warn('lark.referenced_message.context_lookup_failed', {
              ...buildIngressTraceMeta({
                requestId,
                message: tracedMessageBase,
                eventId: parsed.eventId,
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId ?? undefined,
              }),
              referencedMessageId,
              error: error instanceof Error ? error.message : 'unknown_error',
            });
          }
        }

        if ((referencedAttachedFiles.length === 0 && !referencedMessageText) || tracedMessageBase.chatType !== 'group') {
          try {
            const referencedMessage = await dependencies.adapter.getMessage({
              messageId: referencedMessageId,
            });
            if (referencedMessage) {
              const fetchedReferenceText = referencedMessage.text.trim();
              referencedMessageText = referencedMessageText ?? (fetchedReferenceText || undefined);
              if (referencedAttachedFiles.length === 0 && referencedMessage.attachmentKeys.length > 0 && scopedCompanyId) {
                referencedAttachedFiles = await ingestLarkAttachments({
                  messageId: referencedMessage.messageId,
                  chatId: normalized.chatId,
                  attachmentKeys: referencedMessage.attachmentKeys,
                  adapter: dependencies.adapter,
                  companyId: scopedCompanyId,
                  uploaderUserId: effectiveUploaderId,
                  allowedRoles,
                });
              }
            }
          } catch (error) {
            dependencies.log.warn('lark.referenced_message.fetch_failed', {
              ...buildIngressTraceMeta({
                requestId,
                message: tracedMessageBase,
                eventId: parsed.eventId,
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId ?? undefined,
              }),
              referencedMessageId,
              error: error instanceof Error ? error.message : 'unknown_error',
            });
          }
        }

        if (referencedAttachedFiles.length > 0) {
          attachedFiles = dedupeAttachedFiles([...attachedFiles, ...referencedAttachedFiles]);
        }

        if (referencedMessageText || referencedAttachedFiles.length > 0) {
          dependencies.log.info('lark.ingress.referenced_message_resolved', {
            ...buildIngressTraceMeta({
              requestId,
              message: tracedMessageBase,
              eventId: parsed.eventId,
              textHash,
              larkTenantKey,
              companyId: scopedCompanyId ?? undefined,
            }),
            referencedMessageId,
            referencedTextLength: referencedMessageText?.length ?? 0,
            referencedFileCount: referencedAttachedFiles.length,
            referencedFileAssetIds: referencedAttachedFiles.map((file) => file.fileAssetId),
          });
        }
      }

      const tracedMessage: NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>> = {
        ...tracedMessageBase,
        text: buildReferencedMessageSupplement({
          currentText: tracedMessageBase.text,
          referencedText: referencedMessageText,
        }),
        attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
      };

      const explicitTextHitlDecision = parseHitlDecision(tracedMessage.text);
      const implicitTextHitlDecision = !explicitTextHitlDecision && parsed.kind === 'event_callback_message'
        ? parseImplicitHitlDecision(tracedMessage.text)
        : null;
      const latestPendingHitlAction = implicitTextHitlDecision
        ? await dependencies.getLatestPendingHitlAction('lark', tracedMessage.chatId)
        : null;
      const textHitlDecision = explicitTextHitlDecision
        ?? (implicitTextHitlDecision && typeof latestPendingHitlAction?.actionId === 'string'
          ? {
            actionId: latestPendingHitlAction.actionId,
            decision: implicitTextHitlDecision.decision,
          }
          : null);
      const cardHitlDecision = parsed.kind === 'event_callback_card_action'
        ? parseHitlCardDecision(parsed.actionValue)
        : null;
      const knowledgeShareCardAction = parsed.kind === 'event_callback_card_action'
        ? parseKnowledgeShareCardAction(parsed.actionValue)
        : null;
      const hitlDecision = cardHitlDecision ?? textHitlDecision;
      if (hitlDecision) {
        const pendingThreadApprovalContext = scopedCompanyId && linkedUserId
          ? await loadPendingLarkApprovalContext({
            companyId: scopedCompanyId,
            linkedUserId,
            chatId: tracedMessage.chatId,
            chatType: tracedMessage.chatType,
          })
          : null;
        const storedAction = await dependencies.getStoredHitlAction(hitlDecision.actionId);
        const fallbackStoredAction = !storedAction && implicitTextHitlDecision && pendingThreadApprovalContext
          ? buildStoredActionFromPendingApproval({
            pendingContext: pendingThreadApprovalContext,
            chatId: tracedMessage.chatId,
            companyId: scopedCompanyId!,
            requesterEmail,
            requesterAiRole: userRole,
          })
          : null;
        const approvalAction = storedAction ?? fallbackStoredAction;
        const approvalActorAllowed = await isAuthorizedApprovalActor({
          companyId: scopedCompanyId ?? undefined,
          linkedUserId,
          larkOpenId: tracedMessage.trace?.larkOpenId,
          action: approvalAction,
        });
        if (!approvalActorAllowed) {
          if (parsed.kind === 'event_callback_card_action') {
            return res.status(200).json(
              buildLarkCardActionResponse(
                'Only the assigned manager can approve or reject this action.',
                'warning',
              ),
            );
          }
          await dependencies.adapter.sendMessage({
            chatId: tracedMessage.chatId,
            text: 'Only the assigned manager can approve or reject this action.',
          });
          return res.status(202).json({
            success: true,
            message: 'Unauthorized HITL approval attempt ignored',
          });
        }
        const resolved = storedAction
          ? await dependencies.resolveHitlAction(hitlDecision.actionId, hitlDecision.decision)
          : Boolean(fallbackStoredAction);
        const actionChatId = asString((approvalAction as Record<string, unknown> | undefined)?._chatId);
        const approvalMetadata = asRecord((approvalAction as Record<string, unknown> | undefined)?.metadata);
        const actionRequesterEmail = asString(approvalMetadata?.requesterEmail);
        const actionRequesterUserId =
          asString(approvalMetadata?.sourceChannelUserId)
          ?? asString(approvalMetadata?.larkOpenId)
          ?? asString(approvalMetadata?.larkUserId)
          ?? tracedMessage.userId;
        const actionReplyToMessageId = asString(approvalMetadata?.sourceReplyToMessageId);
        const actionStatusMessageId = asString(approvalMetadata?.sourceStatusMessageId);
        const actionStatusReplyModeHint = asString(approvalMetadata?.sourceStatusReplyModeHint);
        const actionChatType = asString(approvalMetadata?.sourceChatType);
        const continuationTargetMessage: NormalizedLarkMessage =
          actionChatId && actionChatId !== tracedMessage.chatId
            ? {
                ...tracedMessage,
                userId: actionRequesterUserId,
                chatId: actionChatId,
                chatType:
                  actionChatType === 'group' || actionChatType === 'p2p'
                    ? actionChatType
                    : actionChatId.startsWith('oc_')
                      ? 'group'
                      : 'p2p',
                messageId: actionReplyToMessageId ?? tracedMessage.messageId,
                trace: {
                  ...tracedMessage.trace,
                  linkedUserId: asString(approvalMetadata?.userId) ?? tracedMessage.trace?.linkedUserId,
                  larkOpenId: asString(approvalMetadata?.larkOpenId) ?? tracedMessage.trace?.larkOpenId,
                  larkUserId: asString(approvalMetadata?.larkUserId) ?? tracedMessage.trace?.larkUserId,
                  requesterEmail: actionRequesterEmail ?? tracedMessage.trace?.requesterEmail,
                  replyToMessageId: actionReplyToMessageId ?? tracedMessage.trace?.replyToMessageId,
                  statusMessageId: actionStatusMessageId ?? tracedMessage.trace?.statusMessageId,
                  statusReplyModeHint:
                    (actionStatusReplyModeHint === 'thread'
                      || actionStatusReplyModeHint === 'reply'
                      || actionStatusReplyModeHint === 'plain'
                      || actionStatusReplyModeHint === 'dm')
                      ? actionStatusReplyModeHint
                      : tracedMessage.trace?.statusReplyModeHint,
                },
              }
            : {
                ...tracedMessage,
                userId: actionRequesterUserId,
                messageId: actionReplyToMessageId ?? tracedMessage.messageId,
                trace: {
                  ...tracedMessage.trace,
                  linkedUserId: asString(approvalMetadata?.userId) ?? tracedMessage.trace?.linkedUserId,
                  larkOpenId: asString(approvalMetadata?.larkOpenId) ?? tracedMessage.trace?.larkOpenId,
                  larkUserId: asString(approvalMetadata?.larkUserId) ?? tracedMessage.trace?.larkUserId,
                  requesterEmail: actionRequesterEmail ?? tracedMessage.trace?.requesterEmail,
                  replyToMessageId: actionReplyToMessageId ?? tracedMessage.trace?.replyToMessageId,
                  statusMessageId: actionStatusMessageId ?? tracedMessage.trace?.statusMessageId,
                  statusReplyModeHint:
                    (actionStatusReplyModeHint === 'thread'
                      || actionStatusReplyModeHint === 'reply'
                      || actionStatusReplyModeHint === 'plain'
                      || actionStatusReplyModeHint === 'dm')
                      ? actionStatusReplyModeHint
                      : tracedMessage.trace?.statusReplyModeHint,
                },
              };
        let executionSummary: string | undefined;
        let executionOk: boolean | undefined;
        let executionPayload: Record<string, unknown> | undefined;
        let executionKind: string | undefined;
        let resumedTaskId: string | undefined;
        if (resolved && hitlDecision.decision === 'confirmed' && approvalAction) {
          try {
            const executionResult = await dependencies.executeStoredHitlAction(approvalAction);
            executionKind = executionResult.kind;
            executionSummary = executionResult.summary;
            executionOk = executionResult.ok;
            executionPayload = executionResult.payload;
            await persistPendingApprovalResult({
              pendingContext: pendingThreadApprovalContext,
              actionResult: {
                kind: executionResult.kind ?? 'tool_action',
                ok: executionResult.ok,
                summary: executionResult.summary,
                payload: executionResult.payload,
              },
            });
            await maybeSendManagerAuditDm({
              adapter: dependencies.adapter,
              action: approvalAction,
              executionOk: executionResult.ok,
              executionSummary: executionResult.summary,
            });
            if (shouldAutoContinueAfterApproval({
              approvalAction,
              executionOk: executionResult.ok,
            })) {
              const continuationText = buildApprovalContinuationText({
                kind: executionResult.kind,
                ok: executionResult.ok,
                summary: executionSummary,
                actionSummary: typeof approvalAction.summary === 'string' ? approvalAction.summary : undefined,
                payload: executionResult.payload,
              });
              resumedTaskId = await continueAfterApproval({
                dependencies,
                taskId: typeof approvalAction.taskId === 'string' ? approvalAction.taskId : undefined,
                tracedMessage: continuationTargetMessage,
                requestId,
                sourceActionId: hitlDecision.actionId,
                sourceMessageId: tracedMessage.messageId,
                continuationText,
                parsedKind: parsed.kind,
                executionSummary,
                executionOk: executionResult.ok,
                executionPayload: executionResult.payload,
              });
            }
          } catch (error) {
            executionSummary = error instanceof Error ? error.message : 'Stored approval action execution failed';
            executionOk = false;
            await persistPendingApprovalResult({
              pendingContext: pendingThreadApprovalContext,
              actionResult: {
                kind: executionKind ?? 'tool_action',
                ok: false,
                summary: executionSummary,
                payload: executionPayload,
              },
            });
            await maybeSendManagerAuditDm({
              adapter: dependencies.adapter,
              action: approvalAction,
              executionOk: false,
              executionSummary,
            });
            const continuationText = buildApprovalContinuationText({
              kind: executionKind,
              ok: false,
              summary: executionSummary,
              actionSummary: typeof approvalAction.summary === 'string' ? approvalAction.summary : undefined,
              payload: executionPayload,
            });
            resumedTaskId = await continueAfterApproval({
              dependencies,
              taskId: typeof approvalAction.taskId === 'string' ? approvalAction.taskId : undefined,
              tracedMessage: continuationTargetMessage,
              requestId,
              sourceActionId: hitlDecision.actionId,
              sourceMessageId: tracedMessage.messageId,
              continuationText,
              parsedKind: parsed.kind,
              executionSummary,
              executionOk: false,
              executionPayload,
            });
          }
        }
        if (resolved && hitlDecision.decision === 'cancelled') {
          executionKind = 'tool_action';
          executionOk = false;
          executionSummary = `User rejected ${typeof approvalAction?.summary === 'string' ? approvalAction.summary : hitlDecision.actionId}`;
          await persistPendingApprovalResult({
            pendingContext: pendingThreadApprovalContext,
            actionResult: {
              kind: 'tool_action',
              ok: false,
              summary: executionSummary,
            },
          });
          await maybeSendManagerAuditDm({
            adapter: dependencies.adapter,
            action: approvalAction,
            executionOk: false,
            executionSummary,
          });
        }
        dependencies.log.info('lark.webhook.hitl.decision', {
          ...buildIngressTraceMeta({
            requestId,
            message: tracedMessage,
            eventId: parsed.eventId,
            textHash,
            larkTenantKey,
            companyId: scopedCompanyId ?? undefined,
          }),
          actionId: hitlDecision.actionId,
          decision: hitlDecision.decision,
          resolved,
          executionOk,
          executionSummary,
          resumedTaskId,
        });
        const responseText = !resolved
          ? `Approval action ${hitlDecision.actionId} is not pending or was not found.`
          : hitlDecision.decision === 'cancelled'
            ? `Rejected request.\n\n${approvalAction && typeof approvalAction.summary === 'string' ? approvalAction.summary : hitlDecision.actionId}`
            : resumedTaskId
              ? `Approved and continuing.\n\n${executionSummary ?? approvalAction?.summary ?? hitlDecision.actionId}`
              : executionOk
                ? `Approved and executed.\n\n${executionSummary ?? approvalAction?.summary ?? hitlDecision.actionId}`
                : `Approval was recorded, but execution failed.\n\n${executionSummary ?? approvalAction?.summary ?? hitlDecision.actionId}`;
        if (parsed.kind === 'event_callback_card_action') {
          await dependencies.adapter.updateMessage({
            messageId: tracedMessage.messageId,
            text: responseText,
            actions: [],
          });
        } else {
          await dependencies.adapter.sendMessage({
            chatId: tracedMessage.chatId,
            text: responseText,
          });
        }
        if (parsed.kind === 'event_callback_card_action') {
          return res.status(200).json(
            buildLarkCardActionResponse(
              resolved
                ? hitlDecision.decision === 'cancelled'
                  ? 'Request rejected.'
                  : executionOk
                    ? 'Approved.'
                    : 'Action processed.'
                : 'Action was already handled.',
              resolved ? 'success' : 'warning',
            ),
          );
        }
        return res.status(202).json({
          success: true,
          message: 'HITL callback processed',
          data: {
            actionId: hitlDecision.actionId,
            decision: hitlDecision.decision,
            resolved,
            executionOk,
            executionSummary,
            resumedTaskId,
          },
        });
      }

      if (knowledgeShareCardAction) {
        const sendKnowledgeShareCardResponse = async (text: string) => {
          await dependencies.adapter.updateMessage({
            messageId: tracedMessage.messageId,
            text,
            actions: [],
          });
        };
        const baseMessageText = sanitizeCardActionMessageText(tracedMessage.text);
        const buildKnowledgeShareResponseText = (detail: string): string =>
          baseMessageText
            ? `${baseMessageText}\n\n${detail}`
            : detail;

        if (!linkedUserId) {
          await sendKnowledgeShareCardResponse(
            buildKnowledgeShareResponseText(
              'This knowledge-share action requires a linked Divo account.',
            ),
          );
          return res.status(200).json({
            ...buildLarkCardActionResponse(
              'This knowledge-share action requires a linked Divo account.',
              'warning',
            ),
          });
        }

        try {
          if (knowledgeShareCardAction.kind === 'request') {
            if (!scopedCompanyId) {
              await sendKnowledgeShareCardResponse(
                buildKnowledgeShareResponseText(
                  'I could not determine your company context for this share request.',
                ),
              );
              return res.status(200).json({
                ...buildLarkCardActionResponse(
                  'I could not determine your company context for this share request.',
                  'warning',
                ),
              });
            }

            const allowed = await toolPermissionService.isAllowed(
              scopedCompanyId,
              'share_chat_vectors',
              userRole,
            );
            if (!allowed) {
              await sendKnowledgeShareCardResponse(
                buildKnowledgeShareResponseText(
                  'You do not currently have permission to share chat knowledge.',
                ),
              );
              return res.status(200).json({
                ...buildLarkCardActionResponse(
                  'You do not currently have permission to share chat knowledge.',
                  'warning',
                ),
              });
            }

            const result = await knowledgeShareService.requestConversationShare({
              companyId: scopedCompanyId,
              requesterUserId: linkedUserId,
              requesterChannelIdentityId: channelIdentityId ?? undefined,
              requesterAiRole: userRole,
              conversationKey: knowledgeShareCardAction.conversationKey,
            });
            const responseText =
              result.status === 'already_shared'
                ? 'This chat knowledge is already shared.'
                : result.status === 'pending'
                  ? 'Knowledge-share request sent to admins for approval.'
                  : result.status === 'delivery_failed'
                    ? 'Knowledge was shared, but I could not notify the admins.'
                    : `Knowledge shared.\n\nPromoted ${result.promotedVectorCount ?? 0} vectors.`;
            await sendKnowledgeShareCardResponse(buildKnowledgeShareResponseText(responseText));
            return res.status(200).json({
              ...buildLarkCardActionResponse(
                result.status === 'pending'
                  ? 'Knowledge-share request sent.'
                  : result.status === 'already_shared'
                    ? 'Knowledge already shared.'
                    : 'Knowledge shared.',
              ),
            });
          }

          if (knowledgeShareCardAction.kind === 'decision') {
            const result = knowledgeShareCardAction.decision === 'approve'
              ? await knowledgeShareService.approveRequest({
                requestId: knowledgeShareCardAction.requestId,
                reviewerUserId: linkedUserId,
              })
              : await knowledgeShareService.rejectRequest({
                requestId: knowledgeShareCardAction.requestId,
                reviewerUserId: linkedUserId,
              });
            const responseText = knowledgeShareCardAction.decision === 'approve'
              ? `Knowledge share approved.\n\nPromoted ${result.promotedVectorCount ?? 0} vectors.`
              : 'Knowledge share rejected.';
            await sendKnowledgeShareCardResponse(buildKnowledgeShareResponseText(responseText));
            return res.status(200).json({
              ...buildLarkCardActionResponse(
                knowledgeShareCardAction.decision === 'approve'
                  ? 'Knowledge share approved.'
                  : 'Knowledge share rejected.',
              ),
            });
          }

          const result = await knowledgeShareService.revertRequest({
            requestId: knowledgeShareCardAction.requestId,
            reviewerUserId: linkedUserId,
          });
          const responseText = result.status === 'reverted'
            ? `Knowledge share reverted.\n\nRemoved ${result.revertedVectorCount ?? 0} shared vectors.`
            : `Knowledge share was not reverted because it is already ${result.status}.`;
          await sendKnowledgeShareCardResponse(buildKnowledgeShareResponseText(responseText));
          return res.status(200).json({
            ...buildLarkCardActionResponse(
              result.status === 'reverted'
                ? 'Knowledge share reverted.'
                : `Knowledge share is already ${result.status}.`,
            ),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Knowledge-share action failed';
          await sendKnowledgeShareCardResponse(
            buildKnowledgeShareResponseText(`Knowledge-share action failed.\n\n${message}`),
          );
          return res.status(200).json({
            ...buildLarkCardActionResponse('Knowledge-share action failed.', 'error'),
          });
        }
      }

      const shouldSendImmediateAck =
        parsed.kind === 'event_callback_message'
        && !textHitlDecision
        && msgType !== 'image'
        && msgType !== 'file'
        && msgType !== 'media';

      let ackMessageId: string | undefined;
      if (shouldSendImmediateAck) {
        try {
          const conversationState = runtimeTaskStore.getConversationExecutionState('lark', tracedMessage.chatId);
          const queuedBehindActive = Boolean(conversationState.runningTask);
          const ack = await dependencies.adapter.sendMessage({
            chatId: tracedMessage.chatId,
            text: buildIngressAckText({
              text: tracedMessage.text,
              queuedBehindActive,
              queuedCountAhead: (queuedBehindActive ? 1 : 0) + conversationState.pendingCount,
            }),
            correlationId: requestId,
            replyToMessageId: tracedMessage.messageId,
            replyInThread: false,
          });
          if (ack.status !== 'failed') {
            ackMessageId = ack.messageId ?? undefined;
            dependencies.log.info('lark.ingress.ack.sent', {
              ...buildIngressTraceMeta({
                requestId,
                message: tracedMessage,
                eventId: parsed.eventId,
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId ?? undefined,
              }),
              ackMessageId,
            });
          }
        } catch (error) {
          dependencies.log.warn('lark.ingress.ack.failed', {
            ...buildIngressTraceMeta({
              requestId,
              message: tracedMessage,
              eventId: parsed.eventId,
              textHash,
              larkTenantKey,
              companyId: scopedCompanyId ?? undefined,
            }),
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }
      }

      const tracedMessageWithStatus: NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>> = {
        ...tracedMessage,
        trace: {
          ...(tracedMessage.trace ?? {}),
          ...(ackMessageId ? { ackMessageId } : {}),
          ...(ackMessageId
            ? {
                ackReplyModeHint: 'reply',
              }
            : {}),
        },
      };

      if (parsed.kind === 'event_callback_card_action') {
        orangeDebug('lark.ingress.enqueue.card_action', {
          requestId,
          eventId: parsed.eventId,
          messageId: tracedMessageWithStatus.messageId,
          chatId: tracedMessageWithStatus.chatId,
        });
        void dependencies.enqueueTask(tracedMessageWithStatus)
          .then((task) => {
            dependencies.log.info('lark.ingress.queued', {
              ...buildIngressTraceMeta({
                requestId,
                message: tracedMessageWithStatus,
                eventId: parsed.eventId,
                taskId: task.taskId,
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId ?? undefined,
              }),
            });
            emitRuntimeTrace({
              event: 'lark.ingress.queued',
              level: 'info',
              requestId,
              taskId: task.taskId,
              messageId: tracedMessageWithStatus.messageId,
              metadata: {
                channel: tracedMessageWithStatus.channel,
                eventId: parsed.eventId,
                chatId: tracedMessageWithStatus.chatId,
                userId: tracedMessageWithStatus.userId,
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId ?? undefined,
              },
            });
          })
          .catch((error) => {
            dependencies.log.error('lark.ingress.queue_failed', {
              ...buildIngressTraceMeta({
                requestId,
                message: tracedMessageWithStatus,
                eventId: parsed.eventId,
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId ?? undefined,
              }),
              error: error instanceof Error ? error.message : 'unknown_error',
            });
          });

        return res.status(200).json(
          buildLarkCardActionResponse('Working on it.', 'info'),
        );
      }

      if (parsed.kind === 'event_callback_message' && (msgType === 'image' || msgType === 'file' || msgType === 'media')) {
        try {
          await dependencies.adapter.sendMessage({
            chatId: tracedMessage.chatId,
            replyToMessageId: tracedMessage.messageId,
            replyInThread: tracedMessage.chatType === 'group',
            correlationId: requestId,
            text: buildAttachmentAckMessage(attachedFiles),
          });
        } catch (error) {
          dependencies.log.warn('lark.ingress.attachment_ack.failed', {
            ...buildIngressTraceMeta({
              requestId,
              message: tracedMessage,
              eventId: parsed.eventId,
              textHash,
              larkTenantKey,
              companyId: scopedCompanyId ?? undefined,
            }),
            msgType,
            stagedFileCount: attachedFiles.length,
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }
        orangeDebug('lark.ingress.attachment_staged', {
          requestId,
          eventId: parsed.eventId,
          messageId: tracedMessage.messageId,
          chatId: tracedMessage.chatId,
          msgType,
          stagedFileCount: attachedFiles.length,
          fileAssetIds: attachedFiles.map((file) => file.fileAssetId),
        });
        dependencies.log.info('lark.ingress.attachment_staged', {
          ...buildIngressTraceMeta({
            requestId,
            message: tracedMessage,
            eventId: parsed.eventId,
            textHash,
            larkTenantKey,
            companyId: scopedCompanyId ?? undefined,
          }),
          msgType,
          stagedFileCount: attachedFiles.length,
        });
        return res.status(202).json({
          success: true,
          message: 'Lark attachment stored for the next text prompt',
          data: {
            channel: tracedMessage.channel,
            messageId: tracedMessage.messageId,
            chatId: tracedMessage.chatId,
            stagedFileCount: attachedFiles.length,
            msgType,
          },
        });
      }

      orangeDebug('lark.ingress.enqueue.message', {
        requestId,
        eventId: parsed.eventId,
        messageId: tracedMessageWithStatus.messageId,
        chatId: tracedMessageWithStatus.chatId,
        msgType: msgType ?? 'text',
        attachedFileCount: attachedFiles.length,
        fileAssetIds: attachedFiles.map((file) => file.fileAssetId),
      });
      try {
        const task = await dependencies.enqueueTask(tracedMessageWithStatus);
        orangeDebug('lark.ingress.enqueued', {
          requestId,
          eventId: parsed.eventId,
          messageId: tracedMessageWithStatus.messageId,
          chatId: tracedMessageWithStatus.chatId,
          taskId: task.taskId,
        });
        dependencies.log.info('lark.ingress.queued', {
          ...buildIngressTraceMeta({
            requestId,
            message: tracedMessageWithStatus,
            eventId: parsed.eventId,
            taskId: task.taskId,
            textHash,
            larkTenantKey,
            companyId: scopedCompanyId ?? undefined,
          }),
        });
        emitRuntimeTrace({
          event: 'lark.ingress.queued',
          level: 'info',
          requestId,
          taskId: task.taskId,
          messageId: tracedMessageWithStatus.messageId,
          metadata: {
            channel: tracedMessageWithStatus.channel,
            eventId: parsed.eventId,
            chatId: tracedMessageWithStatus.chatId,
            userId: tracedMessageWithStatus.userId,
            textHash,
            larkTenantKey,
            companyId: scopedCompanyId ?? undefined,
          },
        });
        return res.status(202).json({
          success: true,
          message: 'Lark event normalized and queued',
          data: {
            channel: tracedMessageWithStatus.channel,
            messageId: tracedMessageWithStatus.messageId,
            chatId: tracedMessageWithStatus.chatId,
            taskId: task.taskId,
          },
        });
      } catch (error) {
        if (statusMessageId) {
          try {
            await dependencies.adapter.updateMessage({
              messageId: statusMessageId,
              text: [
                'I could not start working on this request.',
                '',
                'Something went wrong before execution began. Please try again.',
              ].join('\n'),
              actions: [],
              correlationId: requestId,
            });
          } catch {
            // Best-effort only.
          }
        }
        throw error;
      }
    } catch (error) {
      return next(error);
    }
  };
};

export const createLarkWebhookRoutes = (overrides: Partial<LarkWebhookRouteDependencies> = {}): Router => {
  const larkWebhookRoutes = Router();
  larkWebhookRoutes.post('/events', larkWebhookRedisGuard, larkWebhookRateLimit, createLarkWebhookEventHandler(overrides));
  return larkWebhookRoutes;
};

const larkWebhookRoutes = createLarkWebhookRoutes();

export default larkWebhookRoutes;
