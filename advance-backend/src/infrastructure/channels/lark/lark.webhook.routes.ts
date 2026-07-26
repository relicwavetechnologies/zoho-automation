import { Router, type Request, type Response } from 'express';
import {
  isLarkHumanMessage,
  shouldStartLarkAgent,
  type LarkChannelAdapter,
} from './lark.adapter';
import type { OrchestrationEngine } from '../../../application/orchestration/engine/core';
import type { ChannelIdentityRepoPort } from '../../persistence/channel-identity.repository';
import type { ConversationRepoPort } from '../../persistence/conversation.repository';
import type { Logger } from '../../../shared/logger';
import type { TypedEnv } from '../../../config/env';
import type { ApprovalGateService } from '../../../application/approval/approval-gate.service';
import type {
  LarkApprovalCardHandler,
  LarkAuthenticatedCardActor,
} from './lark-approval-card.handler';
import type { ShareResolverService } from '../../../application/knowledge-share/share-resolver.service';
import type { KnowledgeShareService } from '../../../application/knowledge-share/knowledge-share.service';
import type { ChatMessageSerializer } from '../../../application/orchestration/chat-message-serializer';
import type { LaneLeaseHolder } from '../../../application/orchestration/lane-lease.holder';
import { fenceFinalReplies } from './lark-lane-fence';
import { BusyLaneNotices, BUSY_NOTICE_TEXT } from './lark-busy-notice';
import {
  absorbLaneBurst,
  completeAbsorbedReceipts,
  toBatchableMessage,
} from './lark-message-batch';
import type { Mem0Service } from '../../../application/memory/mem0.service';
import type { LarkOAuthService } from '../../lark/lark-oauth.service';
import type { IntegrationConnectionRepository } from '../../persistence/integration-connection.repository';
import type { CachePort } from '../../../shared/cache';
import { asCompanyId, asUserId, asCorrelationId, asDepartmentId } from '../../../shared/ids';
import { asCompanyRoleSlug } from '../../../domain/permissions/company-role';
import type { ConversationHandle } from '../../../application/channels/channel.adapter';
import type { IncomingMessage } from '../../../domain/channel/incoming-message';
import {
  verifyLarkWebhookRequest,
  maybeDecryptLarkBody,
} from './lark-security';
import { parseLarkAttachments, type LarkAttachment } from './lark-attachment.parser';
import type { InlineContextResult } from './lark-inline-context';
import type { LarkChatContextService } from '../../../application/chat-context/lark-chat-context.service';
import type { PrismaClient } from '../../../generated/prisma';
import type { GroupChatAttachmentContext } from '../../../domain/conversation/group-context';
import { fetchParentMessage, buildParentContextPrefix, type ParentMessageResult } from './lark-parent-message';
import type { LarkContactsClient } from './clients/lark-contacts.client';
import { buildLarkIngressLaneKey, buildLarkRoutingKeys } from './lark-routing';
import type {
  ChannelDeliveryRepoPort,
  ResumableDelivery,
} from '../../persistence/channel-delivery.repository';
import type { FinalReply } from '../../../domain/channel/outbound';
import {
  isUntaggedGroupMessage,
  mayPrepareAttachments,
  resolveCompanyUntaggedGroupPolicy,
  UNTAGGED_ATTACHMENTS_CONTROL,
  UNTAGGED_TEXT_RETENTION_CONTROL,
  type ResolvedUntaggedGroupPolicy,
} from './lark-untagged-policy';
import { appendLarkMentionContext, listLarkMentionOpenIds } from './lark-mention-context';
import {
  isSupportedLarkMedia,
  isAwaitingItsQuestion,
  unreadableImageNotice,
  unsupportedDocumentNotice,
  withoutTransientBytes,
  MAX_INLINE_IMAGE_BYTES,
} from './lark-media-support';
import { conversationKeyForMessage } from '../../../domain/conversation/conversation-key';
import {
  buildSignInCard,
  signInFallbackText,
  SIGN_IN_WORKSPACE_NOT_CONNECTED,
  SIGN_IN_DIRECTORY_UNAVAILABLE,
  SIGN_IN_NOT_CONFIGURED,
  SIGN_IN_MISSING_EMAIL,
} from './lark-signin';
import type {
  IngressReceipt,
  IngressReceiptRepoPort,
} from '../../persistence/ingress-receipt.repository';
import type { LarkIngressQueue } from '../../../application/lark-ingress/lark-ingress.queue';

export interface LarkWebhookDeps {
  adapter: LarkChannelAdapter;
  engine: OrchestrationEngine;
  channelIdentityRepo: ChannelIdentityRepoPort;
  conversationRepo: ConversationRepoPort;
  ingressReceiptRepo: IngressReceiptRepoPort;
  ingressQueue: Pick<LarkIngressQueue, 'enqueue'>;
  logger: Logger;
  env: TypedEnv;
  approvalGate?: ApprovalGateService;
  approvalCardHandler?: LarkApprovalCardHandler;
  knowledgeShareService?: KnowledgeShareService;
  shareResolverService?: ShareResolverService;
  mem0?: Mem0Service;
  larkOAuthService?: LarkOAuthService;
  connectionRepo?: IntegrationConnectionRepository;
  cache: CachePort;
  /** Per-lane serializer — preserves FIFO within one DM, thread, or group requester. */
  serializer: ChatMessageSerializer;
  /**
   * Cross-replica lane ownership. Absent means single-replica behaviour, where
   * the serializer alone is the ordering guarantee — correct for one process
   * and unsafe for two.
   */
  laneLeaseHolder?: LaneLeaseHolder;
  /** Tells a user their message is queued, once per busy stretch of a lane. */
  busyNotices?: BusyLaneNotices;
  /**
   * Merge a burst of compatible messages from one sender into a single turn.
   * Off by default: it changes how many replies a user gets, so it is opted
   * into rather than inherited.
   */
  batchingEnabled?: boolean;
  chatContextService?: LarkChatContextService;
  prisma?: PrismaClient;
  /** Optional: absent means a retried run re-runs the agent, as before Wave 5. */
  channelDeliveryRepo?: ChannelDeliveryRepoPort;
  larkContactsClient?: Pick<LarkContactsClient, 'getTenantKey' | 'getUser'>;
}

