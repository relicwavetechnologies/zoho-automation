import { NextFunction, Request, Response, Router } from 'express';

import {
  type LarkWebhookVerificationResult,
  verifyLarkWebhookRequest,
} from '../../security/lark/lark-webhook-verifier';
import type { NormalizedIncomingMessageDTO } from '../../contracts';
import { logger } from '../../../utils/logger';
import { LarkChannelAdapter } from './lark.adapter';
import type { LarkIngressParseResult } from './lark-ingress.contract';
import { parseLarkIngressPayload } from './lark-ingress.contract';
import { buildLarkTextHash, buildLarkTraceMeta } from './lark-observability';

type IngressIdempotencyKeyType = 'event' | 'message';
type WebhookVerificationFailureReason = Exclude<LarkWebhookVerificationResult['reason'], undefined>;
type AllowedRejectionReason = Exclude<WebhookVerificationFailureReason, 'replay_window_exceeded'>;

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

const createDefaultDependencies = (): LarkWebhookRouteDependencies => ({
  adapter: new LarkChannelAdapter(),
  log: logger,
  verifyRequest: verifyLarkWebhookRequest,
  parsePayload: parseLarkIngressPayload,
  claimIngressKey: defaultClaimIngressKey,
  enqueueTask: defaultEnqueueTask,
  resolveHitlAction: defaultResolveHitlAction,
});

const isMetadataParseResult = (
  parsed: LarkIngressParseResult,
): parsed is Extract<LarkIngressParseResult, { eventType?: string; eventId?: string }> =>
  parsed.kind === 'event_callback_message' || parsed.kind === 'event_callback_ignored';

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
      const verification = dependencies.verifyRequest({
        headers: req.headers,
        rawBody,
        parsedBody: req.body,
      });
      if (!verification.ok) {
        const statusCode = mapVerificationReasonToHttpStatus(verification.reason);
        dependencies.log.warn('lark.ingress.rejected', {
          requestId,
          reason: verification.reason,
          statusCode,
        });
        return res.status(statusCode).json({
          success: false,
          message: `Lark webhook rejected: ${verification.reason}`,
        });
      }
      dependencies.log.info('lark.ingress.verified', { requestId });

      const parsed = dependencies.parsePayload(req.body);
      dependencies.log.debug('lark.webhook.contract.parsed', {
        requestId,
        kind: parsed.kind,
        reason: parsed.kind === 'invalid' || parsed.kind === 'event_callback_ignored' ? parsed.reason : undefined,
        eventType: isMetadataParseResult(parsed) ? parsed.eventType : undefined,
        eventId: isMetadataParseResult(parsed) ? parsed.eventId : undefined,
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
        });
        return res.status(202).json({
          success: true,
          message: 'Lark event ignored by ingress contract',
          data: {
            reason: parsed.reason,
            eventType: parsed.eventType,
            eventId: parsed.eventId,
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
      const tracedMessage: NonNullable<ReturnType<LarkChannelAdapter['normalizeIncomingEvent']>> = {
        ...normalized,
        trace: {
          ...(normalized.trace ?? {}),
          requestId,
          eventId: parsed.eventId,
          textHash,
          receivedAt: new Date().toISOString(),
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
        }),
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
