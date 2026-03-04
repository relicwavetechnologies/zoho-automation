import { Request, Router } from 'express';

import { orchestrationRuntime } from '../../queue/runtime';
import { verifyLarkWebhookRequest } from '../../security/lark/lark-webhook-verifier';
import { hitlActionService, idempotencyRepository } from '../../state';
import { logger } from '../../../utils/logger';
import { LarkChannelAdapter } from './lark.adapter';

const larkWebhookRoutes = Router();
const adapter = new LarkChannelAdapter();
const getRequestId = (req: Request): string =>
  ((req as Request & { requestId?: string }).requestId ?? 'missing_request_id');

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

larkWebhookRoutes.post('/events', async (req, res, next) => {
  try {
    const rawBody = (req as typeof req & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    const verification = verifyLarkWebhookRequest({
      headers: req.headers,
      rawBody,
      parsedBody: req.body,
    });
    if (!verification.ok) {
      logger.warn('lark.webhook.rejected', {
        requestId: getRequestId(req),
        reason: verification.reason,
      });
      return res.status(401).json({
        success: false,
        message: `Lark webhook rejected: ${verification.reason}`,
      });
    }

    const urlVerificationChallenge =
      typeof req.body?.challenge === 'string' ? req.body.challenge : undefined;
    const urlVerificationType = typeof req.body?.type === 'string' ? req.body.type : undefined;
    if (urlVerificationChallenge && urlVerificationType === 'url_verification') {
      logger.success('lark.webhook.url_verification', {
        requestId: getRequestId(req),
      });
      return res.status(200).json({
        challenge: urlVerificationChallenge,
      });
    }

    const normalized = adapter.normalizeIncomingEvent(req.body);

    if (!normalized) {
      logger.warn('lark.webhook.normalization_failed', {
        requestId: getRequestId(req),
      });
      return res.status(400).json({
        success: false,
        message: 'Unable to normalize Lark event payload',
      });
    }

    const hitlDecision = parseHitlDecision(normalized.text);
    if (hitlDecision) {
      const resolved = await hitlActionService.resolveByActionId(hitlDecision.actionId, hitlDecision.decision);
      logger.info('lark.webhook.hitl.decision', {
        requestId: getRequestId(req),
        actionId: hitlDecision.actionId,
        decision: hitlDecision.decision,
        resolved,
        chatId: normalized.chatId,
        messageId: normalized.messageId,
      });
      await adapter.sendMessage({
        chatId: normalized.chatId,
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

    const claimed = await idempotencyRepository.claimIngressMessageId(normalized.channel, normalized.messageId);
    if (!claimed) {
      logger.debug('lark.webhook.duplicate_ignored', {
        requestId: getRequestId(req),
        channel: normalized.channel,
        messageId: normalized.messageId,
        chatId: normalized.chatId,
      });
      return res.status(202).json({
        success: true,
        message: 'Duplicate ingress ignored (idempotency hit)',
        data: {
          channel: normalized.channel,
          messageId: normalized.messageId,
          chatId: normalized.chatId,
        },
      });
    }

    const task = await orchestrationRuntime.enqueue(normalized);
    logger.success('lark.webhook.task_queued', {
      requestId: getRequestId(req),
      taskId: task.taskId,
      channel: normalized.channel,
      messageId: normalized.messageId,
      chatId: normalized.chatId,
    });
    return res.status(202).json({
      success: true,
      message: 'Lark event normalized and queued',
      data: {
        channel: normalized.channel,
        messageId: normalized.messageId,
        chatId: normalized.chatId,
        taskId: task.taskId,
      },
    });
  } catch (error) {
    return next(error);
  }
});

export default larkWebhookRoutes;