export const createLarkWebhookRoutes = (deps: LarkWebhookDeps): Router => {
  const router = Router();
  const log = deps.logger.child({ route: 'lark-webhook' });

  // Build the security config once from env — avoids repeated property access per request.
  const securityConfig = {
    ...(deps.env.LARK_WEBHOOK_SIGNING_SECRET ? { signingSecret:     deps.env.LARK_WEBHOOK_SIGNING_SECRET } : {}),
    ...(deps.env.LARK_VERIFICATION_TOKEN     ? { verificationToken: deps.env.LARK_VERIFICATION_TOKEN }     : {}),
    ...(deps.env.LARK_WEBHOOK_MAX_SKEW_SECONDS !== undefined ? { maxSkewSeconds: deps.env.LARK_WEBHOOK_MAX_SKEW_SECONDS } : {}),
  };
  const encryptKey = deps.env.LARK_ENCRYPT_KEY;

  // ── Lark URL verification challenge + event handler ───────────────────────
  // Lark sends all events to /events — the base path (/) handles only the
  // initial URL verification challenge that Lark fires when you first save
  // the webhook URL in the developer console.
  // Shared handler for both /events and /card endpoints.
  const handlePost = async (req: Request, res: Response): Promise<void> => {
    const receivedAtMs = Date.now();
    // ── Step 1: Signature / token verification ──────────────────────────────
    const verifyResult = verifyLarkWebhookRequest(
      {
        headers:    req.headers as Record<string, string | string[] | undefined>,
        rawBody:    (req as Request & { rawBody?: string }).rawBody ?? '',
        parsedBody: req.body as unknown,
      },
      securityConfig,
    );

    if (!verifyResult.ok) {
      log.warn('webhook.security.rejected', {
        reason: verifyResult.reason,
        path:   req.path,
        bodyKeys: req.body && typeof req.body === 'object'
          ? Object.keys(req.body as Record<string, unknown>) : [],
      });
      res.status(401).json({ error: 'unauthorized', reason: verifyResult.reason });
      return;
    }
    const verifiedAtMs = Date.now();

    // ── Step 2: AES-256-CBC decryption (when encryption is enabled on Lark app) ──
    let body: unknown = req.body;
    try {
      body = maybeDecryptLarkBody(body, encryptKey);
    } catch (e) {
      log.error('webhook.decrypt.failed', { error: String(e) });
      res.status(400).json({ error: 'decrypt_failed' });
      return;
    }

    const event = body as Record<string, unknown>;

    // ── Step 3: URL-verification challenge handshake ────────────────────────
    if (event['challenge']) {
      res.json({ challenge: event['challenge'] });
      return;
    }

    // Diagnostic — log shape so we can tell card-click vs message-event shapes apart
    const eventHeader   = event['header'] as Record<string, unknown> | undefined;
    const headerType    = eventHeader?.['event_type'] as string | undefined;
    const topLevelAction = (event['action'] as Record<string, unknown> | undefined);
    log.info('webhook.received', {
      path:       req.path,
      headerType: headerType ?? null,
      hasAction:  !!topLevelAction,
      topKeys:    Object.keys(event).slice(0, 12),
    });

    // ── Step 4a: Card action trigger (approval decisions) ────────────────────
    // Two shapes:
    //   • Card 2.0:  { header: { event_type: 'card.action.trigger' }, event: {...} }
    //   • Card 1.0:  { action: { value, tag }, open_id, user_id, ... }   (top-level)
    const isCard20Click = headerType === 'card.action.trigger';
    const isCard10Click = !headerType && !!topLevelAction && typeof topLevelAction === 'object';
    if (isCard20Click || isCard10Click) {
      const cardEvent = isCard20Click ? (event['event'] as unknown) : event;
      void (async () => {
        try {
          const actor = await resolveAuthenticatedCardActor(
            cardEvent,
            event,
            eventHeader,
            deps.channelIdentityRepo,
          );
          if (!actor) {
            log.warn('webhook.card_action.unauthorized');
            res.status(200).json({
              toast: { type: 'error', content: 'Could not verify this Lark action.' },
            });
            return;
          }

          // Check share actions first
          if (deps.shareResolverService?.isShareAction(cardEvent)) {
            const result = await deps.shareResolverService.handle(cardEvent, actor);
            res.status(200).json(result.responseBody);
            return;
          }

          // Handle interrupt button clicks on status cards
          const actionValue = (cardEvent as any)?.action?.value;
          const actionObj = typeof actionValue === 'string' ? (() => { try { return JSON.parse(actionValue); } catch { return null; } })() : actionValue;
          if (actionObj?.action === 'interrupt_run') {
            const messageId = (cardEvent as any)?.open_message_id
              ?? (cardEvent as any)?.context?.open_message_id
              ?? (cardEvent as any)?.message_id;
            if (messageId) {
              const corrId = deps.adapter.findCorrelationByStatusMessage(messageId);
              if (corrId) {
                const result = deps.adapter.interruptRun(corrId, actor);
                log.info('webhook.interrupt', { correlationId: corrId, result, actorUserId: actor.userId });
                const content = result === 'aborted'
                  ? 'Interrupt requested.'
                  : result === 'forbidden'
                    ? 'You are not authorized to interrupt this run.'
                    : 'This run is no longer active.';
                res.status(200).json({
                  toast: { type: result === 'aborted' ? 'success' : 'warning', content },
                });
                return;
              }
            }
            res.status(200).json({
              toast: { type: 'warning', content: 'This run is no longer active.' },
            });
            return;
          }

          if (deps.approvalCardHandler) {
            const result = await deps.approvalCardHandler.handle(cardEvent, actor);
            res.status(200).json(result.responseBody ?? { ok: true });
            return;
          }
          res.status(200).json({ ok: true });
        } catch (e) {
          log.error('webhook.card_action.error', { error: String(e) });
          // Lark needs a 200 to stop redelivering, but the actor must not be
          // told a control action succeeded when it did not apply.
          res.status(200).json({
            toast: {
              type: 'error',
              content: 'Divo could not complete that action. Please try again.',
            },
          });
        }
      })();
      return;
    }

    // ── Step 4b: Parse the incoming message event ────────────────────────────
    const parseResult = deps.adapter.parseIncoming(event);
    if (!parseResult.ok) {
      log.warn('webhook.parse.failed', { reason: parseResult.error.payload.reason });
      res.status(200).json({ ok: false }); // always 200 to Lark after challenge
      return;
    }

    const incoming = parseResult.value;
    const requestLog = createLarkRequestLog(log, incoming, eventHeader);

    if (!isLarkHumanMessage(incoming)) {
      requestLog.debug('webhook.sender.ignored', {
        senderType: incoming.senderType,
      });
      res.status(200).json({ ok: true });
      return;
    }

    const tenantKey = incoming.tenantKey;
    if (!tenantKey) {
      requestLog.warn('webhook.identity.tenant_missing');
      res.status(200).json({ ok: true });
      return;
    }

    // ── Step 5: Persist before ACK so Lark retries any failed admission ──────
    const receipt = await deps.ingressReceiptRepo.accept({
      channel: 'lark',
      tenantKey,
      messageId: String(incoming.messageId),
      payload: event,
      // Recorded here rather than derived later so a run can find the rest of
      // its burst with one indexed read instead of re-parsing every pending
      // payload in the channel.
      laneKey: buildLarkIngressLaneKey(incoming),
      ...(typeof eventHeader?.['event_id'] === 'string'
        ? { eventId: eventHeader['event_id'] }
        : {}),
    });
    if (!receipt.ok) {
      requestLog.error('webhook.receipt.failed', {
        error: receipt.error.message,
      });
      res.status(503).json({ error: 'ingress_unavailable' });
      return;
    }
    if (!receipt.value.isNew) {
      requestLog.info('webhook.receipt.duplicate', {
        receiptId: receipt.value.receiptId,
      });
    }

    // A stable BullMQ job repairs the crash window between receipt persistence
    // and queue admission. Duplicate Lark deliveries intentionally retry this
    // same enqueue; BullMQ de-duplicates them by receipt-backed job ID.
    let queueJobId: string;
    try {
      queueJobId = await deps.ingressQueue.enqueue(receipt.value.receiptId);
    } catch (error) {
      requestLog.error('webhook.queue.failed', {
        receiptId: receipt.value.receiptId,
        error: String(error),
      });
      res.status(503).json({ error: 'ingress_unavailable' });
      return;
    }
    const queued = await deps.ingressReceiptRepo.markQueued(
      receipt.value.receiptId,
      queueJobId,
    );
    if (!queued.ok) {
      requestLog.error('webhook.receipt.queue_link_failed', {
        receiptId: receipt.value.receiptId,
        queueJobId,
        error: queued.error.message,
      });
      res.status(503).json({ error: 'ingress_unavailable' });
      return;
    }

    // Respond only after both durable receipt and stable queue admission.
    res.status(200).json({ ok: true });
    const acceptedAtMs = Date.now();
    requestLog.info('webhook.accepted', {
      receiptId: receipt.value.receiptId,
      queueJobId,
      verificationMs: verifiedAtMs - receivedAtMs,
      ackMs: acceptedAtMs - receivedAtMs,
    });
  };

  // Both /events and /card route to the same handler. Some Lark configs send
  // card.action.trigger to a separate URL, others bundle it with /events.
  router.post('/events', handlePost);
  router.post('/card', handlePost);

  // Lark also fires the URL-verification challenge to the root path when you
  // first register the webhook URL — handle it so the console save succeeds.
  router.post('/', (req: Request, res: Response) => {
    let body: unknown = req.body;
    try { body = maybeDecryptLarkBody(body, encryptKey); } catch { /* ignore */ }
    const event = body as Record<string, unknown>;
    if (event['challenge']) {
      res.json({ challenge: event['challenge'] });
    } else {
      res.status(200).json({ ok: true });
    }
  });

  return router;
};

function createLarkRequestLog(
  log: Logger,
  incoming: IncomingMessage,
  eventHeader?: Record<string, unknown>,
): Logger {
  return log.child({
    tenantKey: incoming.tenantKey ?? null,
    appId: incoming.appId ?? null,
    larkEventId: eventHeader?.['event_id'] ?? null,
    correlationId: incoming.traceId,
    runId: incoming.traceId,
    jobId: null,
    attempt: 1,
    chatId: incoming.chatId,
    messageId: incoming.messageId,
    threadId: incoming.threadId ?? null,
    rootMessageId: incoming.rootMessageId ?? null,
    parentMessageId: incoming.parentMessageId ?? null,
    requesterOpenId: incoming.userExternalId,
    legacyLaneKey: `lark:${String(incoming.chatId)}`,
  });
}

/**
 * Answer the message someone sent before they were signed in.
 *
 * Runs under a derived trace ID. That is the whole trick: the sign-in prompt
 * was itself delivered under the original `messageId-createTime`, so replaying
 * with that key would find the Wave 5 reservation already `delivered` and
 * suppress the real answer — the user would connect and then get silence.
 * `:replay` is stable across retries of the replay, so it still deduplicates
 * itself.
 *
 * Best-effort by construction. It is triggered by an OAuth callback, not by a
 * durable receipt, so there is nothing to retry it and nothing to fail: the
 * user's original message is already answered or already lost by this point,
 * and the worst case is that they resend it as before.
 */
