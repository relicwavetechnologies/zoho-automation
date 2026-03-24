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
import { inferLarkMessageType, parseLarkAttachmentKeys } from './lark-message-content';
import { ingestLarkAttachments } from './lark-file-ingestion';
import { larkRecentFilesStore } from './lark-recent-files.store';
import { orangeDebug } from '../../../utils/orange-debug';
import { desktopThreadsService } from '../../../modules/desktop-threads/desktop-threads.service';
import { desktopWorkflowsService } from '../../../modules/desktop-workflows/desktop-workflows.service';
import { conversationMemoryStore } from '../../state/conversation';
import { createRateLimitMiddleware, createRedisAvailabilityMiddleware } from '../../../middlewares/rate-limit.middleware';
import type { MemberSessionDTO } from '../../../modules/member-auth/member-auth.service';
import { toolPermissionService } from '../../tools/tool-permission.service';
import { LarkStatusCoordinator } from '../../orchestration/engine/lark-status.coordinator';
import { runtimeTaskStore } from '../../orchestration/runtime-task.store';

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

type LarkWebhookRouteDependencies = {
  adapter: Pick<LarkChannelAdapter, 'normalizeIncomingEvent' | 'sendMessage' | 'updateMessage' | 'downloadFile'>;
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
};

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

const isLarkClearContextCommand = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
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
  const trimmed = text.trim();
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

