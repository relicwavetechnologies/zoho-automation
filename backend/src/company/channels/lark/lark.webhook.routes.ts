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
  adapter: Pick<LarkChannelAdapter, 'normalizeIncomingEvent' | 'sendMessage'>;
  log: Pick<typeof logger, 'debug' | 'info' | 'warn' | 'error' | 'success'>;
  verifyRequest: typeof verifyLarkWebhookRequest;
  parsePayload: typeof parseLarkIngressPayload;
  claimIngressKey: (channel: string, keyType: IngressIdempotencyKeyType, key: string) => Promise<boolean>;
  enqueueTask: (
    normalized: NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>>,
  ) => Promise<{ taskId: string }>;
  resolveHitlAction: (actionId: string, decision: 'confirmed' | 'cancelled') => Promise<boolean>;
  resolveCompanyIdByTenantKey: (larkTenantKey: string) => Promise<string | null>;
  resolveWorkspaceVerificationConfig: (
    companyId: string,
  ) => Promise<{ signingSecret?: string; verificationToken?: string; maxSkewSeconds?: number } | null>;
  upsertChannelIdentity: (
    input: UpsertChannelIdentityInput,
  ) => Promise<{ id: string; isNew: boolean; aiRole: string; email?: string | null }>;
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

const toIdempotencyStorageKey = (channel: string, keyType: IngressIdempotencyKeyType, key: string): string =>
  `emiac:idempotent:${channel}:${keyType}:${key}`;

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

const defaultResolveHitlAction: LarkWebhookRouteDependencies['resolveHitlAction'] = async (
  actionId,
  decision,
) => {
  const { hitlActionService } = require('../../state') as typeof import('../../state');
  return hitlActionService.resolveByActionId(actionId, decision);
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

const createDefaultDependencies = (): LarkWebhookRouteDependencies => ({
  adapter: new LarkChannelAdapter(),
  log: logger,
  verifyRequest: verifyLarkWebhookRequest,
  parsePayload: parseLarkIngressPayload,
  claimIngressKey: defaultClaimIngressKey,
  enqueueTask: defaultEnqueueTask,
  resolveHitlAction: defaultResolveHitlAction,
  resolveCompanyIdByTenantKey: defaultResolveCompanyIdByTenantKey,
  resolveWorkspaceVerificationConfig: defaultResolveWorkspaceVerificationConfig,
  upsertChannelIdentity: defaultUpsertChannelIdentity,
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
        dependencies.log.warn('lark.webhook.contract.invalid', {
          requestId,
          reason: 'unsupported_message_shape',
        });
        return res.status(400).json({
          success: false,
          message: 'Invalid Lark message callback payload',
          data: {
            reason: 'unsupported_message_shape',
          },
        });
      }
      const textHash = buildLarkTextHash(normalized.text);

      let channelIdentityId: string | undefined;
      let requesterEmail: string | undefined;
      let userRole = 'MEMBER';
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
      }

      const tracedMessage: NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>> = {
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
          userRole,
          requesterEmail,
        },
      };

      const hitlDecision = parseHitlDecision(tracedMessage.text);
      if (hitlDecision) {
        const resolved = await dependencies.resolveHitlAction(hitlDecision.actionId, hitlDecision.decision);
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
        });
        await dependencies.adapter.sendMessage({
          chatId: tracedMessage.chatId,
          text: resolved
            ? `HITL action ${hitlDecision.actionId} marked ${hitlDecision.decision}.`
            : `HITL action ${hitlDecision.actionId} is not pending or was not found.`,
        });
        return res.status(202).json({
          success: true,
          message: 'HITL callback processed',
          data: {
            actionId: hitlDecision.actionId,
            decision: hitlDecision.decision,
            resolved,
          },
        });
      }

      const primaryIdempotency = buildPrimaryIngressIdempotencyKey({
        channel: tracedMessage.channel,
        eventId: parsed.eventId,
        messageId: tracedMessage.messageId,
      });
      let claimedPrimary = false;
      try {
        claimedPrimary = await dependencies.claimIngressKey(
          tracedMessage.channel,
          primaryIdempotency.keyType,
          primaryIdempotency.key,
        );
      } catch (error) {
        dependencies.log.error('lark.ingress.idempotency_unavailable', {
          ...buildIngressTraceMeta({
            requestId,
            message: tracedMessage,
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
        dependencies.log.info('lark.ingress.duplicate_ignored', {
          ...buildIngressTraceMeta({
            requestId,
            message: tracedMessage,
            eventId: parsed.eventId,
            idempotencyKey: primaryIdempotency.idempotencyKey,
            keyType: primaryIdempotency.keyType,
            textHash,
            larkTenantKey,
            companyId: scopedCompanyId ?? undefined,
          }),
        });
        return res.status(202).json({
          success: true,
          message: 'Duplicate ingress ignored (idempotency hit)',
          data: {
            channel: tracedMessage.channel,
            messageId: tracedMessage.messageId,
            chatId: tracedMessage.chatId,
            keyType: primaryIdempotency.keyType,
            idempotencyKey: primaryIdempotency.idempotencyKey,
          },
        });
      }

      if (primaryIdempotency.keyType === 'event' && tracedMessage.messageId) {
        try {
          await dependencies.claimIngressKey(tracedMessage.channel, 'message', tracedMessage.messageId);
        } catch (error) {
          dependencies.log.warn('lark.webhook.idempotency.alias_claim_failed', {
            ...buildIngressTraceMeta({
              requestId,
              message: tracedMessage,
              eventId: parsed.eventId,
              textHash,
              larkTenantKey,
              companyId: scopedCompanyId ?? undefined,
            }),
            error,
          });
        }
      }

      const task = await dependencies.enqueueTask(tracedMessage);
      dependencies.log.info('lark.ingress.queued', {
        ...buildIngressTraceMeta({
          requestId,
          message: tracedMessage,
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
        messageId: tracedMessage.messageId,
        metadata: {
          channel: tracedMessage.channel,
          eventId: parsed.eventId,
          chatId: tracedMessage.chatId,
          userId: tracedMessage.userId,
          textHash,
          larkTenantKey,
          companyId: scopedCompanyId ?? undefined,
        },
      });
      return res.status(202).json({
        success: true,
        message: 'Lark event normalized and queued',
        data: {
          channel: tracedMessage.channel,
          messageId: tracedMessage.messageId,
          chatId: tracedMessage.chatId,
          taskId: task.taskId,
        },
      });
    } catch (error) {
      return next(error);
    }
  };
};

export const createLarkWebhookRoutes = (overrides: Partial<LarkWebhookRouteDependencies> = {}): Router => {
  const larkWebhookRoutes = Router();
  larkWebhookRoutes.post('/events', createLarkWebhookEventHandler(overrides));
  return larkWebhookRoutes;
};

const larkWebhookRoutes = createLarkWebhookRoutes();

export default larkWebhookRoutes;