export async function replayLarkMessageAfterLogin(
  rawEvent: Record<string, unknown>,
  deps: LarkWebhookDeps,
): Promise<void> {
  const parsed = deps.adapter.parseIncoming(rawEvent);
  if (!parsed.ok) {
    deps.logger.warn('webhook.replay.unparseable', { reason: parsed.error.payload.reason });
    return;
  }
  if (!isLarkHumanMessage(parsed.value)) return;

  const incoming: IncomingMessage = {
    ...parsed.value,
    traceId: asCorrelationId(`${String(parsed.value.traceId)}:replay`),
  };
  const log = createLarkRequestLog(
    deps.logger.child({ route: 'lark-webhook', trigger: 'post_login_replay' }),
    incoming,
  );
  const laneKey = buildLarkIngressLaneKey(incoming);

  log.info('webhook.replay.started', { laneKey });
  await deps.serializer.runAndWait(laneKey, async signal => {
    const run = (adapter: LarkChannelAdapter, turnSignal: AbortSignal) =>
      processInBackground(
        incoming, rawEvent, { ...deps, adapter }, log,
        deps.approvalGate, deps.knowledgeShareService, turnSignal,
      );

    if (!deps.laneLeaseHolder) {
      await run(deps.adapter, signal);
      return;
    }

    const outcome = await deps.laneLeaseHolder.withLane(
      laneKey,
      (lease, leaseSignal) => run(
        fenceFinalReplies(deps.adapter, () => deps.laneLeaseHolder!.holdsLane(lease), log),
        leaseSignal,
      ),
      signal,
    );
    // Deferring is the end of it. Unlike an ingress job there is no retry to
    // schedule, and re-answering later out of order would be worse than not
    // answering at all.
    if (outcome.outcome === 'deferred') {
      log.warn('webhook.replay.lane_busy', { laneKey, heldBy: outcome.ownerId });
    }
  }).catch(e => log.error('webhook.replay.failed', { error: String(e) }));
}

/**
 * Execute one payload already admitted by the durable ingress worker.
 * This is deliberately separate from the HTTP handler: Lark receives an ACK
 * only after durable queue admission, while retries and restart recovery own
 * the actual agent run.
 */
export async function processAcceptedLarkReceipt(
  receipt: IngressReceipt,
  deps: LarkWebhookDeps,
): Promise<void> {
  const event = receipt.payload;
  const parsed = deps.adapter.parseIncoming(event);
  if (!parsed.ok) {
    throw new Error(`Persisted Lark ingress payload is invalid: ${parsed.error.payload.reason}`);
  }

  const incoming = parsed.value;
  if (!isLarkHumanMessage(incoming)) return;
  if (
    incoming.tenantKey !== receipt.tenantKey
    || String(incoming.messageId) !== receipt.messageId
  ) {
    throw new Error('Persisted Lark ingress identity does not match its receipt');
  }

  const eventHeader = event['header'] as Record<string, unknown> | undefined;
  const requestLog = createLarkRequestLog(
    deps.logger.child({ route: 'lark-webhook' }),
    incoming,
    eventHeader,
  ).child({
    receiptId: receipt.receiptId,
  });

  // A retry caused only by a failed delivery must not re-run the agent. If this
  // run already produced an answer that never reached the user, resend that
  // answer rather than recomputing it — every tool it called has already had
  // its effect, and calling them again to repeat a sentence is the failure mode
  // this wave exists to remove.
  if (deps.channelDeliveryRepo) {
    const runKey = String(incoming.traceId);
    const resumable = await deps.channelDeliveryRepo.findResumable('lark', runKey);
    if (!resumable.ok) {
      requestLog.warn('webhook.delivery.resume_lookup_failed', {
        error: resumable.error.message,
      });
    } else if (resumable.value) {
      requestLog.info('webhook.delivery.resuming', {
        deliveryId: resumable.value.deliveryId,
        attempts: resumable.value.attempts,
      });
      await resumeLarkDelivery(incoming, resumable.value, deps, requestLog);
      return;
    }
  }

  const executionLaneKey = buildLarkIngressLaneKey(incoming);

  // Decided before queueing, because "is this lane busy" is only true while the
  // previous turn is still running — asking after `runAndWait` has admitted
  // this task would always answer yes, and every message would look queued.
  if (deps.busyNotices) {
    const decision = deps.busyNotices.decide(executionLaneKey, {
      laneBusy: deps.serializer.isActive(executionLaneKey),
      isCommand: (incoming.text ?? '').trim().startsWith('/'),
    });
    if (decision.notify) {
      // Deliberately not `sendFinalReply`. That path reserves a delivery keyed
      // on this run, and the notice would consume the reservation belonging to
      // the answer that follows it — the user would get "I'll come back to
      // this" and then nothing, because their real reply would be recorded as
      // already delivered. A dropped notice is a cosmetic loss; a dropped
      // answer is not.
      const sent = await deps.adapter.sendToChatId(
        String(incoming.chatId),
        BUSY_NOTICE_TEXT,
        String(incoming.messageId),
      );
      if (!sent.ok) {
        requestLog.warn('webhook.busy_notice.failed', { error: sent.error.message });
      } else {
        requestLog.info('webhook.busy_notice.sent', { laneKey: executionLaneKey });
      }
    }
  }

  await deps.serializer.runAndWait(executionLaneKey, async signal => {
    const startedAtMs = Date.now();
    let absorbedReceiptIds: readonly string[] = [];

    const runTurn = async (
      turnSignal: AbortSignal,
      adapter: LarkChannelAdapter,
    ): Promise<void> => {
      // Inside the lane, so the burst being absorbed cannot grow a new owner
      // between the read and the claim.
      let turnMessage = incoming;
      if (deps.batchingEnabled && deps.ingressReceiptRepo) {
        const absorbed = await absorbLaneBurst({
          anchor: toBatchableMessage(incoming, event, receipt.acceptedAt.getTime()),
          anchorReceiptId: receipt.receiptId,
          repo: deps.ingressReceiptRepo,
          adapter: deps.adapter,
          log: requestLog,
        });
        absorbedReceiptIds = absorbed.absorbedReceiptIds;
        if (absorbed.batch.merged.length > 0) {
          turnMessage = { ...incoming, text: absorbed.batch.text };
        }
      }

      requestLog.info('webhook.background.started', {
        ...(absorbedReceiptIds.length > 0
          ? { batchedMessageCount: absorbedReceiptIds.length + 1 }
          : {}),
      });
      try {
        await processInBackground(
          turnMessage,
          event,
          { ...deps, adapter },
          requestLog,
          deps.approvalGate,
          deps.knowledgeShareService,
          turnSignal,
        );
        // Only now: a receipt completed before the answer exists is a message
        // silently dropped if this run then fails.
        if (absorbedReceiptIds.length > 0 && deps.ingressReceiptRepo) {
          await completeAbsorbedReceipts(absorbedReceiptIds, deps.ingressReceiptRepo, requestLog);
        }
        requestLog.info('webhook.background.completed', {
          runMs: Date.now() - startedAtMs,
        });
      } catch (error) {
        requestLog.error('webhook.background.failed', {
          error: String(error),
          runMs: Date.now() - startedAtMs,
          ...(absorbedReceiptIds.length > 0
            ? { absorbedReceiptsLeftOpen: absorbedReceiptIds.length }
            : {}),
        });
        throw error;
      }
    };

    // Without a lease holder this is the single-replica behaviour: the
    // serializer alone keeps a lane in order, which is correct for one process
    // and wrong for two.
    if (!deps.laneLeaseHolder) {
      await runTurn(signal, deps.adapter);
      return;
    }

    const outcome = await deps.laneLeaseHolder.withLane(
      executionLaneKey,
      (lease, leaseSignal) => runTurn(
        leaseSignal,
        fenceFinalReplies(
          deps.adapter,
          () => deps.laneLeaseHolder!.holdsLane(lease),
          requestLog,
        ),
      ),
      signal,
    );

    if (outcome.outcome === 'deferred') {
      // Another replica is running this lane. Throwing fails the job so it is
      // retried once that owner has finished or gone stale — returning would
      // complete the receipt and drop the message, which is the one outcome
      // durable ingress exists to prevent.
      requestLog.info('webhook.lane.deferred', {
        laneKey: executionLaneKey,
        heldBy: outcome.ownerId,
      });
      throw new Error(`Lark execution lane is held by ${outcome.ownerId}`);
    }
  }).finally(() => {
    // Only once this lane is genuinely idle. Clearing on every turn would
    // re-announce for each message in one backlog, which is the noise the
    // single-notice rule exists to avoid.
    if (deps.busyNotices && !deps.serializer.isActive(executionLaneKey)) {
      deps.busyNotices.clear(executionLaneKey);
    }
  });
}

/**
 * Resend an answer the agent already produced.
 *
 * Deliberately goes back through `sendFinalReply` rather than to the messaging
 * client: the reservation, the idempotency key, and the failure classification
 * all live there, and a resend needs them at least as much as a first attempt
 * does.
 */
async function resumeLarkDelivery(
  incoming: IncomingMessage,
  resumable: ResumableDelivery,
  deps: LarkWebhookDeps,
  log: Logger,
): Promise<void> {
  const reply = resumable.payload as unknown as FinalReply;
  const conversation: ConversationHandle = {
    channel: 'lark',
    chatId: incoming.chatId,
    replyToMessageId: incoming.messageId,
    replyInThread: incoming.chatType === 'group',
    correlationId: asCorrelationId(incoming.traceId),
  };

  const result = await deps.adapter.sendFinalReply(conversation, reply);
  if (!result.ok) {
    log.warn('webhook.delivery.resume_failed', {
      deliveryId: resumable.deliveryId,
      reason: result.error.payload.reason,
    });
    // Rethrown so the ingress receipt stays retryable: the answer exists and
    // the user still has not seen it.
    throw new Error(`Lark delivery resume failed: ${result.error.payload.reason}`);
  }
  log.info('webhook.delivery.resumed', { deliveryId: resumable.deliveryId });
}