const isLarkCommandMenuCommand = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
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
].join('\n');

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
  const normalized = text.trim().toLowerCase();
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
      orangeDebug('lark.ingress.normalized', {
        requestId,
        eventId: parsed.eventId,
        msgType: msgType ?? 'text',
        messageId: normalized.messageId,
        chatId: normalized.chatId,
        userId: normalized.userId,
        textPreview: normalized.text.slice(0, 120),
        attachmentKeyCount: attachmentKeys.length,
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
      });
      const textHash = buildLarkTextHash(normalized.text);

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

      const tracedMessageBase: NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>> = {
        ...normalized,
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
        },
      };

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

      if (parsed.kind === 'event_callback_message' && isLarkCommandMenuCommand(tracedMessageBase.text)) {
        await dependencies.adapter.sendMessage({
          chatId: tracedMessageBase.chatId,
          text: buildLarkCommandMenuText(),
          correlationId: requestId,
        });
        return res.status(202).json({
          success: true,
          message: 'Command menu handled',
        });
      }

      if (parsed.kind === 'event_callback_message' && isLarkInterruptCommand(tracedMessageBase.text)) {
        const { orchestrationRuntime } = require('../../queue/runtime') as typeof import('../../queue/runtime');
        const conversationState = runtimeTaskStore.getConversationExecutionState('lark', tracedMessageBase.chatId);
        if (!conversationState.runningTask) {
          await dependencies.adapter.sendMessage({
            chatId: tracedMessageBase.chatId,
            text: 'No active run is currently executing in this Lark chat.',
            correlationId: requestId,
          });
          return res.status(202).json({
            success: true,
            message: 'Interrupt command handled with no active run',
          });
        }

        await orchestrationRuntime.control(conversationState.runningTask.taskId, 'cancelled');
        await dependencies.adapter.sendMessage({
          chatId: tracedMessageBase.chatId,
          text: [
            'Interrupt requested.',
            '',
            `Stopped active task ${conversationState.runningTask.taskId}.`,
            'Any queued message in this chat will continue after cancellation settles.',
          ].join('\n'),
          correlationId: requestId,
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

      if (parsed.kind === 'event_callback_message' && workflowCommand) {
        if (!scopedCompanyId || !linkedUserId) {
          await dependencies.adapter.sendMessage({
            chatId: tracedMessageBase.chatId,
            text: 'Workflow commands need a linked desktop account for this Lark user. Link your account first, then retry.',
            correlationId: requestId,
          });
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
          await dependencies.adapter.sendMessage({
            chatId: tracedMessageBase.chatId,
            text: `Workflow command failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            correlationId: requestId,
          });
          return res.status(202).json({
            success: true,
            message: 'Workflow command failed gracefully',
          });
        }
      }

      if (parsed.kind === 'event_callback_message' && isLarkClearContextCommand(tracedMessageBase.text)) {
        try {
          if (scopedCompanyId && linkedUserId) {
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

          await dependencies.adapter.sendMessage({
            chatId: tracedMessageBase.chatId,
            text: [
              'Started a fresh chat context.',
              '',
              'Previous Lark chat context will not be used for the next turns.',
              'Stored memories and vectors were kept.',
            ].join('\n'),
            correlationId: requestId,
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

      // ── File/Image Ingestion (runs AFTER linkedUserId resolution and idempotency) ─────────
      // This prevents duplicate webhook deliveries from creating duplicate FileAsset rows.
      let attachedFiles = normalized.attachedFiles ?? [];

      if (attachmentKeys.length > 0 && scopedCompanyId && normalized.userId) {
        const effectiveUploaderId = linkedUserId ?? channelIdentityId ?? normalized.userId;
        const allowedRoles = Array.from(new Set([
          userRole || 'MEMBER',
          'COMPANY_ADMIN',
          'SUPER_ADMIN',
        ]));
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

      const tracedMessage: NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>> = {
        ...tracedMessageBase,
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
      const hitlDecision = cardHitlDecision ?? textHitlDecision;
      if (hitlDecision) {
        const storedAction = await dependencies.getStoredHitlAction(hitlDecision.actionId);
        const resolved = await dependencies.resolveHitlAction(hitlDecision.actionId, hitlDecision.decision);
        let executionSummary: string | undefined;
        let executionOk: boolean | undefined;
        let executionPayload: Record<string, unknown> | undefined;
        let executionKind: string | undefined;
        let resumedTaskId: string | undefined;
        if (resolved && hitlDecision.decision === 'confirmed' && storedAction) {
          try {
            const executionResult = await dependencies.executeStoredHitlAction(storedAction);
            executionKind = executionResult.kind;
            executionSummary = executionResult.summary;
            executionOk = executionResult.ok;
            executionPayload = executionResult.payload;
            if (typeof storedAction.taskId === 'string' && storedAction.taskId.trim()) {
              const continuationText = buildApprovalContinuationText({
                kind: executionResult.kind,
                ok: executionResult.ok,
                summary: executionSummary,
                actionSummary: typeof storedAction.summary === 'string' ? storedAction.summary : undefined,
                payload: executionResult.payload,
              });
              await dependencies.requeueTask(storedAction.taskId, {
                ...tracedMessage,
                messageId: randomUUID(),
                timestamp: new Date().toISOString(),
                text: continuationText,
                rawEvent: {
                  kind: 'hitl_approval_continuation',
                  sourceActionId: hitlDecision.actionId,
                  sourceMessageId: tracedMessage.messageId,
                  executionSummary,
                  executionPayload: executionResult.payload,
                },
                trace: {
                  ...tracedMessage.trace,
                  requestId,
                  receivedAt: new Date().toISOString(),
                  textHash: buildLarkTextHash(continuationText),
                  statusMessageId: parsed.kind === 'event_callback_card_action'
                    ? tracedMessage.messageId
                    : tracedMessage.trace?.statusMessageId,
                },
              });
              resumedTaskId = storedAction.taskId;
            }
          } catch (error) {
            executionSummary = error instanceof Error ? error.message : 'Stored approval action execution failed';
            executionOk = false;
            if (typeof storedAction.taskId === 'string' && storedAction.taskId.trim()) {
              const continuationText = buildApprovalContinuationText({
                kind: executionKind,
                ok: false,
                summary: executionSummary,
                actionSummary: typeof storedAction.summary === 'string' ? storedAction.summary : undefined,
                payload: executionPayload,
              });
              await dependencies.requeueTask(storedAction.taskId, {
                ...tracedMessage,
                messageId: randomUUID(),
                timestamp: new Date().toISOString(),
                text: continuationText,
                rawEvent: {
                  kind: 'hitl_approval_continuation',
                  sourceActionId: hitlDecision.actionId,
                  sourceMessageId: tracedMessage.messageId,
                  executionSummary,
                  executionOk: false,
                  executionPayload,
                },
                trace: {
                  ...tracedMessage.trace,
                  requestId,
                  receivedAt: new Date().toISOString(),
                  textHash: buildLarkTextHash(continuationText),
                  statusMessageId: parsed.kind === 'event_callback_card_action'
                    ? tracedMessage.messageId
                    : tracedMessage.trace?.statusMessageId,
                },
              });
              resumedTaskId = storedAction.taskId;
            }
          }
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
            ? `Rejected request.\n\n${storedAction && typeof storedAction.summary === 'string' ? storedAction.summary : hitlDecision.actionId}`
            : resumedTaskId
              ? `Approved and continuing.\n\n${executionSummary ?? storedAction?.summary ?? hitlDecision.actionId}`
              : executionOk
                ? `Approved and executed.\n\n${executionSummary ?? storedAction?.summary ?? hitlDecision.actionId}`
                : `Approval was recorded, but execution failed.\n\n${executionSummary ?? storedAction?.summary ?? hitlDecision.actionId}`;
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
        return res.status(parsed.kind === 'event_callback_card_action' ? 200 : 202).json({
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

      const shouldSendImmediateAck =
        parsed.kind === 'event_callback_message'
        && !textHitlDecision
        && msgType !== 'image'
        && msgType !== 'file'
        && msgType !== 'media';

      let statusMessageId: string | undefined;
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
          });
          if (ack.status !== 'failed') {
            statusMessageId = ack.messageId ?? undefined;
            dependencies.log.info('lark.ingress.ack.sent', {
              ...buildIngressTraceMeta({
                requestId,
                message: tracedMessage,
                eventId: parsed.eventId,
                textHash,
                larkTenantKey,
                companyId: scopedCompanyId ?? undefined,
              }),
              statusMessageId,
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
          ...(statusMessageId ? { statusMessageId } : {}),
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

        return res.status(200).json({
          success: true,
          message: 'Lark card action accepted',
          data: {
            channel: tracedMessageWithStatus.channel,
            messageId: tracedMessageWithStatus.messageId,
            chatId: tracedMessageWithStatus.chatId,
            eventId: parsed.eventId,
          },
        });
      }

      if (parsed.kind === 'event_callback_message' && (msgType === 'image' || msgType === 'file' || msgType === 'media')) {
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
