import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import {
  isLarkHumanMessage,
  shouldStartLarkAgent,
  type LarkChannelAdapter,
} from './lark.adapter';
import {
  LarkPiRuntimeError,
  type LarkPiProgressEvent,
  type LarkPiRuntimeAttachment,
  type LarkPiRuntimeService,
} from '../../../application/runtime/lark-pi-runtime.service';
import type {
  ChannelIdentityRepoPort,
  ResolvedUserIdentity,
} from '../../persistence/channel-identity.repository';
import type { ConversationRepoPort } from '../../persistence/conversation.repository';
import type { Logger } from '../../../shared/logger';
import type { TypedEnv } from '../../../config/env';
import type { ApprovalGateService } from '../../../application/approval/approval-gate.service';
import type {
  LarkApprovalCardHandler,
  LarkAuthenticatedCardActor,
} from './lark-approval-card.handler';
import type { LarkKnowledgeReviewService } from '../../../application/knowledge/lark-knowledge-review.service';
import type { ChatMessageSerializer } from '../../../application/channels/chat-message-serializer';
import type { LaneLeaseHolder } from '../../../application/channels/lane-lease.holder';
import { fenceFinalReplies } from './lark-lane-fence';
import { BusyLaneNotices } from './lark-busy-notice';
import {
  absorbLaneBurst,
  completeAbsorbedReceipts,
  toBatchableMessage,
} from './lark-message-batch';
import type { LarkOAuthService } from '../../lark/lark-oauth.service';
import type { IntegrationConnectionRepository } from '../../persistence/integration-connection.repository';
import type { CachePort } from '../../../shared/cache';
import {
  asChatId,
  asCompanyId,
  asCorrelationId,
  asDepartmentId,
  asMessageId,
  asUserId,
} from '../../../shared/ids';
import { asCompanyRoleSlug } from '../../../domain/permissions/company-role';
import type {
  ConversationHandle,
  StatusHandle,
} from '../../../application/channels/channel.adapter';
import type { IncomingMessage } from '../../../domain/channel/incoming-message';
import {
  verifyLarkWebhookRequest,
  maybeDecryptLarkBody,
} from './lark-security';
import {
  parseLarkAttachments,
  type LarkAttachment,
  type LarkAudioAttachment,
} from './lark-attachment.parser';
import type { LarkChatContextService } from '../../../application/chat-context/lark-chat-context.service';
import type {
  GroupContextBlock,
  GroupContextHydrator,
} from '../../../application/chat-context/group-context.hydrator';
import type { PrismaClient } from '../../../generated/prisma';
import type { GroupChatAttachmentContext } from '../../../domain/conversation/group-context';
import { fetchParentMessage, buildParentContextPrefix, type ParentMessageResult } from './lark-parent-message';
import type { LarkContactsClient } from './clients/lark-contacts.client';
import type { LarkFileClient } from './clients/lark-file.client';
import type { ElevenLabsTranscriptionClient } from '../../ai/transcription/elevenlabs-transcription.client';
import {
  buildLarkDurableIngressLaneKey,
  buildLarkExecutionLaneKey,
  buildLarkIngressLaneKey,
  buildLarkRoutingKeys,
} from './lark-routing';
import type {
  ChannelDeliveryRepoPort,
  ResumableDelivery,
} from '../../persistence/channel-delivery.repository';
import type {
  ChannelDeclaredPlan,
  ChannelLedgerRow,
  ChannelPlanStepStatus,
  ChannelRunState,
  FinalReply,
} from '../../../domain/channel/outbound';
import {
  isUntaggedGroupMessage,
  mayPrepareAttachment,
  mayPrepareAttachments,
  resolveCompanyUntaggedGroupPolicy,
  UNTAGGED_ATTACHMENTS_CONTROL,
  type ResolvedUntaggedGroupPolicy,
  type UntaggedGroupPolicy,
} from './lark-untagged-policy';
import { appendLarkMentionContext, listLarkMentionOpenIds } from './lark-mention-context';
import {
  isSupportedLarkMedia,
  isAwaitingItsQuestion,
  unreadableImageNotice,
  unsupportedDocumentNotice,
  MAX_INLINE_IMAGE_BYTES,
} from './lark-media-support';
import { conversationKeyForMessage } from '../../../domain/conversation/conversation-key';
import { userHistoryContent } from '../../../domain/conversation/history-content';
import {
  buildLarkGroupSettingsCard,
  DEFAULT_LARK_GROUP_MODE,
  loadLarkGroupMode,
  withLarkGroupMode,
} from './lark-group-mode';
import { parseLarkFinalDeliveryEnvelope } from './lark-final-delivery';
import { foldRepeatedRows, sanitizeRunText } from './lark-card.builder';
import { gatewayOpPhrase, toolLabel } from '../../../domain/tools/tool-labels';
import {
  buildSignInCard,
  signInFallbackText,
  SIGN_IN_WORKSPACE_NOT_CONNECTED,
  SIGN_IN_DIRECTORY_UNAVAILABLE,
  SIGN_IN_UNAVAILABLE,
  SIGN_IN_MISSING_EMAIL,
} from './lark-signin';
import type {
  IngressReceipt,
  IngressReceiptRepoPort,
} from '../../persistence/ingress-receipt.repository';
import type { LarkIngressQueue } from '../../../application/lark-ingress/lark-ingress.queue';

type LarkPiRuntimePort =
  Pick<LarkPiRuntimeService, 'run'>
  & Partial<Pick<LarkPiRuntimeService, 'hasActiveSession' | 'stagePendingAttachments'>>;

const QUEUED_REQUEST_TEXT =
  'Your request is queued. I’ll start it as soon as your previous request finishes.';

export interface LarkWebhookDeps {
  adapter: LarkChannelAdapter;
  piRuntime: LarkPiRuntimePort;
  channelIdentityRepo: ChannelIdentityRepoPort;
  conversationRepo: ConversationRepoPort;
  ingressReceiptRepo: IngressReceiptRepoPort;
  ingressQueue: Pick<LarkIngressQueue, 'enqueue'>;
  logger: Logger;
  env: TypedEnv;
  approvalGate?: ApprovalGateService;
  approvalCardHandler?: LarkApprovalCardHandler;
  knowledgeReviewService?: LarkKnowledgeReviewService;
  larkOAuthService?: LarkOAuthService;
  connectionRepo?: IntegrationConnectionRepository;
  /** Origin of the web app — the sign-in card's button points here. */
  appBaseUrl: string;
  cache: CachePort;
  voiceFileClient?: Pick<LarkFileClient, 'downloadFile'>;
  voiceTranscriber?: Pick<ElevenLabsTranscriptionClient, 'transcribe'>;
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
  /**
   * Absent means a group run answers from the current message alone: every
   * participant's container then holds a different understanding of one thread.
   */
  groupContextHydrator?: Pick<GroupContextHydrator, 'hydrate'>;
  /**
   * Absent means documents are excerpted inline for the turn but never
   * indexed — the turn still answers, later questions have nothing to retrieve.
   */
  prisma?: PrismaClient;
  /** Optional: absent means a retried run re-runs the agent, as before Wave 5. */
  channelDeliveryRepo?: ChannelDeliveryRepoPort;
  larkContactsClient?: Pick<LarkContactsClient, 'getTenantKey' | 'getUser'>;
  /** Test seam for parent authorship/content lookup; production uses Lark. */
  fetchParentMessage?: typeof fetchParentMessage;
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

          // Requester-owned memory review decisions are resolved before the
          // generic approval handler so they cannot be mistaken for manager HITL.
          if (deps.knowledgeReviewService?.isKnowledgeReviewAction(cardEvent)) {
            const result = await deps.knowledgeReviewService.handle(cardEvent, actor);
            res.status(200).json(result.responseBody);
            return;
          }