const LARK_OAUTH_NONCE_TTL_SECONDS = 600;

function larkOAuthNonceKey(nonce: string): string {
  return `lark:oauth:nonce:${nonce}`;
}

function encodeLarkOAuthState(input: {
  companyId: string;
  userId: string;
  larkOpenId: string;
  tenantKey: string;
  nonce: string;
}): string {
  return Buffer.from(JSON.stringify(input)).toString('base64url');
}

async function createLarkLoginUrl(input: {
  companyId: string;
  userId: string;
  larkOpenId: string;
  tenantKey: string;
  /** The message that triggered the prompt, answered once sign-in completes. */
  pendingEvent?: Record<string, unknown>;
  deps: {
    larkOAuthService?: LarkOAuthService;
    cache: CachePort;
  };
}): Promise<string | null> {
  const oauth = input.deps.larkOAuthService;
  if (!oauth?.isConfigured()) return null;

  const nonce = oauth.generateNonce();
  const cached = await input.deps.cache.set(
    larkOAuthNonceKey(nonce),
    {
      companyId:  input.companyId,
      userId:     input.userId,
      larkOpenId: input.larkOpenId,
      tenantKey:  input.tenantKey,
      ...(input.pendingEvent ? { pendingEvent: input.pendingEvent } : {}),
    },
    LARK_OAUTH_NONCE_TTL_SECONDS,
  );
  if (!cached.ok) {
    throw new Error(cached.error.message);
  }

  return oauth.getAuthorizeUrl(encodeLarkOAuthState({
    companyId:  input.companyId,
    userId:     input.userId,
    larkOpenId: input.larkOpenId,
    tenantKey:  input.tenantKey,
    nonce,
  }));
}

async function processInBackground(
  incoming: IncomingMessage,
  rawEvent: Record<string, unknown>,
  deps: {
    adapter: LarkChannelAdapter;
    engine: OrchestrationEngine;
    channelIdentityRepo: ChannelIdentityRepoPort;
    conversationRepo: ConversationRepoPort;
    logger: Logger;
    env: TypedEnv;
    mem0?: Mem0Service;
    larkOAuthService?: LarkOAuthService;
    connectionRepo?: IntegrationConnectionRepository;
    cache: CachePort;
    chatContextService?: LarkChatContextService;
    prisma?: PrismaClient;
    larkContactsClient?: Pick<LarkContactsClient, 'getTenantKey' | 'getUser'>;
  },
  log: Logger,
  approvalGate?: ApprovalGateService,
  knowledgeShareService?: KnowledgeShareService,
  signal?: AbortSignal,
): Promise<void> {
  const correlationId = asCorrelationId(incoming.traceId);

  const tenantKey = incoming.tenantKey;
  if (!tenantKey) {
    log.warn('webhook.identity.tenant_missing', {
      chatId: incoming.chatId,
      messageId: incoming.messageId,
      larkOpenId: incoming.userExternalId,
    });
    return;
  }
  const identityResult = await deps.channelIdentityRepo.resolveByLarkTenantIdentity(
    incoming.userExternalId,
    tenantKey,
  );

  if (!identityResult.ok || !identityResult.value) {
    if (isUntaggedGroupMessage(incoming)) {
      log.debug('webhook.group_message.not_mentioned.identity_missing', {
        chatId: incoming.chatId,
        messageId: incoming.messageId,
        larkOpenId: incoming.userExternalId,
      });
      return;
    }

    // Say something on every path out of here. These branches used to log and
    // return, so a new customer — whose workspace is by definition not yet
    // connected — got silence that looked exactly like Divo being broken.
    const tell = (text: string) =>
      deps.adapter.sendToChatId(String(incoming.chatId), text, String(incoming.messageId))
        .catch(e => log.warn('webhook.first_touch.notice_failed', {
          error: String(e), correlationId,
        }));

    const bootstrapped = await bootstrapLarkFirstTouchIdentity(
      incoming.userExternalId, rawEvent, deps, log,
    );
    const pending = await deps.channelIdentityRepo.prepareLarkLogin(
      incoming.userExternalId,
      tenantKey,
    );

    if (pending.ok && pending.value?.status === 'ready') {
      const loginUrl = await createLarkLoginUrl({
        companyId:  pending.value.companyId,
        userId:     pending.value.userId,
        larkOpenId: pending.value.larkOpenId,
        tenantKey,
        // Kept with the one-time nonce so the question survives sign-in. The
        // whole point of the replay is that nobody has to retype what they
        // already sent.
        pendingEvent: rawEvent,
        deps,
      });

      if (loginUrl) {
        const name = pending.value.displayName ?? pending.value.email;
        const card = await deps.adapter.sendCardToChat(
          String(incoming.chatId),
          buildSignInCard({ name, url: loginUrl }),
        );
        if (!card.ok) {
          // A working link in a plain message beats a button nobody received.
          log.warn('webhook.login_prompt.card_failed', {
            error: card.error.message, correlationId,
          });
          await tell(signInFallbackText({ name, url: loginUrl }));
        }
        log.info('webhook.login_prompt.sent', {
          larkOpenId: incoming.userExternalId,
          companyId:  pending.value.companyId,
          userId:     pending.value.userId,
          createdUser: pending.value.createdUser,
          rendered: card.ok ? 'card' : 'text',
          correlationId,
        });
        return;
      }

      // Recognised, but this deployment cannot complete a sign-in.
      await tell(SIGN_IN_NOT_CONFIGURED);
      log.error('webhook.login_prompt.oauth_unconfigured', {
        larkOpenId: incoming.userExternalId,
        companyId: pending.value.companyId,
        correlationId,
      });
      return;
    }

    if (pending.ok && pending.value?.status === 'missing_email') {
      await tell(SIGN_IN_MISSING_EMAIL);
      log.warn('webhook.identity.missing_email', { larkOpenId: incoming.userExternalId, correlationId });
      return;
    }

    // `prepareLarkLogin` returns null both when the workspace has no active
    // binding and when it has one but this person is not in it. The bootstrap
    // above already distinguishes them: it only succeeds when the workspace is
    // bound and the directory confirmed the user.
    await tell(bootstrapped ? SIGN_IN_DIRECTORY_UNAVAILABLE : SIGN_IN_WORKSPACE_NOT_CONNECTED);
    log.warn('webhook.identity.not_found', {
      larkOpenId: incoming.userExternalId,
      bootstrapped,
      correlationId,
    });
    return;
  }

  const identity = identityResult.value;
  const routing = buildLarkRoutingKeys({
    companyId: String(identity.companyId),
    incoming,
  });
  log = log.child({
    companyId: identity.companyId,
    requesterUserId: identity.userId,
    departmentId: identity.activeDepartmentId ?? null,
    roomKey: routing.roomKey,
    // The key the serializer actually ordered this turn on. It is derived
    // without company identity so lane selection stays synchronous; recomputing
    // it here is safe because the builder is pure over the same event.
    laneKey: buildLarkIngressLaneKey(incoming),
    // The company-scoped lane identity from the product contract. Wave 3's
    // distributed leases adopt it; today it is recorded for comparison only.
    companyLaneKey: routing.executionLaneKey,
    deliveryTargetKey: routing.deliveryTargetKey,
    routingMode: 'active',
  });
  log.info('webhook.execution.correlated');
  if (deps.prisma) {
    try {
      await deps.prisma.runtimeConversation.upsert({
        where: {
          companyId_channel_channelConversationKey: {
            companyId: identity.companyId,
            channel: 'lark',
            channelConversationKey: String(incoming.chatId),
          },
        },
        create: {
          companyId: identity.companyId,
          channel: 'lark',
          channelConversationKey: String(incoming.chatId),
          rawChannelKey: String(incoming.chatId),
          createdByUserId: identity.userId,
          ...(identity.email ? { createdByEmail: identity.email } : {}),
          ...(identity.activeDepartmentId ? { departmentId: identity.activeDepartmentId } : {}),
          refsJson: { chatType: incoming.chatType, larkOpenId: incoming.userExternalId },
        },
        update: {
          updatedAt: new Date(),
          ...(identity.activeDepartmentId ? { departmentId: identity.activeDepartmentId } : {}),
        },
      });
    } catch (error) {
      log.warn('webhook.runtime_conversation.upsert_failed', { error: String(error), chatId: incoming.chatId });
    }
  }
  const mentionedLarkOpenIds = listLarkMentionOpenIds(incoming.mentions);
  const runContext = {
    companyId:      asCompanyId(identity.companyId),
    userId:         asUserId(identity.userId),
    companyRole:    asCompanyRoleSlug(identity.aiRole),
    channel:        'lark' as const,
    tenantId:       tenantKey,
    traceId:        String(incoming.traceId),
    requestId:      String(incoming.messageId),
    userExternalId: incoming.userExternalId,   // Lark open_id — tools use this as default assignee
    ...(mentionedLarkOpenIds.length > 0 ? { mentionedLarkOpenIds } : {}),
    chatId:         String(incoming.chatId),
    ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
    ...(identity.email ? { requesterEmail: identity.email } : {}),
  };

  const conversation: ConversationHandle = {
    channel:            'lark',
    chatId:             incoming.chatId,
    replyToMessageId:   incoming.messageId,
    replyInThread:      incoming.chatType === 'group',
    correlationId,
  };

  const attachments = parseLarkAttachments(rawEvent);
  const shouldRespond = shouldStartLarkAgent(incoming);

  // Divo is in the room but was not addressed. Preparing an attachment is not a
  // read — it pulls the image out of Lark and sends it to an OCR provider. That
  // only happens on an explicit opt-in, and the decision must be made *before*
  // the work, not after.
  const untagged = isUntaggedGroupMessage(incoming);
  // Only an untagged message consults the policy, so only an untagged message
  // pays for the lookup. Resolved here rather than inside the branch below
  // because the decision has to precede the work, not filter its output.
  const untaggedPolicy = untagged
    ? await loadUntaggedGroupPolicy(identity.companyId, deps, log)
    : null;
  const mayProcessAttachments = mayPrepareAttachments({
    attachmentCount: attachments.length,
    untagged,
    policy: untaggedPolicy ?? { retainText: false, processAttachments: false },
  });

  // Fetch parent message (quote-reply context) in parallel with attachment prep.
  const [preparedAttachments, parentRef] = await Promise.all([
    mayProcessAttachments
      ? prepareLarkAttachmentContexts({
          incoming,
          attachments,
          deps,
          log,
          shouldReact: shouldRespond,
        })
      : Promise.resolve([] as PreparedAttachmentContext[]),
    shouldRespond && incoming.replyToMessageId
      ? fetchParentMessage({
          parentMessageId: String(incoming.replyToMessageId),
          env: deps.env,
          logger: log,
          channelIdentityRepo: deps.channelIdentityRepo,
          companyId: identity.companyId,
          chatId: String(incoming.chatId),
          tenantKey,
        })
      : Promise.resolve(null),
  ]);

  if (untagged) {
    // Logged as the policy actually applied, not as the policy configured, so a
    // company can see from its own traffic what Divo kept and what it skipped.
    log.debug('webhook.group_message.not_mentioned', {
      chatId: incoming.chatId,
      messageId: incoming.messageId,
      attachmentCount: attachments.length,
      attachmentsProcessed: mayProcessAttachments,
      textRetained: untaggedPolicy?.retainText ?? false,
    });

    if (untaggedPolicy?.retainText) {
      await storeGroupIncomingSnapshot({
        incoming,
        identity,
        deps,
        attachmentContexts: preparedAttachments.map(item => item.context),
        log,
      });
    }

    return;
  }

  if (attachments.length > 0) {
    await storeGroupIncomingSnapshot({
      incoming,
      identity,
      deps,
      attachmentContexts: preparedAttachments.map(item => item.context),
      log,
    });

    // An attachment with no question attached to it yet. Record what it shows
    // so the next message can ask about it, and say nothing — see
    // `isAwaitingItsQuestion`.
    if (isAwaitingItsQuestion({
      chatType: incoming.chatType,
      text: incoming.text,
      supportedAttachmentCount: attachments.filter(isSupportedLarkMedia).length,
      unsupportedAttachmentCount: attachments.filter(a => !isSupportedLarkMedia(a)).length,
    })) {
      const seen = preparedAttachments
        .map(item => item.inlineContext?.context)
        .filter((part): part is string => !!part)
        .join('\n\n');
      if (seen) {
        await deps.conversationRepo.appendTurn(
          conversationKeyForMessage({
            chatId: String(incoming.chatId),
            chatType: incoming.chatType,
            messageId: String(incoming.messageId),
            ...(incoming.threadId ? { threadId: String(incoming.threadId) } : {}),
            ...(incoming.rootMessageId ? { rootMessageId: String(incoming.rootMessageId) } : {}),
          }) as never,
          { role: 'user', content: seen, timestamp: incoming.timestamp },
          { companyId: identity.companyId, channel: 'lark' },
        ).catch(e => log.warn('webhook.attachment.await_question.persist_failed', {
          error: String(e),
        }));
      }
      log.info('webhook.attachment.awaiting_question', {
        chatId: incoming.chatId,
        messageId: incoming.messageId,
        attachmentCount: attachments.length,
        recorded: Boolean(seen),
      });
      return;
    }

    // Inline image bytes for multimodal embedding, valid for this turn only.
    const imageUrls = preparedAttachments
      .filter(p => p.attachment.type === 'image')
      .map(p => p.context.base64DataUrl)
      .filter((url): url is string => !!url);

    // Merge parent message image URLs (quote-reply with images)
    const allImageUrls = [...imageUrls, ...(parentRef?.imageUrls ?? [])];

    // OCR/text context for non-image files (PDFs, docs, etc.)
    const userText     = incoming.text?.trim() ?? '';
    const parentPrefix = parentRef ? buildParentContextPrefix(parentRef) : '';
    const textWithParent = parentPrefix
      ? (userText ? `${parentPrefix}\n\n${userText}` : parentPrefix)
      : userText;
    // Image OCR is injected as text for direct messages, and only there.
    //
    // Passing pixels through `imageUrls` assumes the model can see them. The
    // Lark supervisor runs on DeepSeek, which is text-only, so on that path the
    // image parts are dropped and Divo answers "I don't see any image" about a
    // picture it successfully downloaded and read. The OCR text is the only
    // form it can actually receive.
    //
    // A group already carries this: the attachment context is written to the
    // room snapshot above, and the transcript formatter emits an OCR
    // supplement. Injecting it here as well would say the same thing twice.
    const includeImageContext = incoming.chatType !== 'group';
    const contextBlock = preparedAttachments
      .filter(p => includeImageContext || p.attachment.type !== 'image')
      .map(item => item.inlineContext?.context)
      .filter((part): part is string => !!part)
      .join('\n\n');

    // A declined document's notice goes into the message for groups as well as
    // DMs: a group also carries it in the stored snapshot, but that write is
    // best-effort, and if it fails Divo must still know it never opened the
    // file rather than answer from the filename.
    const askText = textWithParent
      || `Please review the attached ${attachments.length === 1 ? 'file' : 'files'}.`;
    const syntheticText = contextBlock ? `${contextBlock}\n\n${askText}` : askText;

    const enrichedIncoming = appendLarkMentionContext({
      ...incoming,
      text: syntheticText,
      ...(allImageUrls.length > 0 ? { imageUrls: allImageUrls } : {}),
    });

    const result = await deps.engine.run({
      incoming:       enrichedIncoming,
      runContext,
      conversation,
      channelAdapter: deps.adapter,
      ...(signal ? { abortSignal: signal } : {}),
      ...(approvalGate ? { approvalGate } : {}),
    });

    if (!result.ok) {
      log.error('webhook.engine.failed', { error: result.error.message, correlationId });
    }
    await storeGroupAssistantSnapshot({ incoming, identity, deps, result, log });
    return;
  }

  // ── Slash command interception ────────────────────────────────────────────
  const text = incoming.text?.trim() ?? '';
  if (text.startsWith('/')) {
    await handleSlashCommand({
      text,
      incoming,
      chatType: incoming.chatType,
      conversation,
      identity,
      deps,
      log,
      correlationId,
      ...(knowledgeShareService ? { knowledgeShareService } : {}),
    });
    return;
  }

  // Bare @Divo mention with no text — synthesize a contextual prompt so
  // the engine can respond to whatever was said above in the group chat.
  let effectiveIncoming: IncomingMessage = (!text && incoming.mentionsSelf && incoming.chatType === 'group')
    ? { ...incoming, text: 'Respond to the latest messages above in this group chat.' }
    : incoming;

  // Inject parent message context for quote-replies (text + images from quoted message)
  if (parentRef) {
    const prefix = buildParentContextPrefix(parentRef);
    const currentText = effectiveIncoming.text?.trim() ?? '';
    const mergedImages = [
      ...(effectiveIncoming.imageUrls ?? []),
      ...parentRef.imageUrls,
    ];
    effectiveIncoming = {
      ...effectiveIncoming,
      ...(prefix ? { text: `${prefix}\n\n${currentText}` } : {}),
      ...(mergedImages.length > 0 ? { imageUrls: mergedImages } : {}),
    };
  }

  effectiveIncoming = appendLarkMentionContext(effectiveIncoming);

  if (!effectiveIncoming.text?.trim()) return;

  // The room transcript records what was said in the room, so it takes the
  // original text rather than the prompt built from it. `effectiveIncoming`
  // carries hydrated quote content and synthesised instructions, and the
  // transcript is chat-scoped — writing them here would push a message quoted
  // inside one thread into the ambient context every other thread reads back.
  await storeGroupIncomingSnapshot({
    incoming,
    identity,
    deps,
    attachmentContexts: [],
    log,
  });

  // ── Normal message → orchestration engine ─────────────────────────────────
  const result = await deps.engine.run({
    incoming: effectiveIncoming,
    runContext,
    conversation,
    channelAdapter: deps.adapter,
    ...(signal ? { abortSignal: signal } : {}),
    ...(approvalGate ? { approvalGate } : {}),
  });

  if (!result.ok) {
    log.error('webhook.engine.failed', { error: result.error.message, correlationId });
  }

  await storeGroupAssistantSnapshot({ incoming, identity, deps, result, log });
}