          const actionValue = (cardEvent as any)?.action?.value;
          const actionObj = typeof actionValue === 'string' ? (() => { try { return JSON.parse(actionValue); } catch { return null; } })() : actionValue;
          if (actionObj?.action === 'set_group_mode') {
            res.status(200).json({
              toast: {
                type: 'info',
                content: 'Divo always replies in threads inside groups.',
              },
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
    const admittedCompany = await deps.channelIdentityRepo
      .resolveLarkTenantCompanyId(tenantKey);
    if (!admittedCompany.ok) {
      requestLog.error('webhook.identity.tenant_binding_lookup_failed', {
        error: admittedCompany.error.message,
      });
      res.status(503).json({ error: 'ingress_unavailable' });
      return;
    }
    const admittedCompanyId = admittedCompany.value ?? undefined;
    const routedIncoming = await resolveIncomingGroupMode(
      incoming,
      deps,
      admittedCompanyId,
    );

    // ── Step 5: Persist before ACK so Lark retries any failed admission ──────
    const receipt = await deps.ingressReceiptRepo.accept({
      channel: 'lark',
      tenantKey,
      ...(admittedCompanyId ? { companyId: admittedCompanyId } : {}),
      messageId: String(incoming.messageId),
      payload: event,
      // Recorded here rather than derived later so a run can find the rest of
      // its burst with one indexed read instead of re-parsing every pending
      // payload in the channel.
      laneKey: buildLarkDurableIngressLaneKey(
        routedIncoming,
        admittedCompanyId,
      ),
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

  const parsedIncoming: IncomingMessage = {
    ...parsed.value,
    traceId: asCorrelationId(`${String(parsed.value.traceId)}:replay`),
  };
  const incoming = await resolveIncomingGroupMode(parsedIncoming, deps);
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
        turnSignal,
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

  const parsedIncoming = parsed.value;
  if (!isLarkHumanMessage(parsedIncoming)) return;
  if (
    parsedIncoming.tenantKey !== receipt.tenantKey
    || String(parsedIncoming.messageId) !== receipt.messageId
  ) {
    throw new Error('Persisted Lark ingress identity does not match its receipt');
  }
  if (receipt.companyId) {
    const currentCompany = await deps.channelIdentityRepo
      .resolveLarkTenantCompanyId(receipt.tenantKey);
    if (!currentCompany.ok || currentCompany.value !== receipt.companyId) {
      throw new Error('Persisted Lark ingress company binding changed');
    }
  }
  const resolvedIncoming = await resolveIncomingGroupMode(
    parsedIncoming,
    deps,
    receipt.companyId,
  );
  const incoming = withStoredLarkIngressMode(
    resolvedIncoming,
    receipt.laneKey,
    receipt.companyId,
  );

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

  let executionLaneKey = buildLarkIngressLaneKey(incoming);
  let resolvedLaneIdentity: ResolvedUserIdentity | null | undefined;
  if (incoming.tenantKey) {
    const laneIdentity = await deps.channelIdentityRepo.resolveByLarkTenantIdentity(
      incoming.userExternalId,
      incoming.tenantKey,
    );
    if (!laneIdentity.ok) {
      throw new Error(`Failed to resolve Lark runtime lane: ${laneIdentity.error.message}`);
    }
    resolvedLaneIdentity = laneIdentity.value;
    if (resolvedLaneIdentity) {
      executionLaneKey = buildLarkExecutionLaneKey({
        companyId: resolvedLaneIdentity.companyId,
        userId: resolvedLaneIdentity.userId,
      });
    }
  }
  const queueNoticeKey = String(incoming.traceId);

  if (isStopCommand(incoming.text)) {
    await handleStopBeforeLane(incoming, deps, requestLog);
    return;
  }

  // Decided before queueing, because "is this lane busy" is only true while the
  // previous turn is still running — asking after `runAndWait` has admitted
  // this task would always answer yes, and every message would look queued.
  if (deps.busyNotices && shouldStartLarkAgent(incoming)) {
    const decision = deps.busyNotices.decide(queueNoticeKey, {
      laneBusy: deps.serializer.isActive(executionLaneKey),
      isCommand: (incoming.text ?? '').trim().startsWith('/'),
    });
    if (decision.notify) {
      // This status coordinator is keyed by the request correlation ID. When
      // the lane opens, Pi progress reuses it and final delivery replaces this
      // exact card with the answer.
      const sent = await deps.adapter.sendStatus(
        conversationForIncoming(incoming),
        {
          kind: 'status',
          terminal: false,
          timeline: {
            phase: 'Queued',
            state: 'queued',
            liveLabel: QUEUED_REQUEST_TEXT,
          },
        },
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
          anchor: toBatchableMessage(
            incoming,
            event,
            receipt.acceptedAt.getTime(),
            receipt.laneKey,
          ),
          anchorReceiptId: receipt.receiptId,
          repo: deps.ingressReceiptRepo,
          adapter: deps.adapter,
          log: requestLog,
          ...(incoming.groupReplyMode
            ? { groupReplyMode: incoming.groupReplyMode }
            : {}),
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
          {
            ...deps,
            adapter,
            onRetryableDelivery: async () => {
              if (absorbedReceiptIds.length > 0 && deps.ingressReceiptRepo) {
                await completeAbsorbedReceipts(
                  absorbedReceiptIds,
                  deps.ingressReceiptRepo,
                  requestLog,
                );
                absorbedReceiptIds = [];
              }
            },
          },
          requestLog,
          turnSignal,
          resolvedLaneIdentity,
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
    // The notice key belongs to this request, so its eventual retry may create
    // or update the same correlation-scoped status card again.
    if (deps.busyNotices) {
      deps.busyNotices.clear(queueNoticeKey);
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
  const stored = parseLarkFinalDeliveryEnvelope(resumable.payload);
  const reply = stored?.reply ?? resumable.payload as unknown as FinalReply;
  const conversation: ConversationHandle = {
    channel: 'lark',
    chatId: stored ? asChatId(stored.target.chatId) : incoming.chatId,
    ...(stored?.target.replyToMessageId
      ? { replyToMessageId: asMessageId(stored.target.replyToMessageId) }
      : stored
        ? {}
        : { replyToMessageId: incoming.messageId }),
    ...(stored?.target.replyInThread !== undefined
      ? { replyInThread: stored.target.replyInThread }
      : stored
        ? {}
        : {
            replyInThread:
              incoming.chatType === 'group'
              && incoming.groupReplyMode !== 'inline',
          }),
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

async function resolveIncomingGroupMode(
  incoming: IncomingMessage,
  deps: Pick<LarkWebhookDeps, 'channelIdentityRepo' | 'logger' | 'prisma'>,
  knownCompanyId?: string,
): Promise<IncomingMessage> {
  if (incoming.chatType !== 'group') return incoming;
  if (!deps.prisma || !incoming.tenantKey) {
    return withLarkGroupMode(incoming, DEFAULT_LARK_GROUP_MODE);
  }

  let companyId = knownCompanyId;
  if (!companyId) {
    const company = await deps.channelIdentityRepo
      .resolveLarkTenantCompanyId(incoming.tenantKey);
    companyId = company.ok ? company.value ?? undefined : undefined;
  }
  if (!companyId) {
    return withLarkGroupMode(incoming, DEFAULT_LARK_GROUP_MODE);
  }

  try {
    const mode = await loadLarkGroupMode(deps.prisma, {
      companyId,
      tenantKey: incoming.tenantKey,
      ...(incoming.appId ? { appId: incoming.appId } : {}),
      chatId: String(incoming.chatId),
    });
    return withLarkGroupMode(incoming, mode);
  } catch (error) {
    deps.logger.warn('webhook.group_mode.load_failed', {
      companyId,
      chatId: incoming.chatId,
      error: String(error),
    });
    return withLarkGroupMode(incoming, DEFAULT_LARK_GROUP_MODE);
  }
}

function withStoredLarkIngressMode(
  incoming: IncomingMessage,
  laneKey: string | undefined,
  companyId: string | undefined,
): IncomingMessage {
  if (incoming.chatType !== 'group' || !laneKey) return incoming;

  const inline = withLarkGroupMode(incoming, 'inline');
  if (buildLarkDurableIngressLaneKey(inline, companyId) === laneKey) return inline;

  const threaded = withLarkGroupMode(incoming, 'threaded');
  if (buildLarkDurableIngressLaneKey(threaded, companyId) === laneKey) return threaded;

  // Inline mode did not exist when legacy `ingress-lane` receipts were
  // written. A requester-shaped legacy key is therefore the old top-level
  // threaded fallback, not evidence that the group was configured inline.
  return (
    buildLarkIngressLaneKey(threaded) === laneKey
    || buildLarkIngressLaneKey(inline) === laneKey
  ) ? threaded : incoming;
}

async function rethrowIfDeliveryNeedsRetry(
  error: Error,
  incoming: IncomingMessage,
  deps: {
    channelDeliveryRepo?: ChannelDeliveryRepoPort;
    onRetryableDelivery?: () => Promise<void>;
  },
  log: Logger,
): Promise<void> {
  if (!deps.channelDeliveryRepo) return;

  const resumable = await deps.channelDeliveryRepo.findResumable(
    'lark',
    String(incoming.traceId),
  );
  if (!resumable.ok) {
    log.warn('webhook.delivery.retry_lookup_failed', {
      error: resumable.error.message,
    });
    throw error;
  }
  if (!resumable.value) return;

  log.warn('webhook.delivery.retry_pending', {
    deliveryId: resumable.value.deliveryId,
    attempts: resumable.value.attempts,
  });
  await deps.onRetryableDelivery?.();
  throw error;
}

function runtimeThreadIdFor(incoming: IncomingMessage): string {
  return String(conversationKeyForMessage({
    chatId: String(incoming.chatId),
    chatType: incoming.chatType,
    messageId: String(incoming.messageId),
    ...(incoming.threadId ? { threadId: String(incoming.threadId) } : {}),
    ...(incoming.rootMessageId ? { rootMessageId: String(incoming.rootMessageId) } : {}),
    userExternalId: incoming.userExternalId,
    ...(incoming.groupReplyMode ? { groupReplyMode: incoming.groupReplyMode } : {}),
  }));
}

function conversationForIncoming(incoming: IncomingMessage): ConversationHandle {
  return {
    channel: 'lark',
    chatId: incoming.chatId,
    replyToMessageId: incoming.messageId,
    replyInThread:
      incoming.chatType === 'group'
      && incoming.groupReplyMode !== 'inline',
    correlationId: asCorrelationId(incoming.traceId),
  };
}

const DIVO_OWNED_THREAD_REF = 'divoOwnedThread';

function isDivoOwnedThreadRef(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>)[DIVO_OWNED_THREAD_REF] === true;
}

async function readDivoOwnedThreadRefs(
  prisma: PrismaClient | undefined,
  companyId: string | null,
  incoming: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  if (
    !prisma
    || !companyId
    || incoming.chatType !== 'group'
    || !(incoming.rootMessageId || incoming.threadId)
  ) return null;

  const conversation = await prisma.runtimeConversation.findUnique({
    where: {
      companyId_channel_channelConversationKey: {
        companyId,
        channel: 'lark',
        channelConversationKey: runtimeThreadIdFor(incoming),
      },
    },
    select: { refsJson: true },
  });
  return typeof conversation?.refsJson === 'object'
    && conversation.refsJson !== null
    && !Array.isArray(conversation.refsJson)
    ? conversation.refsJson as Record<string, unknown>
    : null;
}

async function markDivoOwnedThread(
  prisma: PrismaClient | undefined,
  companyId: string | null,
  incoming: IncomingMessage,
  refs: Record<string, unknown> | null,
  userId?: string,
): Promise<void> {
  if (!prisma || !companyId || incoming.chatType !== 'group') return;

  const conversationKey = runtimeThreadIdFor(incoming);
  const nextRefs = {
    ...(refs ?? {}),
    chatType: 'group',
    larkOpenId: incoming.userExternalId,
    [DIVO_OWNED_THREAD_REF]: true,
  };
  await prisma.runtimeConversation.upsert({
    where: {
      companyId_channel_channelConversationKey: {
        companyId,
        channel: 'lark',
        channelConversationKey: conversationKey,
      },
    },
    create: {
      companyId,
      channel: 'lark',
      channelConversationKey: conversationKey,
      rawChannelKey: String(incoming.chatId),
      ...(userId ? { createdByUserId: userId } : {}),
      refsJson: nextRefs,
    },
    update: {
      updatedAt: new Date(),
      refsJson: nextRefs,
    },
  });
}

function piToolStatus(toolName: string, toolId?: string): {
  label: string;
  liveLabel: string;
} {
  // A governed call is named by the tool it ran, not by the gateway it went
  // through. Heading the row "Divo" spent its widest word on plumbing and then
  // repeated the real name in the detail beside it; and the vendor-prefix
  // guesses this replaced said "Google" where the tool table already knows to
  // say "Google Drive".
  if (toolId) {
    const { name } = toolLabel(toolId);
    return { label: name, liveLabel: `Working in ${name}…` };
  }
  if (toolName === 'bash') return { label: 'Terminal', liveLabel: 'Running a terminal command…' };
  if (toolName === 'read') return { label: 'Files', liveLabel: 'Reading files…' };
  if (toolName === 'write') return { label: 'Files', liveLabel: 'Writing files…' };
  if (toolName === 'edit') return { label: 'Files', liveLabel: 'Editing files…' };
  // Named rather than left to the humanizer below, which was rendering these
  // as "Skill view" and "Todos" — an internal tool id spelled out with a space
  // in it, on a card a customer reads.
  if (toolName === 'divo_skill_view') return { label: 'Skill', liveLabel: 'Loading a Divo skill…' };
  if (toolName === 'divo_skill_resolve') {
    return { label: 'Skill', liveLabel: 'Finding the right Divo skill…' };
  }
  if (toolName === 'divo_todos') return { label: 'Plan', liveLabel: 'Planning the work…' };
  if (toolName === 'divo_subagents') {
    return { label: 'Subagents', liveLabel: 'Running a subagent…' };
  }
  if (toolName === 'divo_artifact') {
    return { label: 'Artifact', liveLabel: 'Preparing an artifact…' };
  }
  if (toolName === 'divo_gateway') {
    return { label: 'Divo', liveLabel: 'Using a company capability…' };
  }
  // Never a bare "Tool": the activity row exists to say what ran, and an
  // anonymous row is a line of card height spent on nothing. Any unmapped tool
  // is still readable once its identifier is written out as words.
  const humanized = toolName
    .replace(/^divo_/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  const label = humanized ? humanized.charAt(0).toUpperCase() + humanized.slice(1) : 'Tool';
  return { label, liveLabel: `Running ${label.toLowerCase()}…` };
}

/**
 * What a step is about, in words rather than identifiers.
 *
 * The container sends the argument that names the work, untranslated, because
 * the table that turns `omsSiteData` into "OMS Site Data" lives here — a card
 * reading `omsSiteData · tools.invoke` shows the user two internal identifiers
 * and an internal namespace. A shell command or a file name is already words
 * and is passed through as it stands.
 */
function piCallDetail(
  toolName: string,
  toolId: string | undefined,
  detail: string | undefined,
): string | undefined {
  if (toolName === 'divo_gateway' || toolId) return gatewayOpPhrase(detail);
  // An older container still sends a skill's UUID here. It names nothing to a
  // reader, and the row is labelled properly when the call returns anyway.
  return detail && UUID_ONLY.test(detail) ? undefined : detail;
}

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function divoFacingRuntimeMessage(message: string): string {
  return message
    .replace(/All Pi slots are busy/gi, 'Divo is at full capacity')
    .replace(/Your Pi agent/gi, 'Divo')
    .replace(/\bPi agent\b/gi, 'Divo')
    .replace(/\bpi\b/gi, 'Divo');
}

/**
 * A group thread is one conversation held by several containers.
 *
 * Each participant runs their own isolated Pi, so none of them can remember the
 * thread on the others' behalf: the shared transcript is read here, for this run
 * only, and the run's own session is scoped to the run so re-reading it every
 * turn cannot pile up copies inside one user's volume. A DM has a single
 * participant, so its durable session is left exactly as it was.
 */
async function sharedConversationFor(input: {
  incoming: IncomingMessage;
  companyId: string;
  hydrator?: Pick<GroupContextHydrator, 'hydrate'>;
}): Promise<GroupContextBlock | undefined> {
  if (input.incoming.chatType !== 'group' || !input.hydrator) return undefined;

  // A bare mention carries the adjacent Lark messages it was resolved against.
  // They go in through the hydrator rather than being appended afterwards, so
  // they arrive inside the same framing and fence as the stored transcript —
  // appended after the trust policy they would be the one region of the prompt
  // that nothing governs.
  const block = await input.hydrator.hydrate({
    companyId: input.companyId,
    chatId: String(input.incoming.chatId),
    currentMessageId: String(input.incoming.messageId),
    ...(input.incoming.referenceContext ? { adjacentContext: input.incoming.referenceContext } : {}),
  });
  return block ?? undefined;
}

/**
 * Turn the quoted message's images into attachments the run can open.
 *
 * The parent hydrator has already downloaded and size-capped these, so the
 * bytes are in hand as data URLs and the only work left is decoding them. A URL
 * that will not decode is dropped rather than staged: a truncated file in the
 * inbox reads to the agent as a picture it should be able to open.
 */
export function quotedImageAttachments(
  imageUrls: readonly string[] | undefined,
  log: Logger,
): LarkPiRuntimeAttachment[] {
  const attachments: LarkPiRuntimeAttachment[] = [];
  for (const [index, url] of (imageUrls ?? []).entries()) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
    if (!match) {
      log.warn('webhook.quoted_image.unreadable', { index });
      continue;
    }
    const mimeType = match[1]!.toLowerCase();
    const bytes = Buffer.from(match[2]!, 'base64');
    if (bytes.length === 0) {
      log.warn('webhook.quoted_image.empty', { index, mimeType });
      continue;
    }
    const extension = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    attachments.push({
      kind: 'image',
      name: `quoted_image_${index + 1}.${extension}`,
      mimeType,
      openStream: async () => (async function* () { yield new Uint8Array(bytes); })(),
    });
  }
  return attachments;
}

/**
 * A publisher its callers never wait on.
 *
 * Publishing a Lark status card costs a network round trip, and the runtime
 * reads its result stream one line at a time, awaiting each progress event
 * before taking the next. Awaiting a card there puts every one of those round
 * trips between the model finishing and the answer being read.
 *
 * So `queue` returns at once. At most one publish is in flight, and everything
 * raised while it runs collapses into a single follow-up carrying whatever the
 * newest state is by the time that follow-up starts. A card shows current
 * status rather than a replay, so dropping superseded frames is the intent.
 * Serializing also keeps the first publish — the one that creates the card —
 * from racing a second into a duplicate card.
 */
export function createCoalescedPublisher(
  publish: () => Promise<void>,
  onError: (error: unknown) => void,
): { readonly queue: () => void; readonly settle: () => Promise<void> } {
  let inFlight: Promise<void> | null = null;
  let pending = false;

  const drain = async (): Promise<void> => {
    try {
      await publish();
      while (pending) {
        pending = false;
        await publish();
      }
    } catch (error) {
      onError(error);
    }
  };

  // Cleared by identity, so a drain that finished before its promise was even
  // stored cannot leave a settled promise parked in the slot forever — which
  // would strand every later publish and hang `settle`.
  const start = (): Promise<void> => {
    const run: Promise<void> = drain().finally(() => {
      if (inFlight === run) inFlight = null;
    });
    return run;
  };

  return {
    queue: () => {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = start();
    },
    settle: async () => {
      while (inFlight) await inFlight;
    },
  };
}

const TRANSCRIPT_MAX_CHARS = 3_000;
const TRANSCRIPT_LINE_MAX  = 240;

/**
 * The run's log, kept for after the answer has replaced it.
 *
 * The final card is an edit of the status card, so delivering the answer
 * destroys every trace of how it was reached — on a thirteen-minute run that is
 * the entire record of the work. Folded onto the answer as a trace panel, it
 * costs one closed line and is there for the person who asks "what did it
 * actually do".
 *
 * A run that called no tool gets none: its log is only the model talking, which
 * is what the answer already is.
 */
export function runTranscript(input: readonly ChannelLedgerRow[]): string | undefined {
  if (!input.some(row => row.kind !== 'say')) return undefined;

  // Folded the same way the live card folds, so the trace is the log the user
  // was watching rather than a second, longer account of the same run.
  const rows = foldRepeatedRows(input);
  const rendered = rows.map(row => row.kind === 'say'
    ? sanitizeRunText(row.label, TRANSCRIPT_LINE_MAX)
    : [
        `**${row.label}**`,
        ...(row.count > 1 ? [`×${row.count}`] : []),
        ...(row.outcome ? [sanitizeRunText(row.outcome, TRANSCRIPT_LINE_MAX)] : []),
      ].join('  '));

  // Kept from the newest backwards, matching how the live card windows itself —
  // the steps nearest the answer are the ones that explain it.
  const kept: string[] = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    const line = rendered[i]!;
    if (used + line.length > TRANSCRIPT_MAX_CHARS) {
      kept.unshift(`_+${i + 1} earlier step${i === 0 ? '' : 's'}._`);
      break;
    }
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept.length > 0 ? kept.join('\n') : undefined;
}

export async function runPiAndDeliver(input: {
  incoming: IncomingMessage;
  runContext: Parameters<LarkPiRuntimeService['run']>[0]['runContext'];
  conversation: ConversationHandle;
  deps: {
    adapter: LarkChannelAdapter;
    piRuntime: LarkPiRuntimePort;
    conversationRepo?: Pick<ConversationRepoPort, 'appendTurn'>;
    channelDeliveryRepo?: ChannelDeliveryRepoPort;
    groupContextHydrator?: Pick<GroupContextHydrator, 'hydrate'>;
    onRetryableDelivery?: () => Promise<void>;
  };
  log: Logger;
  attachments?: readonly LarkPiRuntimeAttachment[];
  signal?: AbortSignal;
  rethrowRuntimeFailureAfterDelivery?: boolean;
}): Promise<string | null> {
  const { incoming, runContext, conversation, deps, log, attachments, signal } = input;
  const controller = new AbortController();
  const runtimeSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const correlationId = String(incoming.traceId);
  deps.adapter.registerAbortController(correlationId, controller, {
    userId: String(runContext.userId),
    companyId: String(runContext.companyId),
    conversationKey: runtimeThreadIdFor(incoming),
  });
  const startedAtMs = Date.now();
  const ledger = new Map<string, ChannelLedgerRow>();
  let statusHandle: StatusHandle | null = null;
  let phase = 'Starting';
  let state: ChannelRunState = 'thinking';
  let liveLabel = 'Getting things ready…';
  let actionCount = 0;
  let declared: ChannelDeclaredPlan | undefined;
  /** Bumped per tool call so each stretch of talking gets its own ledger keys. */
  let sayTurn = 0;

  /**
   * A tool that reported work underneath itself: subagents become children of
   * the row that spawned them, and a declared checklist becomes the run's plan.
   *
   * The checklist is the run's, not the call's, so it outlives the tool call
   * that declared it — otherwise the plan would vanish the moment the tool
   * returned, which is exactly when the user starts wanting it.
   */
  const applyProgressDetail = (
    callId: string,
    detail: {
      readonly children?: readonly { label: string; status: ChannelPlanStepStatus; detail?: string }[];
      readonly todos?: readonly { title: string; status: ChannelPlanStepStatus }[];
      readonly detail?: string;
    },
  ): void => {
    // A call the model addressed by UUID can only be named once it returns.
    if (detail.detail) {
      const current = ledger.get(callId);
      if (current) ledger.set(callId, { ...current, outcome: detail.detail });
    }
    if (detail.children?.length) {
      const current = ledger.get(callId);
      if (current) {
        ledger.set(callId, {
          ...current,
          children: detail.children.map(child => ({
            label: child.label,
            count: 1,
            status: child.status,
            ...(child.detail ? { outcome: child.detail } : {}),
          })),
        });
      }
    }
    if (detail.todos?.length) {
      const items = detail.todos.map(todo => ({ title: todo.title, status: todo.status }));
      const settled = items.filter(i => i.status === 'done' || i.status === 'skipped').length;
      const current = items.find(i => i.status === 'running')?.title;
      const next = items.find(i => i.status === 'pending')?.title;
      declared = {
        done: settled,
        total: items.length,
        ...(current ? { current } : next ? { next } : {}),
        items,
      };
    }
  };

  const publishStatus = async (): Promise<void> => {
    const update = {
      kind: 'status' as const,
      terminal: false,
      timeline: {
        phase,
        state,
        liveLabel,
        actionCount,
        startedAtMs,
        ...(ledger.size > 0 ? { ledger: [...ledger.values()] } : {}),
        ...(declared ? { declared } : {}),
      },
    };
    const result = statusHandle
      ? await deps.adapter.editStatus(statusHandle, update)
      : await deps.adapter.sendStatus(conversation, update);
    if (result.ok) {
      statusHandle = result.value;
    } else {
      log.warn('webhook.pi.status_failed', {
        error: result.error.message,
        correlationId,
      });
    }
  };

  const { queue: queueStatus, settle: settleStatus } = createCoalescedPublisher(
    publishStatus,
    error => log.warn('webhook.pi.status_failed', { error: String(error), correlationId }),
  );

  const reportProgress = (event: LarkPiProgressEvent): void => {
    if (event.type === 'starting') {
      phase = 'Starting';
      state = 'thinking';
      liveLabel = divoFacingRuntimeMessage(event.label);
    } else if (event.type === 'working') {
      phase = 'Working';
      state = 'working';
      liveLabel = 'Working…';
    } else if (event.type === 'ready' || event.type === 'thinking') {
      phase = 'Thinking';
      state = 'thinking';
      liveLabel = 'Understanding your request…';
    } else if (event.type === 'say') {
      phase = 'Writing';
      state = 'writing';
      liveLabel = 'Preparing your response…';
      // Keyed by turn as well as block, because a block index restarts at zero
      // in each new assistant message — without the turn, the second thing the
      // model says would overwrite the first instead of following it.
      ledger.set(`say:${sayTurn}:${event.index}`, {
        kind: 'say',
        label: event.text,
        count: 1,
        status: 'done',
      });
    } else if (event.type === 'tool_start') {
      const tool = piToolStatus(event.toolName, event.toolId);
      phase = 'Working';
      state = 'working';
      liveLabel = tool.liveLabel;
      actionCount += 1;
      // A tool call closes whatever the model was saying; what it says next
      // belongs after this row, not merged into the sentence before it.
      sayTurn += 1;
      // The outcome starts as what the call is *about* — the command, the file,
      // the capability — because "what it produced" is not known yet and a bare
      // "In progress" beside a ● is the restatement the card is built to avoid.
      const about = piCallDetail(event.toolName, event.toolId, event.detail);
      ledger.set(event.callId, {
        kind: 'tool',
        label: tool.label,
        count: 1,
        status: 'running',
        ...(about ? { outcome: about } : {}),
      });
    } else if (event.type === 'tool_progress') {
      applyProgressDetail(event.callId, event);
      phase = 'Working';
      state = 'working';
    } else if (event.type === 'tool_end') {
      applyProgressDetail(event.callId, event);
      const current = ledger.get(event.callId);
      if (current) {
        ledger.set(event.callId, {
          ...current,
          status: event.isError ? 'failed' : 'done',
        });
      }
      phase = 'Working';
      state = 'working';
      liveLabel = event.isError ? 'A step failed; checking what can continue…' : 'Continuing…';
    } else {
      phase = 'Writing';
      state = 'writing';
      liveLabel = 'Preparing your response…';
    }
    queueStatus();
  };

  let text: string;
  let runtimeFailure: unknown;
  try {
    await publishStatus();
    // Read after the status card is up: the shared read is the first thing the
    // run does, and a slow room lookup should show as "starting", not silence.
    const sharedContext = await sharedConversationFor({
      incoming,
      companyId: String(runContext.companyId),
      ...(deps.groupContextHydrator ? { hydrator: deps.groupContextHydrator } : {}),
    });
    const result = await deps.piRuntime.run({
      incoming,
      runContext,
      conversation,
      threadId: runtimeThreadIdFor(incoming),
      ...(attachments?.length ? { attachments } : {}),
      ...(sharedContext ? { sharedContext } : {}),
      ...(incoming.chatType === 'group' ? { sessionScope: 'run' as const } : {}),
      abortSignal: runtimeSignal,
      onProgress: reportProgress,
    });
    text = result.text;
  } catch (error) {
    runtimeFailure = error;
    if (runtimeSignal.aborted) {
      log.info('webhook.pi.interrupted', { correlationId });
      text = 'Stopped. I did not continue this request.';
    } else {
      const code = error instanceof LarkPiRuntimeError ? error.code : 'run_failed';
      text = error instanceof LarkPiRuntimeError
        ? divoFacingRuntimeMessage(error.userMessage)
        : 'Divo could not complete this request (run_failed). No fallback agent was run.';
      log.error('webhook.pi.failed', {
        code,
        error: String(error),
        correlationId: incoming.traceId,
      });
    }
  } finally {
    deps.adapter.cleanupAbortController(correlationId);
  }

  if (runtimeFailure && deps.conversationRepo) {
    const conversationKey = runtimeThreadIdFor(incoming);
    const scope = { companyId: String(runContext.companyId), channel: 'lark' as const };
    const sourceMessageId = String(incoming.messageId);
    const userTurn = await deps.conversationRepo.appendTurn(
      conversationKey,
      {
        role: 'user',
        content: userHistoryContent(incoming),
        timestamp: incoming.timestamp,
      },
      scope,
      { dedupeKey: `lark:${sourceMessageId}:user`, sourceMessageId },
    );
    const assistantTurn = await deps.conversationRepo.appendTurn(
      conversationKey,
      { role: 'assistant', content: text, timestamp: new Date().toISOString() },
      scope,
      { dedupeKey: `lark:${sourceMessageId}:assistant`, sourceMessageId },
    );
    if (!userTurn.ok || !assistantTurn.ok) {
      log.warn('webhook.pi.failure_history_persist_failed', {
        correlationId,
        userTurnSaved: userTurn.ok,
        assistantTurnSaved: assistantTurn.ok,
      });
    }
  }

  phase = 'Writing';
  state = 'writing';
  liveLabel = 'Preparing your response…';
  // Settled rather than queued: the answer goes out next, and the card should
  // not still be claiming the run is working once it has landed.
  queueStatus();
  await settleStatus();

  const transcript = runTranscript([...ledger.values()]);
  const delivered = await deps.adapter.sendFinalReply(conversation, {
    kind: 'final',
    text,
    format: 'markdown',
    ...(transcript ? { executionTrace: transcript } : {}),
  });
  if (!delivered.ok) {
    log.error('webhook.pi.delivery_failed', {
      error: delivered.error.message,
      correlationId: incoming.traceId,
    });
    await rethrowIfDeliveryNeedsRetry(delivered.error, incoming, deps, log);
    return null;
  }
  if (input.rethrowRuntimeFailureAfterDelivery && runtimeFailure) {
    throw runtimeFailure;
  }
  return text;
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

/**
 * Where the sign-in card's button goes.
 *
 * It used to go straight to Lark's OAuth consent screen, and the callback that
 * came back both stored tokens and minted a session — a second way to sign in,
 * living beside the web one. There is one sign-in now: this points at the web
 * login, carrying a one-time nonce that says which Lark account asked. The web
 * app hands that nonce back to `POST /api/lark/auth/link`, which attaches the
 * identity to the session the web sign-in already created.
 *
 * Consequently this no longer needs Lark OAuth to be configured at all. A
 * deployment without `LARK_OAUTH_REDIRECT_URI` can still let people sign in;
 * it just cannot act *as* them until they connect Lark separately.
 */
async function createLarkLoginUrl(input: {
  companyId: string;
  userId: string;
  larkOpenId: string;
  tenantKey: string;
  /** The message that triggered the prompt, answered once sign-in completes. */
  pendingEvent?: Record<string, unknown>;
  deps: {
    appBaseUrl: string;
    cache: CachePort;
  };
}): Promise<string | null> {
  const nonce = randomBytes(32).toString('base64url');
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
    // Without the stored nonce the link cannot be honoured, so returning one
    // would send the person to a page that refuses them. `null` is the caller's
    // signal to say so plainly instead.
    return null;
  }

  const state = encodeLarkOAuthState({
    companyId:  input.companyId,
    userId:     input.userId,
    larkOpenId: input.larkOpenId,
    tenantKey:  input.tenantKey,
    nonce,
  });
  return `${input.deps.appBaseUrl.replace(/\/+$/, '')}/link/lark?state=${encodeURIComponent(state)}`;
}

async function processInBackground(
  incoming: IncomingMessage,
  rawEvent: Record<string, unknown>,
  deps: {
    adapter: LarkChannelAdapter;
    piRuntime: LarkPiRuntimePort;
    channelIdentityRepo: ChannelIdentityRepoPort;
    conversationRepo: ConversationRepoPort;
    logger: Logger;
    env: TypedEnv;
    larkOAuthService?: LarkOAuthService;
    connectionRepo?: IntegrationConnectionRepository;
    appBaseUrl: string;
    cache: CachePort;
    channelDeliveryRepo?: ChannelDeliveryRepoPort;
    onRetryableDelivery?: () => Promise<void>;
    chatContextService?: LarkChatContextService;
    groupContextHydrator?: Pick<GroupContextHydrator, 'hydrate'>;
    prisma?: PrismaClient;
    larkContactsClient?: Pick<LarkContactsClient, 'getTenantKey' | 'getUser'>;
    fetchParentMessage?: typeof fetchParentMessage;
  },
  log: Logger,
  signal?: AbortSignal,
  resolvedIdentity?: ResolvedUserIdentity | null,
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
  const identityResult = resolvedIdentity === undefined
    ? await deps.channelIdentityRepo.resolveByLarkTenantIdentity(
      incoming.userExternalId,
      tenantKey,
    )
    : null;
  let identity = resolvedIdentity === undefined
    ? identityResult?.ok
      ? identityResult.value
      : null
    : resolvedIdentity;
  const identityResolutionOk = resolvedIdentity !== undefined || identityResult?.ok === true;
  let signInReason: string | undefined;

  if (identity?.activeDepartmentId && deps.prisma && deps.connectionRepo) {
    const activeDepartmentId = identity.activeDepartmentId;
    const selectedMembership = await deps.prisma.departmentMembership.findFirst({
      where: {
        userId: identity.userId,
        departmentId: activeDepartmentId,
        status: 'active',
        department: { companyId: identity.companyId, status: 'active' },
      },
      select: { departmentId: true },
    });

    if (!selectedMembership) {
      const remainingMemberships = await deps.prisma.departmentMembership.findMany({
        where: {
          userId: identity.userId,
          status: 'active',
          department: { companyId: identity.companyId, status: 'active' },
        },
        select: { departmentId: true },
        take: 2,
      });
      const nextDepartmentId = remainingMemberships.length === 1
        ? remainingMemberships[0]!.departmentId
        : null;
      const revoked = await deps.connectionRepo.revokeLarkConnectionsForUser(
        identity.companyId,
        identity.userId,
      );
      if (!revoked.ok) throw new Error(`Failed to refresh changed department access: ${revoked.error.message}`);
      await deps.prisma.userDepartmentPreference.updateMany({
        where: {
          userId: identity.userId,
          companyId: identity.companyId,
          activeDepartmentId,
        },
        data: { activeDepartmentId: nextDepartmentId },
      });
      await deps.channelIdentityRepo.invalidateIdentityCache?.(incoming.userExternalId);
      log.warn('webhook.identity.department_changed', {
        companyId: identity.companyId,
        userId: identity.userId,
        staleDepartmentId: activeDepartmentId,
        nextDepartmentId,
        revokedConnectionCount: revoked.value,
        correlationId,
      });
      signInReason = 'Your department access changed, so I signed you out to refresh your permissions. Connect again to continue.';
      identity = null;
    }
  }

  let ambientCompanyId: string | null = null;
  if (!identity && incoming.chatType === 'group') {
    const companyResult = await deps.channelIdentityRepo.resolveLarkTenantCompanyId(tenantKey);
    ambientCompanyId = companyResult.ok ? companyResult.value : null;
  }

  const explicitlyAddressed = shouldStartLarkAgent(incoming);
  const mayContinueThread =
    isLarkHumanMessage(incoming)
    && incoming.chatType === 'group'
    && incoming.groupReplyMode !== 'inline'
    && Boolean(incoming.rootMessageId || incoming.threadId);
  const ownershipCompanyId = identity?.companyId ?? ambientCompanyId;
  let threadRefs: Record<string, unknown> | null = null;
  if (explicitlyAddressed || mayContinueThread) {
    try {
      threadRefs = await readDivoOwnedThreadRefs(
        deps.prisma,
        ownershipCompanyId,
        incoming,
      );
    } catch (error) {
      log.warn('webhook.thread_ownership.read_failed', {
        companyId: ownershipCompanyId,
        conversationKey: runtimeThreadIdFor(incoming),
        error: String(error),
        correlationId,
      });
      throw error;
    }
  }
  const continuesDivoThread = mayContinueThread && isDivoOwnedThreadRef(threadRefs);
  const shouldRespond = explicitlyAddressed || continuesDivoThread;

  if (explicitlyAddressed && ownershipCompanyId) {
    try {
      await markDivoOwnedThread(
        deps.prisma,
        ownershipCompanyId,
        incoming,
        threadRefs,
        identity?.userId,
      );
    } catch (error) {
      log.warn('webhook.thread_ownership.write_failed', {
        companyId: ownershipCompanyId,
        conversationKey: runtimeThreadIdFor(incoming),
        error: String(error),
        correlationId,
      });
      throw error;
    }
  }

  if (!identityResolutionOk || !identity) {
    if (incoming.chatType === 'group') {
      if (ambientCompanyId) {
        await storeUnknownGroupIncomingSnapshot({
          incoming,
          companyId: ambientCompanyId,
          deps,
          log,
        });
      }
    }

    if (!shouldRespond) {
      log.debug('webhook.group_message.not_mentioned.identity_missing', {
        chatId: incoming.chatId,
        messageId: incoming.messageId,
        larkOpenId: incoming.userExternalId,
        textRetained: Boolean(ambientCompanyId),
      });
      return;
    }

    // Say something on every path out of here. These branches used to log and
    // return, so a new customer — whose workspace is by definition not yet
    // connected — got silence that looked exactly like Divo being broken.
    const tell = (text: string) =>
      deps.adapter.sendToChatId(
        String(incoming.chatId),
        text,
        String(incoming.messageId),
        undefined,
        incoming.chatType === 'group'
          ? incoming.groupReplyMode !== 'inline'
          : undefined,
      )
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
          buildSignInCard({ name, url: loginUrl, ...(signInReason ? { reason: signInReason } : {}) }),
          incoming.chatType === 'group' ? String(incoming.messageId) : undefined,
          incoming.chatType === 'group'
            ? incoming.groupReplyMode !== 'inline'
            : undefined,
        );
        if (!card.ok) {
          // A working link in a plain message beats a button nobody received.
          log.warn('webhook.login_prompt.card_failed', {
            error: card.error.message, correlationId,
          });
          await tell(signInFallbackText({ name, url: loginUrl, ...(signInReason ? { reason: signInReason } : {}) }));
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
      await tell(SIGN_IN_UNAVAILABLE);
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

  if (
    shouldRespond
    &&
    deps.piRuntime.hasActiveSession
    && !await deps.piRuntime.hasActiveSession({
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      channel: 'lark',
      tenantId: tenantKey,
      userExternalId: incoming.userExternalId,
    })
  ) {
    const loginUrl = await createLarkLoginUrl({
      companyId: identity.companyId,
      userId: identity.userId,
      larkOpenId: incoming.userExternalId,
      tenantKey,
      pendingEvent: rawEvent,
      deps,
    });
    if (!loginUrl) {
      await deps.adapter.sendToChatId(
        String(incoming.chatId),
        SIGN_IN_UNAVAILABLE,
        String(incoming.messageId),
        undefined,
        incoming.chatType === 'group'
          ? incoming.groupReplyMode !== 'inline'
          : undefined,
      );
      return;
    }

    const name = identity.displayName ?? identity.email ?? 'there';
    const reason = 'Your Divo cloud session expired. Connect again and I’ll continue this request automatically.';
    const card = await deps.adapter.sendCardToChat(
      String(incoming.chatId),
      buildSignInCard({ name, url: loginUrl, reason }),
      incoming.chatType === 'group' ? String(incoming.messageId) : undefined,
      incoming.chatType === 'group'
        ? incoming.groupReplyMode !== 'inline'
        : undefined,
    );
    if (!card.ok) {
      await deps.adapter.sendToChatId(
        String(incoming.chatId),
        signInFallbackText({ name, url: loginUrl, reason }),
        String(incoming.messageId),
        undefined,
        incoming.chatType === 'group'
          ? incoming.groupReplyMode !== 'inline'
          : undefined,
      );
    }
    log.info('webhook.pi_session.login_prompt.sent', {
      userId: identity.userId,
      companyId: identity.companyId,
      rendered: card.ok ? 'card' : 'text',
      correlationId,
    });
    return;
  }

  const routing = buildLarkRoutingKeys({
    companyId: String(identity.companyId),
    userId: String(identity.userId),
    incoming,
  });
  log = log.child({
    companyId: identity.companyId,
    requesterUserId: identity.userId,
    departmentId: identity.activeDepartmentId ?? null,
    roomKey: routing.roomKey,
    laneKey: routing.executionLaneKey,
    deliveryTargetKey: routing.deliveryTargetKey,
    routingMode: 'active',
  });
  log.info('webhook.execution.correlated');
  if (deps.prisma && (incoming.chatType !== 'group' || shouldRespond)) {
    try {
      const conversationKey = runtimeThreadIdFor(incoming);
      await deps.prisma.runtimeConversation.upsert({
        where: {
          companyId_channel_channelConversationKey: {
            companyId: identity.companyId,
            channel: 'lark',
            channelConversationKey: conversationKey,
          },
        },
        create: {
          companyId: identity.companyId,
          channel: 'lark',
          channelConversationKey: conversationKey,
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
    replyToMessageId: String(incoming.messageId),
    replyInThread:
      incoming.chatType === 'group'
      && incoming.groupReplyMode !== 'inline',
    ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
    ...(identity.email ? { requesterEmail: identity.email } : {}),
  };

  const conversation = conversationForIncoming(incoming);

  const messageAttachments = parseLarkAttachments(rawEvent);
  const voiceAttachment = messageAttachments.find(
    (attachment): attachment is LarkAudioAttachment => attachment.type === 'audio',
  );
  const attachments = messageAttachments.filter(
    (attachment): attachment is LarkAttachment => attachment.type !== 'audio',
  );
  if (voiceAttachment) {
    if (incoming.chatType !== 'p2p') {
      log.debug('webhook.voice.group_ignored');
      return;
    }

    const transcript = await transcribeLarkVoiceNote({
      attachment: voiceAttachment,
      incoming,
      deps,
      log,
      ...(signal ? { signal } : {}),
    });
    if (!transcript) return;

    const voiceIncoming = withLarkSenderName(
      appendLarkMentionContext({
        ...incoming,
        text: transcript,
        attachments: [
          ...incoming.attachments,
          {
            type: 'audio',
            fileKey: voiceAttachment.key,
            mimeType: voiceAttachment.mimeType,
            name: voiceAttachment.fileName,
          },
        ],
      }),
      identity,
    );
    await runPiAndDeliver({
      incoming: voiceIncoming,
      runContext,
      conversation,
      deps,
      log,
      ...(signal ? { signal } : {}),
    });
    return;
  }

  let parentRef = explicitlyAddressed && incoming.replyToMessageId
    ? await (deps.fetchParentMessage ?? fetchParentMessage)({
        parentMessageId: String(incoming.replyToMessageId),
        env: deps.env,
        logger: log,
        channelIdentityRepo: deps.channelIdentityRepo,
        companyId: identity.companyId,
        chatId: String(incoming.chatId),
        tenantKey,
        includeContent: explicitlyAddressed,
      })
    : null;
  if (explicitlyAddressed && parentRef?.status === 'available' && parentRef.audioAttachment) {
    const transcript = await transcribeLarkVoiceNote({
      attachment: {
        type: 'audio',
        source: parentRef.audioAttachment.source,
        key: parentRef.audioAttachment.fileKey,
        fileName: parentRef.audioAttachment.fileName,
        mimeType: parentRef.audioAttachment.mimeType,
        messageId: parentRef.messageId,
        durationMs: parentRef.audioAttachment.durationMs,
      },
      incoming,
      deps,
      log,
      ...(signal ? { signal } : {}),
    });
    if (!transcript) return;
    parentRef = { ...parentRef, text: `Voice note transcript: ${transcript}` };
  }

  // Divo is in the room but was not addressed. Preparing an attachment is not a
  // read — it pulls the image out of Lark and sends it to an OCR provider. That
  // only happens on an explicit opt-in, and the decision must be made *before*
  // the work, not after.
  const untagged = isUntaggedGroupMessage(incoming) && !continuesDivoThread;
  // Only an untagged message consults the policy, so only an untagged message
  // pays for the lookup. Resolved here rather than inside the branch below
  // because the decision has to precede the work, not filter its output.
  const untaggedPolicy = untagged
    ? await loadUntaggedGroupPolicy(identity.companyId, deps, log)
    : null;
  const effectivePolicy = untaggedPolicy ?? { processAttachments: false };
  const mayProcessAttachments = mayPrepareAttachments({
    attachmentCount: attachments.length,
    documentCount: attachments.filter(att => att.type === 'file').length,
    untagged,
    policy: effectivePolicy,
  });

  const preparedAttachments = mayProcessAttachments
    ? await prepareLarkAttachmentContexts({
        incoming,
        identity,
        attachments,
        log,
      })
    : [];

  if (untagged) {
    // Logged as the policy actually applied, not as the policy configured, so a
    // company can see from its own traffic what Divo kept and what it skipped.
    log.debug('webhook.group_message.not_mentioned', {
      chatId: incoming.chatId,
      messageId: incoming.messageId,
      attachmentCount: attachments.length,
      attachmentsProcessed: mayProcessAttachments,
      textRetained: true,
    });

    await storeGroupIncomingSnapshot({
      incoming,
      identity,
      deps,
      attachmentContexts: preparedAttachments.map(item => item.context),
      log,
    });

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

    const { LarkFileClient: RuntimeFileClient } = await import('./clients/lark-file.client');
    const runtimeFileClient = new RuntimeFileClient(deps.env, log);
    const runtimeAttachments: LarkPiRuntimeAttachment[] = attachments
      .filter(isSupportedLarkMedia)
      .map(attachment => ({
        kind: attachment.type,
        name: attachment.fileName,
        mimeType: attachment.mimeType,
        openStream: () => attachment.type === 'image'
          ? runtimeFileClient.openImage(attachment.messageId, attachment.key)
          : runtimeFileClient.openFile(attachment.messageId, attachment.key),
      }));

    // An attachment with no question attached to it yet. Stage the bytes into
    // the sender's signed private workspace, record the filename, and say
    // nothing until the user explains what they want.
    if (isAwaitingItsQuestion({
      chatType: incoming.chatType,
      text: incoming.text,
      supportedAttachmentCount: attachments.filter(isSupportedLarkMedia).length,
      unsupportedAttachmentCount: attachments.filter(a => !isSupportedLarkMedia(a)).length,
    })) {
      if (!deps.piRuntime.stagePendingAttachments) {
        throw new Error('The Divo runtime cannot safely retain a pending attachment.');
      }
      await deps.piRuntime.stagePendingAttachments({
        incoming: withLarkSenderName(incoming, identity),
        runContext,
        conversation,
        threadId: runtimeThreadIdFor(incoming),
        attachments: runtimeAttachments,
        ...(signal ? { abortSignal: signal } : {}),
      });
      // Only the filenames, plus any refusal notice. The bytes are not read
      // into Postgres; the signed controller already placed them in the
      // private workspace for the next message.
      const seen = preparedAttachments
        .map(item => item.context.inlineContext ?? `[Attached: ${item.context.fileName}]`)
        .join('\n\n');
      if (seen) {
        await deps.conversationRepo.appendTurn(
          conversationKeyForMessage({
            chatId: String(incoming.chatId),
            chatType: incoming.chatType,
            messageId: String(incoming.messageId),
            ...(incoming.threadId ? { threadId: String(incoming.threadId) } : {}),
            ...(incoming.rootMessageId ? { rootMessageId: String(incoming.rootMessageId) } : {}),
            userExternalId: incoming.userExternalId,
            ...(incoming.groupReplyMode ? { groupReplyMode: incoming.groupReplyMode } : {}),
          }) as never,
          {
            role: 'user',
            content: userHistoryContent(withLarkSenderName(incoming, identity), seen),
            timestamp: incoming.timestamp,
          },
          { companyId: identity.companyId, channel: 'lark' },
        ).catch(e => log.warn('webhook.attachment.await_question.persist_failed', {
          error: String(e),
        }));
      }
      // Divo is about to say nothing at all, so this reaction is the only
      // signal the file arrived. Without it the user is left watching an
      // upload that looks ignored, and sends it again.
      try {
        await deps.adapter.reactToIncoming(incoming.messageId, '📥');
      } catch { /* acknowledgement is best-effort */ }

      log.info('webhook.attachment.awaiting_question', {
        chatId: incoming.chatId,
        messageId: incoming.messageId,
        attachmentCount: attachments.length,
        recorded: Boolean(seen),
      });
      return;
    }

    const userText     = incoming.text?.trim() ?? '';
    const parentPrefix = parentRef ? buildParentContextPrefix(parentRef) : '';
    const textWithParent = parentPrefix
      ? (userText ? `${parentPrefix}\n\n${userText}` : parentPrefix)
      : userText;

    // The only thing an attachment contributes to the prompt is a refusal.
    // Supported files reach the agent as real paths in its workspace, so
    // describing them here would just be a worse copy of what it can open.
    const contextBlock = preparedAttachments
      .map(item => item.context.inlineContext)
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
    });
    const replyText = await runPiAndDeliver({
      incoming: withLarkSenderName(enrichedIncoming, identity),
      runContext,
      conversation,
      deps,
      log,
      ...(runtimeAttachments.length > 0 ? { attachments: runtimeAttachments } : {}),
      ...(signal ? { signal } : {}),
    });

    await storeGroupAssistantSnapshot({ incoming, identity, deps, replyText, log });
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
    });
    return;
  }

  // Bare @Divo mention with no text — synthesize a contextual prompt so
  // the engine can respond to whatever was said above in the group chat.
  const bareMention = !text && incoming.mentionsSelf && incoming.chatType === 'group';
  let referenceContext: string | undefined;
  if (bareMention && incoming.threadId) {
    try {
      const currentTime = Date.parse(incoming.timestamp);
      const preceding = (await deps.adapter.listThreadMessages(incoming.threadId, 12))
        .filter(message => {
          if (message.messageId === String(incoming.messageId)) return false;
          const messageTime = Number(message.timestamp);
          return !Number.isFinite(currentTime)
            || !Number.isFinite(messageTime)
            || messageTime <= currentTime;
        })
        .filter(message => message.text.trim())
        .slice(0, 6)
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
      if (preceding.length > 0) {
        referenceContext = [
          'CURRENT LARK THREAD — adjacent messages immediately preceding the current bare mention:',
          ...preceding.map(message => {
            const sender = deps.adapter.isBotOpenId(message.senderId)
              ? 'Divo'
              : message.senderName?.trim() || 'A colleague';
            return `[${message.timestamp}] ${sender}: ${message.text.slice(0, 2_000)}`;
          }),
        ].join('\n');
      }
    } catch (error) {
      log.warn('webhook.thread_context.fetch_failed', {
        chatId: incoming.chatId,
        messageId: incoming.messageId,
        threadId: incoming.threadId,
        error: String(error),
      });
    }
  }

  let effectiveIncoming: IncomingMessage = bareMention
    ? parentRef?.status === 'available'
      ? {
          ...incoming,
          text: 'Respond to the referenced Lark message.',
        }
      : {
          ...incoming,
          text: 'Use the supplied adjacent Lark context to respond to the latest substantive user message.',
          requiresAdjacentContext: true,
          ...(referenceContext ? { referenceContext } : {}),
        }
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
      ...(parentRef.audioAttachment
        ? {
            attachments: [
              ...effectiveIncoming.attachments,
              {
                type: 'audio' as const,
                fileKey: parentRef.audioAttachment.fileKey,
                mimeType: parentRef.audioAttachment.mimeType,
                name: parentRef.audioAttachment.fileName,
              },
            ],
          }
        : {}),
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

  // ── Normal message → isolated Pi runtime ──────────────────────────────────
  // A quoted picture is staged into the workspace exactly like an attached one.
  // It used to be downloaded, encoded, and then dropped: nothing downstream ever
  // read `imageUrls`, so quote-replying an image asked Divo about something it
  // could not see, and it answered from the surrounding text.
  const quotedImages = quotedImageAttachments(parentRef?.imageUrls, log);
  const replyText = await runPiAndDeliver({
    incoming: withLarkSenderName(effectiveIncoming, identity),
    runContext,
    conversation,
    deps,
    log,
    ...(quotedImages.length > 0 ? { attachments: quotedImages } : {}),
    ...(signal ? { signal } : {}),
  });

  await storeGroupAssistantSnapshot({ incoming, identity, deps, replyText, log });
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
): Promise<(LarkAuthenticatedCardActor & { activeDepartmentId?: string }) | null> {
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
    ...(resolved.value.activeDepartmentId
      ? { activeDepartmentId: resolved.value.activeDepartmentId }
      : {}),
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

/**
 * Stopping a run is a command, not a button.
 *
 * `/q` is the one Divo advertises — it is two keystrokes in the box the user is
 * already typing in, and it reaches a run whose status card has long since
 * scrolled away. `/stop` is kept only because it is what people already know;
 * both spellings enter the same handler, so there is one implementation.
 *
 * This is checked before the execution lane on purpose: a stop that queued
 * behind the turn it is trying to stop would arrive after that turn finished.
 */
const STOP_COMMANDS: ReadonlySet<string> = new Set(['/q', '/stop']);

const isStopCommand = (text: string | undefined): boolean =>
  STOP_COMMANDS.has((text ?? '').trim().toLowerCase());

async function handleStopBeforeLane(
  incoming: IncomingMessage,
  deps: Pick<LarkWebhookDeps, 'adapter' | 'channelIdentityRepo'>,
  log: Logger,
): Promise<void> {
  const tenantKey = incoming.tenantKey;
  const identity = tenantKey
    ? await deps.channelIdentityRepo.resolveByLarkTenantIdentity(
      incoming.userExternalId,
      tenantKey,
    )
    : null;
  if (!identity?.ok || !identity.value) {
    await deps.adapter.sendToChatId(
      String(incoming.chatId),
      'I could not verify who is trying to stop this run.',
      String(incoming.messageId),
      undefined,
      incoming.chatType === 'group'
        ? incoming.groupReplyMode !== 'inline'
        : undefined,
    );
    return;
  }

  const result = deps.adapter.interruptConversation(
    conversationKeyForMessage(incoming),
    {
      userId: identity.value.userId,
      companyId: identity.value.companyId,
      aiRole: identity.value.aiRole,
    },
  );
  const text = result === 'aborted'
    ? 'Stop requested for this conversation.'
    : result === 'forbidden'
      ? 'You are not authorized to stop this run.'
      : 'There is no active run in this conversation.';
  const sent = await deps.adapter.sendToChatId(
    String(incoming.chatId),
    text,
    String(incoming.messageId),
    undefined,
    incoming.chatType === 'group'
      ? incoming.groupReplyMode !== 'inline'
      : undefined,
  );
  if (!sent.ok) {
    log.warn('webhook.command.stop.reply_failed', { error: sent.error.message });
  }
}

async function handleSlashCommand(args: {
  text: string;
  incoming: IncomingMessage;
  chatType?: string;
  conversation: ConversationHandle;
  identity: {
    companyId: string;
    userId: string;
    aiRole: string;
    activeDepartmentId?: string | null;
    displayName?: string;
    email?: string;
  };
  deps: {
    adapter: LarkChannelAdapter;
    channelIdentityRepo: ChannelIdentityRepoPort;
    conversationRepo: ConversationRepoPort;
    logger: Logger;
    larkOAuthService?: LarkOAuthService;
    connectionRepo?: IntegrationConnectionRepository;
    appBaseUrl: string;
    cache: CachePort;
    chatContextService?: LarkChatContextService;
    groupContextHydrator?: Pick<GroupContextHydrator, 'hydrate'>;
    prisma?: PrismaClient;
  };
  log: Logger;
  correlationId: ReturnType<typeof asCorrelationId>;
}): Promise<void> {
  const { text, incoming, conversation, identity, deps, log, correlationId } = args;
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

  if (cmd === '/group-mode' || cmd === '/group-settings') {
    const isAdmin = identity.aiRole === 'COMPANY_ADMIN'
      || identity.aiRole === 'SUPER_ADMIN';
    if (incoming.chatType !== 'group') {
      await reply('Group reply settings are only available inside a group chat.');
      return;
    }
    if (!isAdmin) {
      await reply('Only a company admin can change group reply settings.');
      return;
    }
    if (!deps.prisma || !incoming.tenantKey) {
      await reply('Group reply settings are not available on this server.');
      return;
    }

    const address = {
      companyId: identity.companyId,
      tenantKey: incoming.tenantKey,
      ...(incoming.appId ? { appId: incoming.appId } : {}),
      chatId: String(incoming.chatId),
    };
    const requested = text.slice(cmd.length).trim().toLowerCase();
    if (requested && requested !== 'status' && requested !== 'threaded' && requested !== 'inline') {
      await reply('Usage: `/group-mode status`. Divo always replies in threads inside groups.');
      return;
    }

    const mode = await loadLarkGroupMode(deps.prisma, address);
    if (requested === 'inline') {
      await reply('Divo always replies in threads inside groups. Inline mode is no longer available.');
      return;
    }

    if (cmd === '/group-settings' || !requested || requested === 'status') {
      const sent = await deps.adapter.sendCardToChat(
        String(incoming.chatId),
        buildLarkGroupSettingsCard(mode),
        String(incoming.messageId),
        incoming.groupReplyMode !== 'inline',
      );
      if (!sent.ok) {
        log.warn('webhook.command.group_settings.card_failed', {
          error: sent.error.message,
          correlationId,
        });
        await reply(`Current group reply mode: **${mode}**.`);
      }
      return;
    }

    await reply('Divo already uses threads for every group request.');
    return;
  }

  if (cmd === '/clear') {
    const normalized = text.trim().toLowerCase();
    const isRoomClear = normalized === '/clear room'
      || normalized === '/clear room confirm';
    const isAdmin = identity.aiRole === 'COMPANY_ADMIN'
      || identity.aiRole === 'SUPER_ADMIN';

    if (isRoomClear && incoming.chatType !== 'group') {
      await reply('`/clear room` is only available inside a group chat.');
      return;
    }
    if (isRoomClear && !isAdmin) {
      await reply('Only a company admin can clear every Divo conversation in this group.');
      return;
    }
    if (normalized === '/clear room') {
      await reply(
        'This clears Divo history for every thread in this group. '
        + 'To confirm, send `/clear room confirm`.',
      );
      return;
    }
    if (
      incoming.chatType === 'group'
      && incoming.groupReplyMode !== 'inline'
      && !incoming.rootMessageId
      && !incoming.threadId
      && !isRoomClear
    ) {
      await reply('Run `/clear` inside the thread you want to reset.');
      return;
    }

    const scope = { companyId: identity.companyId, channel: 'lark' as const };
    const conversationKey = conversationKeyForMessage(incoming);
    const clearResult = normalized === '/clear room confirm'
      ? await deps.conversationRepo.clearChatHistories(String(incoming.chatId), scope)
      : await deps.conversationRepo.clearHistory(conversationKey, scope);
    if (!clearResult.ok) {
      log.warn('webhook.command.clear.failed', {
        chatId:        incoming.chatId,
        correlationId,
        error:         clearResult.error.message,
      });
      await reply('Could not clear history — please try again.');
      return;
    }
    if (normalized === '/clear room confirm' && deps.chatContextService) {
      await deps.chatContextService.clear(identity.companyId, String(incoming.chatId));
    }
    log.info('webhook.command.clear.ok', {
      chatId: incoming.chatId,
      clearTarget: normalized === '/clear room confirm' ? 'room' : conversationKey,
      cleared: clearResult.value,
      correlationId,
    });
    await reply(
      normalized === '/clear room confirm'
        ? 'Done. Divo history for this group and all its threads is cleared.'
        : 'Done. This conversation is cleared — I\'ll start fresh from here.',
    );
    return;
  }

  // ── /login — hand them the web sign-in ─────────────────────────────────────
  //
  // No longer gated on Lark OAuth being configured: signing in happens in the
  // web app now, and Lark OAuth is a separate, later thing you do only if you
  // want Divo acting under your own name.
  if (cmd === '/login') {
    const url = await createLarkLoginUrl({
      companyId:  identity.companyId,
      userId:     identity.userId,
      larkOpenId: incoming.userExternalId,
      tenantKey:  String(incoming.tenantKey),
      deps,
    });

    if (!url) {
      await reply('Could not start sign-in just now. Please try again in a moment.');
      return;
    }

    log.info('webhook.command.login.initiated', { userId: identity.userId, correlationId });
    const name = identity.displayName ?? identity.email ?? 'there';
    const card = await deps.adapter.sendCardToChat(
      String(incoming.chatId),
      buildSignInCard({ name, url }),
      incoming.chatType === 'group' ? String(incoming.messageId) : undefined,
      incoming.chatType === 'group'
        ? incoming.groupReplyMode !== 'inline'
        : undefined,
    );
    if (!card.ok) {
      log.warn('webhook.command.login.card_failed', {
        error: card.error.message,
        correlationId,
      });
      await reply(signInFallbackText({ name, url }));
    }
    return;
  }

  // ── /logout — revoke stored user token ──────────────────────────────────────
  if (cmd === '/logout') {
    if (!deps.connectionRepo) {
      await reply('User OAuth is not configured on this server.');
      return;
    }
    const result = await deps.connectionRepo.revokeLarkConnectionsForUser(identity.companyId, identity.userId);
    if (!result.ok) {
      log.warn('webhook.command.logout.failed', {
        userId: identity.userId,
        error: result.error.message,
        correlationId,
      });
      await reply('Could not disconnect your Lark account. Please try again.');
      return;
    }
    await deps.channelIdentityRepo.invalidateIdentityCache?.(incoming.userExternalId);
    if (result.value > 0) {
      log.info('webhook.command.logout.ok', { userId: identity.userId, correlationId });
      await reply('Disconnected. Your personal Lark sign-in has been removed. Send me another message whenever you want to reconnect.');
    } else {
      await reply('No connected account found. Send me another message to connect.');
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
      '`/clear` — Reset this DM, thread, or inline session.\n' +
      '`/clear room` — Admin-only two-step reset for every thread in this group.\n' +
      '`/q` — Stop the active run in this conversation.\n' +
      '`/group-settings` — Admin-only group reply settings.\n' +
      '`/group-mode status` — Confirm that group replies stay in threads.\n' +
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
      '• @mention Divo to start a group request; replies inside its thread continue naturally.\n' +
      '• Upload a file and ask Divo to analyze it — PDFs, CSVs, and docs are all supported.',
    );
    return;
  }

  // Unknown command — let the engine handle it as a regular message
  log.info('webhook.command.unknown_routed_to_engine', { cmd, correlationId });
}

const MAX_LARK_VOICE_BYTES = 25 * 1_024 * 1_024;
const MAX_LARK_VOICE_DURATION_MS = 10 * 60_000;
const MAX_LARK_VOICE_TRANSCRIPT_CHARS = 50_000;
const LARK_VOICE_CACHE_TTL_SECONDS = 7 * 60 * 60;

async function transcribeLarkVoiceNote(input: {
  attachment: LarkAudioAttachment;
  incoming: IncomingMessage;
  deps: Pick<
    LarkWebhookDeps,
    'adapter' | 'cache' | 'voiceFileClient' | 'voiceTranscriber'
  >;
  log: Logger;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { attachment, incoming, deps, log } = input;
  const notify = async (text: string): Promise<void> => {
    const sent = await deps.adapter.sendToChatId(
      String(incoming.chatId),
      text,
      String(incoming.messageId),
    );
    if (!sent.ok) log.warn('webhook.voice.notice_failed', { error: sent.error.message });
  };

  if (attachment.source === 'voice-note' && attachment.durationMs === null) {
    log.info('webhook.voice.duration_missing');
    await notify(
      'I could not verify the length of that voice note. Please send it again or type your request.',
    );
    return null;
  }
  if (attachment.durationMs !== null && attachment.durationMs > MAX_LARK_VOICE_DURATION_MS) {
    log.info('webhook.voice.duration_rejected', { durationMs: attachment.durationMs });
    await notify('That voice note is longer than the 10-minute limit. Please send a shorter one.');
    return null;
  }

  const cacheKey =
    `lark:voice-transcript:${incoming.tenantKey ?? 'unknown'}:${attachment.messageId}`;
  const cached = await deps.cache.get<string>(cacheKey);
  if (cached.ok && cached.value?.trim()) {
    log.info('webhook.voice.cache_hit');
    return cached.value.trim();
  }
  if (!cached.ok) {
    log.warn('webhook.voice.cache_read_failed', { error: cached.error.message });
    await notify('Voice transcription is temporarily unavailable. Please try again later.');
    return null;
  }

  if (!deps.voiceFileClient || !deps.voiceTranscriber) {
    log.warn('webhook.voice.not_configured');
    await notify('Voice transcription is not available right now. Please type your request.');
    return null;
  }

  try {
    await deps.adapter.reactToIncoming(incoming.messageId, '📥');
  } catch { /* acknowledgement is best-effort */ }

  try {
    const audio = await deps.voiceFileClient.downloadFile(
      attachment.messageId,
      attachment.key,
      MAX_LARK_VOICE_BYTES,
    );
    if (audio.length === 0) throw new Error('Lark returned an empty voice resource');
    if (audio.length > MAX_LARK_VOICE_BYTES) {
      throw new Error(`Lark voice resource exceeds ${MAX_LARK_VOICE_BYTES} bytes`);
    }

    const result = await deps.voiceTranscriber.transcribe({
      audio,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });
    const transcript = result.text.trim();
    if (!transcript) throw new Error('ElevenLabs returned an empty transcript');
    if (transcript.length > MAX_LARK_VOICE_TRANSCRIPT_CHARS) {
      log.warn('webhook.voice.transcript_too_long', { transcriptLength: transcript.length });
      await notify('That voice note produced too much text to process. Please send a shorter one.');
      return null;
    }

    const stored = await deps.cache.set(
      cacheKey,
      transcript,
      LARK_VOICE_CACHE_TTL_SECONDS,
    );
    if (!stored.ok) {
      log.warn('webhook.voice.cache_write_failed', { error: stored.error.message });
      await notify('Voice transcription is temporarily unavailable. Please try again later.');
      return null;
    }
    log.info('webhook.voice.transcribed', {
      bytes: audio.length,
      durationMs: attachment.durationMs,
      provider: 'elevenlabs',
      model: 'scribe_v2',
      languageCode: result.languageCode ?? null,
    });
    return transcript;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn('webhook.voice.transcription_failed', { error: reason.slice(0, 200) });
    const tooLarge = /exceeds|download limit/i.test(reason);
    await notify(tooLarge
      ? 'That voice note is larger than the 25 MB limit. Please send a shorter one.'
      : 'I could not transcribe that voice note. Please send it again or type your request.');
    return null;
  }
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

const withLarkSenderName = (
  incoming: IncomingMessage,
  identity: LarkResolvedIdentity,
): IncomingMessage => ({
  ...incoming,
  senderName: identity.displayName || identity.email || identity.userId,
});

type PreparedAttachmentContext = {
  attachment: LarkAttachment;
  context: GroupChatAttachmentContext;
};

/**
 * Describe each attachment for the transcript. Nothing is downloaded here.
 *
 * The bytes travel exactly once, streamed straight into the sender's own
 * container workspace, and the agent reads them from there. Extracting an
 * excerpt in the backend as well would mean downloading the same file twice to
 * produce a capped, lossy second copy of something the agent can already open
 * in full — and it would have to guess what mattered before the question was
 * even asked.
 */
async function prepareLarkAttachmentContexts(input: {
  incoming: IncomingMessage;
  identity: LarkResolvedIdentity;
  attachments: readonly LarkAttachment[];
  log: Logger;
}): Promise<PreparedAttachmentContext[]> {
  const { attachments, log } = input;

  return attachments.map((att) => {
    // A format with no handler is refused before anything happens to it. The
    // refusal travels as prompt context so Divo says it in its own voice
    // rather than as a card bolted onto an otherwise confident answer.
    if (!isSupportedLarkMedia(att)) {
      log.info('webhook.attachment.unsupported', {
        fileName: att.fileName,
        mimeType: att.mimeType,
        kind: att.type,
      });
      return {
        attachment: att,
        context: {
          kind: att.type,
          fileName: att.fileName,
          mimeType: att.mimeType,
          larkFileKey: att.key,
          larkMessageId: att.messageId,
          ingestionStatus: 'unsupported' as const,
          inlineContext: unsupportedDocumentNotice(att.fileName),
          isInlineComplete: false,
        },
      };
    }

    return {
      attachment: att,
      context: {
        kind: att.type,
        fileName: att.fileName,
        mimeType: att.mimeType,
        larkFileKey: att.key,
        larkMessageId: att.messageId,
        ingestionStatus: 'workspace' as const,
      },
    };
  });
}


/**
 * Resolve the untagged-group policy for one company, per turn.
 *
 * Deliberately uncached. This is a privacy control: an admin who turns
 * attachment processing off expects the next message to obey, not the first
 * message after a TTL expires. One indexed row on a path that already does
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
        controlKey: UNTAGGED_ATTACHMENTS_CONTROL,
      },
      select: { controlKey: true, value: true },
    });
    return resolveCompanyUntaggedGroupPolicy({ env: deps.env, controls });
  } catch (error) {
    log.warn('webhook.untagged_policy.lookup_failed', { companyId, error: String(error) });
    return resolveCompanyUntaggedGroupPolicy({ env: deps.env, controls: [] });
  }
}

async function storeUnknownGroupIncomingSnapshot(input: {
  incoming: IncomingMessage;
  companyId: string;
  deps: { chatContextService?: LarkChatContextService };
  log: Logger;
}): Promise<void> {
  const { incoming, companyId, deps, log } = input;
  const content = incoming.text?.trim();
  if (incoming.chatType !== 'group' || !deps.chatContextService || !content) return;

  await deps.chatContextService.appendMessage({
    companyId,
    chatId: String(incoming.chatId),
    chatType: 'group',
    messageId: String(incoming.messageId),
    senderOpenId: incoming.userExternalId,
    senderName: incoming.userExternalId,
    role: 'user',
    content,
    createdAt: incoming.timestamp,
    botMentioned: false,
  }).catch(e => log.warn('webhook.group_context.store_failed', { error: String(e) }));
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
  const attachmentContexts = input.attachmentContexts;

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
  replyText: string | null;
  log: Logger;
}): Promise<void> {
  const { incoming, identity, deps, replyText, log } = input;
  if (incoming.chatType !== 'group' || !deps.chatContextService || !replyText) return;

  await deps.chatContextService.appendMessage({
    companyId: identity.companyId,
    chatId: String(incoming.chatId),
    chatType: 'group',
    senderOpenId: 'divo-bot',
    senderName: 'Divo',
    role: 'assistant',
    content: replyText,
    botMentioned: false,
  }).catch(e => log.warn('webhook.group_context.store_reply_failed', { error: String(e) }));
}