export async function bootstrapLarkFirstTouchIdentity(
  larkOpenId: string,
  rawEvent: Record<string, unknown>,
  deps: {
    prisma?: PrismaClient;
    larkContactsClient?: Pick<LarkContactsClient, 'getTenantKey' | 'getUser'>;
  },
  log: Logger,
): Promise<boolean> {
  if (!deps.prisma || !deps.larkContactsClient) return false;

  const header = rawEvent['header'] as Record<string, unknown> | undefined;
  const event = rawEvent['event'] as Record<string, unknown> | undefined;
  const tenantKey = [header?.['tenant_key'], event?.['tenant_key'], rawEvent['tenant_key']]
    .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  if (!tenantKey) return false;

  const binding = await deps.prisma.larkTenantBinding.findFirst({
    where: { larkTenantKey: tenantKey, isActive: true },
    select: { companyId: true },
  });
  if (!binding) {
    log.warn('webhook.first_touch.unbound_tenant', { tenantKey, larkOpenId });
    return false;
  }

  try {
    const directoryTenantKey = await deps.larkContactsClient.getTenantKey();
    if (directoryTenantKey !== tenantKey) {
      log.warn('webhook.first_touch.directory_tenant_mismatch', {
        tenantKey,
        directoryTenantKey: directoryTenantKey ?? null,
        companyId: binding.companyId,
        larkOpenId,
      });
      return false;
    }

    const user = await deps.larkContactsClient.getUser(larkOpenId);
    if (!user || user.openId !== larkOpenId) {
      log.warn('webhook.first_touch.user_mismatch', {
        larkOpenId,
        returnedOpenId: user?.openId ?? null,
        companyId: binding.companyId,
      });
      return false;
    }

    await deps.prisma.channelIdentity.upsert({
      where: {
        channel_externalTenantId_externalUserId_companyId: {
          channel: 'lark',
          externalTenantId: tenantKey,
          externalUserId: larkOpenId,
          companyId: binding.companyId,
        },
      },
      create: {
        companyId: binding.companyId,
        channel: 'lark',
        externalUserId: larkOpenId,
        externalTenantId: tenantKey,
        larkOpenId,
        displayName: user.displayName,
        email: user.email ?? null,
        aiRole: 'MEMBER',
        aiRoleSource: 'first_touch',
        syncedAiRole: 'MEMBER',
        sourceRoles: [],
      },
      update: {
        displayName: user.displayName,
        ...(user.email ? { email: user.email } : {}),
      },
    });
    log.info('webhook.first_touch.identity_bootstrapped', {
      companyId: binding.companyId,
      larkOpenId,
      hasEmail: !!user.email,
    });
    return true;
  } catch (error) {
    log.warn('webhook.first_touch.failed', {
      companyId: binding.companyId,
      larkOpenId,
      error: String(error),
    });
    return false;
  }
}

async function resolveAuthenticatedCardActor(
  cardEvent: unknown,
  envelope: Record<string, unknown>,
  header: Record<string, unknown> | undefined,
  identityRepo: ChannelIdentityRepoPort,
): Promise<LarkAuthenticatedCardActor | null> {
  const card = toRecord(cardEvent);
  const operator = toRecord(card?.['operator']);
  const envelopeEvent = toRecord(envelope['event']);
  const openId = firstNonEmptyString(
    operator?.['open_id'],
    card?.['open_id'],
    envelopeEvent?.['open_id'],
    envelope['open_id'],
  );
  const tenantKey = firstNonEmptyString(
    header?.['tenant_key'],
    card?.['tenant_key'],
    envelopeEvent?.['tenant_key'],
    envelope['tenant_key'],
  );
  if (!openId || !tenantKey) return null;

  const resolved = await identityRepo.resolveByLarkTenantIdentity(openId, tenantKey);
  if (!resolved.ok || !resolved.value) return null;
  const displayName = firstNonEmptyString(
    operator?.['name'],
    card?.['user_name'],
    resolved.value.displayName,
  );

  return {
    tenantKey,
    openId,
    userId: resolved.value.userId,
    companyId: resolved.value.companyId,
    aiRole: resolved.value.aiRole,
    ...(displayName ? { displayName } : {}),
  };
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim().length > 0) as string | undefined;
}

async function handleSlashCommand(args: {
  text: string;
  incoming: IncomingMessage;
  chatType?: string;
  conversation: ConversationHandle;
  identity: { companyId: string; userId: string; aiRole: string; activeDepartmentId?: string | null };
  deps: {
    adapter: LarkChannelAdapter;
    conversationRepo: ConversationRepoPort;
    logger: Logger;
    mem0?: Mem0Service;
    larkOAuthService?: LarkOAuthService;
    connectionRepo?: IntegrationConnectionRepository;
    cache: CachePort;
    chatContextService?: LarkChatContextService;
    prisma?: PrismaClient;
  };
  log: Logger;
  correlationId: ReturnType<typeof asCorrelationId>;
  knowledgeShareService?: KnowledgeShareService;
}): Promise<void> {
  const { text, incoming, conversation, identity, deps, log, correlationId, knowledgeShareService } = args;
  const cmd = text.split(/\s+/)[0]!.toLowerCase();

  const reply = async (replyText: string) => {
    const r = await deps.adapter.sendFinalReply(conversation, {
      kind:   'final',
      text:   replyText,
      format: 'text',
    });
    if (!r.ok) {
      log.warn('webhook.command.reply.failed', { error: r.error.message, correlationId });
    }
  };

  if (cmd === '/clear') {
    // Clears the chat and every thread under it. Working context is thread-
    // scoped, so clearing the single chat-keyed conversation would report
    // success while leaving each thread's transcript untouched. Company-scoped
    // because a bare chat-key lookup is not bound to the asking tenant.
    const clearResult = await deps.conversationRepo.clearChatHistories(
      String(incoming.chatId),
      { companyId: identity.companyId, channel: 'lark' },
    );
    if (!clearResult.ok) {
      log.warn('webhook.command.clear.failed', {
        chatId:        incoming.chatId,
        correlationId,
        error:         clearResult.error.message,
      });
      await reply('Could not clear history — please try again.');
      return;
    }
    if (deps.chatContextService) {
      await deps.chatContextService.clear(identity.companyId, String(incoming.chatId));
    }
    log.info('webhook.command.clear.ok', {
      chatId: incoming.chatId,
      conversationsCleared: clearResult.value,
      correlationId,
    });
    await reply('Done. Conversation history cleared — I\'ll start fresh from here.');
    return;
  }

  if (cmd === '/remember') {
    const fact = text.slice(cmd.length).trim();
    if (!fact) {
      await reply('Usage: /remember <fact to remember>\nExample: /remember Acme Corp uses net-30 payment terms');
      return;
    }

    if (!deps.mem0) {
      await reply('Memory system is not enabled.');
      return;
    }

    const role = identity.aiRole;
    const scope = role === 'COMPANY_ADMIN' || role === 'SUPER_ADMIN'
      ? 'company'
      : role === 'MANAGER' && identity.activeDepartmentId
        ? 'department'
        : 'user';

    try {
      await deps.mem0.rememberExplicit({
        fact,
        scope,
        userId:    identity.userId,
        companyId: identity.companyId,
        ...(identity.activeDepartmentId ? { departmentId: identity.activeDepartmentId } : {}),
      });

      const scopeLabel = scope === 'company'
        ? 'the company'
        : scope === 'department'
          ? 'your team'
          : 'you';
      log.info('webhook.command.remember.ok', { scope, factLength: fact.length, correlationId });
      await reply(`Got it. I'll remember that for ${scopeLabel}.`);
    } catch (error) {
      log.warn('webhook.command.remember.failed', { error: String(error), correlationId });
      await reply('Could not store that memory. Please try again.');
    }
    return;
  }

  if (cmd === '/share') {
    if (!knowledgeShareService) {
      await reply('File sharing is not configured on this server.');
      return;
    }
    // Optionally accept a file asset ID: /share <fileAssetId>
    const parts = text.split(/\s+/);
    const fileAssetId = parts[1] ? parts[1] : undefined;

    const senderOpenId = incoming.userExternalId;  // Lark open_id
    const senderName   = (incoming as unknown as Record<string, unknown>)['senderName'] as string | undefined ?? 'User';

    try {
      const result = await knowledgeShareService.requestShare({
        companyId:       identity.companyId,
        requesterUserId: identity.userId,
        requesterOpenId: senderOpenId,
        requesterName:   senderName,
        ...(fileAssetId ? { fileAssetId } : {}),
      });
      await reply(result.message);
    } catch (e) {
      log.error('webhook.command.share.failed', { error: String(e), correlationId });
      await reply('Something went wrong. Please try again.');
    }
    return;
  }

  // ── /login — start Lark user OAuth ─────────────────────────────────────────
  if (cmd === '/login') {
    if (!deps.larkOAuthService?.isConfigured()) {
      await reply('User OAuth is not configured on this server. Ask your admin to set LARK_OAUTH_REDIRECT_URI.');
      return;
    }

    const url = await createLarkLoginUrl({
      companyId:  identity.companyId,
      userId:     identity.userId,
      larkOpenId: incoming.userExternalId,
      tenantKey:  String(incoming.tenantKey),
      deps,
    });

    if (!url) {
      await reply('User OAuth is not configured on this server. Ask your admin to set LARK_OAUTH_REDIRECT_URI.');
      return;
    }

    log.info('webhook.command.login.initiated', { userId: identity.userId, correlationId });
    await reply(
      `To connect your Lark account, open this link in your browser:\n\n${url}\n\n` +
      `After you authorise, I'll send you a confirmation here. The link expires in 10 minutes.`,
    );
    return;
  }

  // ── /logout — revoke stored user token ──────────────────────────────────────
  if (cmd === '/logout') {
    if (!deps.connectionRepo) {
      await reply('User OAuth is not configured on this server.');
      return;
    }
    const result = await deps.connectionRepo.revokeLarkConnectionsForUser(identity.companyId, identity.userId);
    if (result.ok && result.value > 0) {
      log.info('webhook.command.logout.ok', { userId: identity.userId, correlationId });
      await reply('Disconnected. Your personal Lark token has been removed — actions will now run as the Divo bot.');
    } else {
      await reply('No connected account found. Type /login to connect.');
    }
    return;
  }

  // ── /status — show connection status ────────────────────────────────────────
  if (cmd === '/status') {
    if (!deps.connectionRepo) {
      await reply('User OAuth is not configured on this server.');
      return;
    }
    const link = await deps.connectionRepo.findOwnedLarkConnection({
      userId: identity.userId,
      companyId: identity.companyId,
    });
    if (!link.ok || !link.value) {
      await reply('❌ Not connected. Type /login to connect your Lark account.');
      return;
    }
    const rec     = link.value;
    const expired = isTokenExpired(rec.accessTokenExpiresAt);
    const expiry  = rec.accessTokenExpiresAt
      ? rec.accessTokenExpiresAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
      : 'unknown';
    await reply(
      `**Lark account status**\n` +
      `• Name: ${rec.accountName ?? '—'}\n` +
      `• Email: ${rec.accountEmail ?? '—'}\n` +
      `• Token: ${expired ? '⚠️ Expired — type /login to refresh' : '✅ Valid'}\n` +
      `• Expires: ${expiry}`,
    );
    return;
  }

  // ── /schedules — list active scheduled workflows ────────────────────────────
  if (cmd === '/schedules') {
    if (!deps.prisma) { await reply('Scheduling is not available.'); return; }
    const workflows = await deps.prisma.scheduledWorkflow.findMany({
      where: { companyId: identity.companyId, createdByUserId: identity.userId, status: { in: ['scheduled_active', 'paused'] } },
      orderBy: { nextRunAt: 'asc' },
      take: 10,
      select: { id: true, name: true, scheduleType: true, status: true, nextRunAt: true, lastRunAt: true },
    });
    if (workflows.length === 0) { await reply('No active schedules. Tell Divo to schedule something, e.g. "check my emails every morning at 9am".'); return; }
    const lines = workflows.map((w, i) => {
      const status = w.status === 'paused' ? '⏸' : '✅';
      const next = w.nextRunAt ? w.nextRunAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
      return `${i + 1}. ${status} **${w.name}** (${w.scheduleType})\n   Next: ${next} | ID: \`${w.id.slice(0, 8)}\``;
    });
    await reply(`**Your Scheduled Workflows**\n\n${lines.join('\n\n')}`);
    return;
  }

  // ── /pause <id> — pause a schedule ─────────────────────────────────────────
  if (cmd === '/pause') {
    if (!deps.prisma) { await reply('Scheduling is not available.'); return; }
    const idPrefix = text.slice(cmd.length).trim();
    if (!idPrefix) { await reply('Usage: `/pause <schedule-id>`\nGet IDs from `/schedules`.'); return; }
    const match = await deps.prisma.scheduledWorkflow.findFirst({
      where: { companyId: identity.companyId, createdByUserId: identity.userId, id: { startsWith: idPrefix }, status: 'scheduled_active' },
    });
    if (!match) { await reply(`No active schedule found starting with \`${idPrefix}\`.`); return; }
    await deps.prisma.scheduledWorkflow.update({
      where: { id: match.id },
      data: { status: 'paused', scheduleEnabled: false, pausedAt: new Date() },
    });
    log.info('webhook.command.pause.ok', { workflowId: match.id, correlationId });
    await reply(`Paused **${match.name}**. Use \`/resume ${idPrefix}\` to restart.`);
    return;
  }

  // ── /resume <id> — resume a paused schedule ────────────────────────────────
  if (cmd === '/resume') {
    if (!deps.prisma) { await reply('Scheduling is not available.'); return; }
    const idPrefix = text.slice(cmd.length).trim();
    if (!idPrefix) { await reply('Usage: `/resume <schedule-id>`\nGet IDs from `/schedules`.'); return; }
    const match = await deps.prisma.scheduledWorkflow.findFirst({
      where: { companyId: identity.companyId, createdByUserId: identity.userId, id: { startsWith: idPrefix }, status: 'paused' },
    });
    if (!match) { await reply(`No paused schedule found starting with \`${idPrefix}\`.`); return; }

    let nextRunAt: Date | null = null;
    try {
      const { scheduleConfigSchema } = await import('../../../application/scheduling/schedule-config');
      const { getNextScheduledRunAt } = await import('../../../application/scheduling/schedule-calculator');
      const parsed = scheduleConfigSchema.safeParse(match.scheduleConfigJson);
      if (parsed.success) nextRunAt = getNextScheduledRunAt(parsed.data, new Date());
    } catch { /* use null */ }

    await deps.prisma.scheduledWorkflow.update({
      where: { id: match.id },
      data: { status: 'scheduled_active', scheduleEnabled: true, pausedAt: null, nextRunAt },
    });
    const nextStr = nextRunAt ? nextRunAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'pending';
    log.info('webhook.command.resume.ok', { workflowId: match.id, correlationId });
    await reply(`Resumed **${match.name}**. Next run: ${nextStr}.`);
    return;
  }

  // ── /cancel <id> — permanently archive a schedule ──────────────────────────
  if (cmd === '/cancel') {
    if (!deps.prisma) { await reply('Scheduling is not available.'); return; }
    const idPrefix = text.slice(cmd.length).trim();
    if (!idPrefix) { await reply('Usage: `/cancel <schedule-id>`\nGet IDs from `/schedules`.'); return; }
    const match = await deps.prisma.scheduledWorkflow.findFirst({
      where: { companyId: identity.companyId, createdByUserId: identity.userId, id: { startsWith: idPrefix }, status: { in: ['scheduled_active', 'paused'] } },
    });
    if (!match) { await reply(`No schedule found starting with \`${idPrefix}\`.`); return; }
    await deps.prisma.scheduledWorkflow.update({
      where: { id: match.id },
      data: { status: 'archived', scheduleEnabled: false, archivedAt: new Date(), nextRunAt: null },
    });
    log.info('webhook.command.cancel.ok', { workflowId: match.id, correlationId });
    await reply(`Cancelled **${match.name}**. This schedule has been permanently archived.`);
    return;
  }

  if (cmd === '/' || cmd === '/help' || cmd === '/commands') {
    await reply(
      '**Divo Commands**\n\n' +
      '**Conversation**\n' +
      '`/clear` — Wipe conversation memory for this chat. Divo starts fresh.\n' +
      '`/remember <fact>` — Save a fact Divo will recall in future chats.\n' +
      '  _Example:_ `/remember Acme Corp uses net-30 payment terms`\n\n' +
      '**Account**\n' +
      '`/login` — Connect your Lark account so actions run as you, not the bot.\n' +
      '`/logout` — Disconnect your Lark account.\n' +
      '`/status` — Check your Lark account connection and token status.\n\n' +
      '**Schedules**\n' +
      '`/schedules` — List your active and paused scheduled workflows.\n' +
      '`/pause <id>` — Pause a running schedule (use first 8 chars of ID).\n' +
      '`/resume <id>` — Resume a paused schedule.\n' +
      '`/cancel <id>` — Permanently archive a schedule.\n' +
      '  _Create schedules by telling Divo, e.g. "check my emails every morning at 9am"_\n\n' +
      '**Collaboration**\n' +
      '`/share` — Share your most recently indexed file with your team.\n\n' +
      '**Tips**\n' +
      '• In group chats, @mention Divo to talk to it.\n' +
      '• Upload a file and ask Divo to analyze it — PDFs, CSVs, and docs are all supported.',
    );
    return;
  }

  // Unknown command — let the engine handle it as a regular message
  log.info('webhook.command.unknown_routed_to_engine', { cmd, correlationId });
}

function isTokenExpired(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() < Date.now() + 5 * 60 * 1000; // 5 min buffer
}

type LarkResolvedIdentity = {
  companyId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
};

type PreparedAttachmentContext = {
  attachment: LarkAttachment;
  context: GroupChatAttachmentContext;
  inlineContext?: InlineContextResult;
};

function hasUsefulInlineAttachmentContext(item: PreparedAttachmentContext): boolean {
  const rawText = item.inlineContext?.rawText.trim() ?? '';
  if (rawText) return true;

  const context = item.inlineContext?.context.trim() ?? '';
  if (!context) return false;
  if (context.includes('could not download')) return false;
  if (context.includes('no text content extracted')) return false;
  return !/^\[(?:File|Image):\s*"?[^"\]]+"?\]$/i.test(context);
}

async function prepareLarkAttachmentContexts(input: {
  incoming: IncomingMessage;
  attachments: readonly LarkAttachment[];
  deps: {
    adapter: LarkChannelAdapter;
    env: TypedEnv;
    logger: Logger;
  };
  log: Logger;
  shouldReact: boolean;
}): Promise<PreparedAttachmentContext[]> {
  const { incoming, attachments, deps, log } = input;
  if (attachments.length === 0) return [];

  // Acknowledge only what Divo will actually look at. A 📥 on a PDF it is about
  // to refuse reads as "received, working on it" and then contradicts itself.
  if (input.shouldReact && attachments.some(isSupportedLarkMedia)) {
    try {
      await deps.adapter.reactToIncoming(incoming.messageId, '📥');
    } catch { /* non-fatal */ }
  }

  const { LarkFileClient } = await import('./clients/lark-file.client');
  const { extractAttachmentInlineContext } = await import('./lark-inline-context');
  const fileClient = new LarkFileClient(deps.env, log);
  const prepared: PreparedAttachmentContext[] = [];

  for (const att of attachments) {
    // Documents are refused before anything happens to them: no download, no
    // OCR, no upload, no indexing. The refusal is the whole handling, and it
    // travels as prompt context so Divo says it in its own voice rather than
    // as a canned card bolted onto an otherwise confident answer.
    if (!isSupportedLarkMedia(att)) {
      log.info('webhook.attachment.unsupported', {
        fileName: att.fileName,
        mimeType: att.mimeType,
        kind: att.type,
      });
      const notice = unsupportedDocumentNotice(att.fileName);
      prepared.push({
        attachment: att,
        context: {
          kind: att.type,
          fileName: att.fileName,
          mimeType: att.mimeType,
          larkFileKey: att.key,
          larkMessageId: att.messageId,
          ingestionStatus: 'unsupported',
          inlineContext: notice,
          isInlineComplete: false,
        },
        inlineContext: { context: notice, isComplete: false, rawText: '' },
      });
      continue;
    }

    let buffer: Buffer | undefined;
    let inlineContext: InlineContextResult | undefined;
    let error: string | undefined;

    try {
      const downloaded = await fileClient.downloadImage(att.messageId, att.key);
      if (downloaded && downloaded.length > 0) {
        buffer = downloaded;
      } else {
        log.warn('webhook.attachment.download.empty', { fileName: att.fileName });
      }
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      log.warn('webhook.attachment.download.failed', { fileName: att.fileName, error });
    }

    if (buffer) {
      inlineContext = await extractAttachmentInlineContext(att, buffer, deps.env, log);
    }

    // The pixels ride along with this turn and are then dropped. Nothing is
    // uploaded to a CDN and nothing is queued for indexing, so there is no
    // stored copy of the image and no derived chunks to retrieve later — the
    // OCR text below is all that outlives the request.
    let base64DataUrl: string | undefined;
    if (buffer && buffer.length <= MAX_INLINE_IMAGE_BYTES) {
      base64DataUrl = `data:${att.mimeType};base64,${buffer.toString('base64')}`;
    } else if (buffer) {
      // OCR still ran, so the text is available even though the model cannot
      // look at the image itself.
      log.warn('webhook.attachment.image_too_large_for_inline', {
        fileName: att.fileName, bytes: buffer.length, maxBytes: MAX_INLINE_IMAGE_BYTES,
      });
    }

    // An image that could not be downloaded or read still has to reach the
    // model as *something*. Handing it nothing produces "I don't see any
    // image", which contradicts the picture the user is looking at.
    const effectiveContext: InlineContextResult = inlineContext ?? {
      context: unreadableImageNotice(att.fileName, error),
      isComplete: false,
      rawText: '',
    };

    const context: GroupChatAttachmentContext = {
      kind: att.type,
      fileName: att.fileName,
      mimeType: att.mimeType,
      larkFileKey: att.key,
      larkMessageId: att.messageId,
      ingestionStatus: 'inline_only',
      ...(base64DataUrl ? { base64DataUrl } : {}),
      inlineContext: effectiveContext.context,
      isInlineComplete: effectiveContext.isComplete,
      ...(effectiveContext.rawText ? { rawTextPreview: effectiveContext.rawText.slice(0, 2000) } : {}),
      ...(error ? { error } : {}),
    };

    prepared.push({
      attachment: att,
      context,
      inlineContext: effectiveContext,
    });
  }

  return prepared;
}

/**
 * Resolve the untagged-group policy for one company, per turn.
 *
 * Deliberately uncached. This is a privacy control: an admin who turns
 * attachment processing off expects the next message to obey, not the first
 * message after a TTL expires. Two indexed rows on a path that already does
 * several round trips is the cheaper side of that trade.
 *
 * A lookup failure falls back to the deployment default rather than to the
 * permissive option, so a database blip cannot start indexing a company's
 * files.
 */
async function loadUntaggedGroupPolicy(
  companyId: string,
  deps: { env: TypedEnv; prisma?: PrismaClient },
  log: Logger,
): Promise<ResolvedUntaggedGroupPolicy> {
  if (!deps.prisma) {
    return resolveCompanyUntaggedGroupPolicy({ env: deps.env, controls: [] });
  }
  try {
    const controls = await deps.prisma.adminControlState.findMany({
      where: {
        companyId,
        controlKey: { in: [UNTAGGED_TEXT_RETENTION_CONTROL, UNTAGGED_ATTACHMENTS_CONTROL] },
      },
      select: { controlKey: true, value: true },
    });
    return resolveCompanyUntaggedGroupPolicy({ env: deps.env, controls });
  } catch (error) {
    log.warn('webhook.untagged_policy.lookup_failed', { companyId, error: String(error) });
    return resolveCompanyUntaggedGroupPolicy({ env: deps.env, controls: [] });
  }
}

async function storeGroupIncomingSnapshot(input: {
  incoming: IncomingMessage;
  identity: LarkResolvedIdentity;
  deps: { chatContextService?: LarkChatContextService };
  attachmentContexts: readonly GroupChatAttachmentContext[];
  log: Logger;
}): Promise<void> {
  const { incoming, identity, deps, log } = input;
  if (incoming.chatType !== 'group' || !deps.chatContextService) return;

  // The room transcript keeps what the image *said*, never the image itself.
  const attachmentContexts = input.attachmentContexts.map(withoutTransientBytes);

  const content = incoming.text?.trim()
    || attachmentContexts.map(att => `[${att.kind}: ${att.fileName}]`).join(' ');
  if (!content && attachmentContexts.length === 0) return;

  await deps.chatContextService.appendMessage({
    companyId: identity.companyId,
    chatId: String(incoming.chatId),
    chatType: 'group',
    messageId: String(incoming.messageId),
    senderOpenId: incoming.userExternalId,
    senderName: identity.displayName || identity.email || identity.userId,
    role: 'user',
    content,
    createdAt: incoming.timestamp,
    botMentioned: incoming.mentionsSelf,
    ...(attachmentContexts.length > 0
      ? {
          attachments: attachmentContexts,
          attachedFiles: attachmentContexts.map(att => att.fileName),
        }
      : {}),
  }).catch(e => log.warn('webhook.group_context.store_failed', { error: String(e) }));
}

async function storeGroupAssistantSnapshot(input: {
  incoming: IncomingMessage;
  identity: LarkResolvedIdentity;
  deps: { chatContextService?: LarkChatContextService };
  result: Awaited<ReturnType<OrchestrationEngine['run']>>;
  log: Logger;
}): Promise<void> {
  const { incoming, identity, deps, result, log } = input;
  if (incoming.chatType !== 'group' || !deps.chatContextService || !result.ok) return;

  await deps.chatContextService.appendMessage({
    companyId: identity.companyId,
    chatId: String(incoming.chatId),
    chatType: 'group',
    senderOpenId: 'divo-bot',
    senderName: 'Divo',
    role: 'assistant',
    content: result.value.finalReply.text,
    botMentioned: false,
  }).catch(e => log.warn('webhook.group_context.store_reply_failed', { error: String(e) }));
}
