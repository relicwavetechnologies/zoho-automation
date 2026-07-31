import type { ChannelAdapter, ConversationHandle, StatusHandle, ReplyHandle } from '../../../application/channels/channel.adapter';
import type { Result } from '../../../shared/result';
import { ok, err } from '../../../shared/result';
import { ChannelError } from '../../../shared/errors';
import type { IncomingMessage, MentionRef } from '../../../domain/channel/incoming-message';
import type { StatusUpdate, FinalReply } from '../../../domain/channel/outbound';
import type { MessageId } from '../../../shared/ids';
import { asMessageId, asChatId, asCorrelationId } from '../../../shared/ids';
import type { Logger } from '../../../shared/logger';
import type { TypedEnv } from '../../../config/env';
import { LarkMessagingClient } from './clients/lark-messaging.client';
import { LarkApiError } from './clients/lark-http.client';
import type { ChannelDeliveryRepoPort } from '../../persistence/channel-delivery.repository';
import { buildDeliveryKey, toProviderIdempotencyKey } from '../../../domain/channel/delivery-key';
import { classifyDeliveryFailure } from './lark-delivery-policy';
import { createHash } from 'node:crypto';
import {
  LarkStatusCoordinator,
  LarkStatusDrainTimeoutError,
} from './lark-status.coordinator';
import { buildFinalCard, planFinalCards } from './lark-card.builder';
import { buildLarkFinalDeliveryEnvelope } from './lark-final-delivery';

interface LarkRunIdentity {
  readonly userId: string;
  readonly companyId: string;
}

interface LarkRunOwner extends LarkRunIdentity {
  readonly conversationKey: string;
}

export interface LarkInterruptActor extends LarkRunIdentity {
  readonly aiRole: string;
}

export type LarkInterruptResult = 'aborted' | 'not_found' | 'forbidden';

export class LarkChannelAdapter implements ChannelAdapter {
  readonly key = 'lark' as const;

  private readonly messagingClient: LarkMessagingClient;
  private readonly logger: Logger;
  private readonly deliveryRepo: ChannelDeliveryRepoPort | undefined;
  private readonly botName: string;
  private botOpenId: string;
  // One coordinator per in-flight run, keyed by correlationId.
  // Manages single-bubble status updates with rate-limiting and dedup.
  private readonly coordinators = new Map<string, LarkStatusCoordinator>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly runOwners = new Map<string, LarkRunOwner>();

  constructor(deps: {
    env: TypedEnv;
    logger: Logger;
    botOpenId?: string;
    /**
     * Optional so every existing construction site keeps working; absent means
     * delivery falls back to the pre-Wave-5 behaviour of sending without a
     * duplicate guard.
     */
    deliveryRepo?: ChannelDeliveryRepoPort;
  }) {
    this.deliveryRepo = deps.deliveryRepo;
    this.logger = deps.logger.child({ channel: 'lark' });
    this.botName = deps.env.LARK_BOT_NAME;
    this.botOpenId = deps.botOpenId ?? '';
    this.messagingClient = new LarkMessagingClient({
      appId: deps.env.LARK_APP_ID,
      appSecret: deps.env.LARK_APP_SECRET,
      apiBaseUrl: deps.env.LARK_API_BASE_URL,
      logger: this.logger,
    });
  }

  async initialize(): Promise<void> {
    if (this.botOpenId) return;
    try {
      const identity = await this.messagingClient.getBotIdentity();
      this.botOpenId = identity.openId;
      this.logger.info('lark.adapter.bot_identity.ready', {
        botOpenId: identity.openId,
        botName: identity.name ?? this.botName,
      });
    } catch (error) {
      this.logger.error('lark.adapter.bot_identity.failed', {
        error: error instanceof Error ? error.message : String(error),
        consequence: 'group_mentions_disabled',
      });
    }
  }

  isBotOpenId(openId: string | undefined): boolean {
    return Boolean(openId && this.botOpenId && openId === this.botOpenId);
  }

  async listThreadMessages(threadId: string, limit?: number) {
    return this.messagingClient.listThreadMessages(threadId, limit);
  }

  // ── parseIncoming ────────────────────────────────────────────────────

  parseIncoming(raw: unknown): Result<IncomingMessage, ChannelError> {
    try {
      const event = raw as Record<string, unknown>;

      const header = event['header'] as Record<string, unknown> | undefined;
      const eventType = header?.['event_type'] as string | undefined;
      const tenantKey = header?.['tenant_key'] as string | undefined;
      const appId = header?.['app_id'] as string | undefined;

      if (eventType !== 'im.message.receive_v1') {
        return err(new ChannelError({
          channel: 'lark',
          stage: 'parse_incoming',
          reason: 'not_supported',
          message: `Unsupported event type: ${eventType}`,
        }));
      }

      const eventData = event['event'] as Record<string, unknown>;
      const message  = eventData['message'] as Record<string, unknown>;
      const sender   = eventData['sender']  as Record<string, unknown>;

      const chatId      = message['chat_id']      as string;
      const chatType    = message['chat_type']     as string;
      const messageId   = message['message_id']   as string;
      const messageType = (message['message_type'] as string | undefined) ?? 'text';
      const senderTypeRaw = sender['sender_type'];
      const senderType = senderTypeRaw === 'user' || senderTypeRaw === 'bot' || senderTypeRaw === 'app'
        ? senderTypeRaw
        : 'unknown';
      const senderId    = sender['sender_id'] as Record<string, unknown>;
      const larkOpenId  = senderId['open_id'] as string;
      const senderUserId = senderId['user_id'] as string | undefined;
      const senderUnionId = senderId['union_id'] as string | undefined;
      const createTime  = message['create_time']  as string;
      const parentId    = message['parent_id']    as string | undefined;
      const rootId      = message['root_id']      as string | undefined;
      const threadId    = message['thread_id']    as string | undefined;

      // ── Resolve mentions from the envelope ─────────────────────────────
      // Lark sends a `mentions` array alongside the message content.
      // Each entry maps a placeholder key like "@_user_1" to the real user.
      const rawMentions = (message['mentions'] as unknown[] | undefined) ?? [];
      const mentions: MentionRef[] = rawMentions.map((m) => {
        const entry  = m as Record<string, unknown>;
        const key    = (entry['key']  as string | undefined) ?? '';
        const name   = (entry['name'] as string | undefined) ?? '';
        const idObj  = (entry['id']   as Record<string, unknown> | undefined) ?? {};
        const openId = (idObj['open_id'] as string | undefined) ?? '';
        const userId  = idObj['user_id'] as string | undefined;
        const unionId = idObj['union_id'] as string | undefined;
        const isSelf = Boolean(this.botOpenId && openId === this.botOpenId);
        return {
          key,
          openId,
          ...(userId ? { userId } : {}),
          ...(unionId ? { unionId } : {}),
          name,
          isSelf,
        };
      });

      // Lookup map: "@_user_1" → MentionRef
      const mentionByKey = new Map<string, MentionRef>(mentions.map(m => [m.key, m]));
      let mentionsSelf = mentions.some(m => m.isSelf) || chatType === 'p2p';

      // ── Extract and clean text by message type ─────────────────────────
      const contentRaw = message['content'] as string | undefined;
      let text = '';

      if (contentRaw) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(contentRaw) as Record<string, unknown>;
        } catch {
          text = contentRaw;
          parsed = {};
        }

        if (messageType === 'post') {
          // Rich text ("post"): content.content is a 2D array of inline blocks.
          // Each block has a `tag`: "text" | "at" | "img" | "a" | "emotion"
          const post = extractPostText(parsed, this.botOpenId);
          text = post.text;
          mentionsSelf ||= post.mentionsSelf;
        } else {
          // Plain "text" message: content.text holds the raw string with @_user_X keys.
          const raw = (parsed['text'] as string | undefined) ?? '';
          text = resolveMentionKeys(raw, mentionByKey);
        }
      }

      const traceId = asCorrelationId(`${messageId}-${createTime}`);

      return ok({
        channel: 'lark',
        messageId: asMessageId(messageId),
        chatId: asChatId(chatId),
        chatType: chatType === 'p2p' ? 'p2p' : 'group',
        ...(tenantKey ? { tenantKey } : {}),
        ...(appId ? { appId } : {}),
        userExternalId: larkOpenId,
        ...(senderUserId ? { senderUserId } : {}),
        ...(senderUnionId ? { senderUnionId } : {}),
        senderType,
        text: text.trim(),
        attachments: [],
        timestamp: new Date(Number(createTime)).toISOString(),
        ...(parentId
          ? {
              parentMessageId: asMessageId(parentId),
              replyToMessageId: asMessageId(parentId),
            }
          : {}),
        ...(rootId ? { rootMessageId: asMessageId(rootId) } : {}),
        ...(threadId ? { threadId } : {}),
        traceId,
        mentions,
        mentionsSelf,
        raw,
      });
    } catch (e) {
      return err(new ChannelError({
        channel: 'lark',
        stage: 'parse_incoming',
        reason: 'malformed',
        cause: e,
        message: `Failed to parse Lark message: ${e instanceof Error ? e.message : String(e)}`,
      }));
    }
  }

  // ── sendStatus ───────────────────────────────────────────────────────
  // Creates a coordinator for the run on first call; subsequent calls from
  // the same run reuse the coordinator which edits the same bubble in-place.

  async sendStatus(
    conversation: ConversationHandle,
    update: StatusUpdate,
  ): Promise<Result<StatusHandle, ChannelError>> {
    try {
      const corrId = String(conversation.correlationId);
      if (!this.coordinators.has(corrId)) {
        this.coordinators.set(corrId, new LarkStatusCoordinator({
          client: this.messagingClient,
          chatId: String(conversation.chatId),
          correlationId: corrId,
          ...(conversation.replyToMessageId !== undefined
            ? { replyToMessageId: String(conversation.replyToMessageId) }
            : {}),
          ...(conversation.replyInThread !== undefined
            ? { replyInThread: conversation.replyInThread }
            : {}),
          logger: this.logger,
        }));
      }
      const coordinator = this.coordinators.get(corrId)!;
      await coordinator.update({
        ...(update.branding  ? { branding:  update.branding  } : {}),
        ...(update.timeline  ? { timeline:  update.timeline  } : {}),
      });
      const mid = coordinator.getStatusMessageId() ?? '';
      return ok({
        channel: 'lark',
        messageId: asMessageId(mid),
        correlationId: conversation.correlationId,
      });
    } catch (e) {
      return err(new ChannelError({
        channel: 'lark',
        stage: 'send_status',
        reason: 'upstream_5xx',
        cause: e,
      }));
    }
  }

  // ── editStatus ───────────────────────────────────────────────────────
  // Routes through the coordinator so it always edits the same bubble.

  async editStatus(
    handle: StatusHandle,
    update: StatusUpdate,
  ): Promise<Result<StatusHandle, ChannelError>> {
    try {
      const corrId = String(handle.correlationId);
      const coordinator = this.coordinators.get(corrId);
      if (coordinator) {
        await coordinator.update({
          ...(update.branding ? { branding: update.branding } : {}),
          ...(update.timeline ? { timeline: update.timeline } : {}),
        });
      }
      return ok(handle);
    } catch (e) {
      return err(new ChannelError({
        channel: 'lark',
        stage: 'edit_status',
        reason: 'upstream_5xx',
        cause: e,
      }));
    }
  }

  // ── sendFinalReply ───────────────────────────────────────────────────

  /**
   * Deliver a run's answer at most once.
   *
   * Wave 2 made an accepted message survive a restart, but at-least-once
   * execution only promises the work happens again — a retried run reaching
   * here would say the same thing twice. The reservation below is what makes
   * the retry safe: the key is derived from the run, so the second attempt
   * recognises the first instead of posting a second reply.
   *
   * Without a delivery repository this degrades to the previous behaviour
   * rather than refusing to send, because a missing duplicate guard should not
   * turn into silence.
   */
  async sendFinalReply(
    conversation: ConversationHandle,
    reply: FinalReply,
  ): Promise<Result<ReplyHandle, ChannelError>> {
    const repo = this.deliveryRepo;
    if (!repo) return this.deliverFinalReply(conversation, reply);

    const corrId = String(conversation.correlationId);
    const deliveryKey = buildDeliveryKey({ runKey: corrId, purpose: 'final' });
    const reservation = await repo.reserve({
      channel: 'lark',
      idempotencyKey: deliveryKey,
      runKey: corrId,
      purpose: 'final',
      chatId: String(conversation.chatId),
      // Stored so a delivery that fails after the agent finished can be resent
      // without re-running the tools that produced it.
      payload: buildLarkFinalDeliveryEnvelope(
        conversation,
        reply,
      ) as unknown as Record<string, unknown>,
    });

    if (!reservation.ok) {
      // The guard is unavailable, not the channel. Sending unguarded risks a
      // duplicate; not sending guarantees silence. Duplicate is the lesser harm.
      this.logger.warn('lark.adapter.delivery.reserve_failed', {
        correlationId: corrId,
        error: reservation.error.message,
      });
      return this.deliverFinalReply(conversation, reply);
    }

    if (reservation.value.outcome === 'delivered') {
      this.logger.info('lark.adapter.delivery.already_delivered', {
        correlationId: corrId,
        providerMessageId: reservation.value.record.providerMessageId ?? null,
        attempts: reservation.value.record.attempts,
      });
      return ok({
        channel: 'lark',
        messageId: asMessageId(reservation.value.record.providerMessageId ?? ''),
      });
    }

    if (reservation.value.outcome === 'inFlight') {
      // Another attempt holds the lease and has not gone quiet. Reporting this
      // as ambiguous rather than failed keeps the caller from re-driving it.
      this.logger.warn('lark.adapter.delivery.in_flight', { correlationId: corrId });
      return err(new ChannelError({
        channel: 'lark',
        stage: 'send_final',
        reason: 'ambiguous_delivery',
        message: 'Another attempt is already delivering this reply',
      }));
    }

    if (reservation.value.outcome === 'abandoned') {
      this.logger.warn('lark.adapter.delivery.abandoned', { correlationId: corrId });
      return err(new ChannelError({
        channel: 'lark',
        stage: 'send_final',
        reason: 'upstream_5xx',
        message: 'Delivery of this reply was already abandoned',
      }));
    }

    const { deliveryId } = reservation.value.record;
    const providerKey = toProviderIdempotencyKey(
      deliveryKey,
      input => createHash('sha256').update(input).digest('hex'),
    );

    const result = await this.deliverFinalReply(conversation, reply, providerKey);

    if (result.ok) {
      await repo.markDelivered(deliveryId, String(result.value.messageId) || undefined);
      return result;
    }

    const verdict = classifyDeliveryFailure(result.error.payload.cause ?? result.error);
    await repo.markFailed(deliveryId, result.error, {
      terminal: !verdict.retryable,
      ambiguous: verdict.ambiguous,
    });
    this.logger.warn('lark.adapter.delivery.failed', {
      correlationId: corrId,
      reason: verdict.reason,
      retryable: verdict.retryable,
      ambiguous: verdict.ambiguous,
    });
    return result;
  }

  private async deliverFinalReply(
    conversation: ConversationHandle,
    reply: FinalReply,
    providerIdempotencyKey?: string,
  ): Promise<Result<ReplyHandle, ChannelError>> {
    const startedAtMs = Date.now();
    const corrId = String(conversation.correlationId);
    const coordinator = this.coordinators.get(corrId);
    const stuckCardId = coordinator?.getStatusMessageId();

    try {
      const segments = planFinalCards({
        markdown: reply.text,
        ...(reply.branding        ? { branding:       reply.branding }        : {}),
        ...(reply.actions         ? { actions:        reply.actions  }        : {}),
        ...(reply.executionTrace  ? { executionTrace: reply.executionTrace }  : {}),
      });
      const [primarySegment, ...continuationSegments] = segments;
      if (!primarySegment) {
        this.logger.warn('lark.adapter.final_delivery.failed', {
          correlationId: corrId,
          durationMs: Date.now() - startedAtMs,
          reason: 'malformed',
        });
        return err(new ChannelError({
          channel: 'lark',
          stage: 'send_final',
          reason: 'malformed',
          message: 'No final card segments were generated',
        }));
      }

      let messageId: string | undefined;
      let statusFinalizeFailed = false;
      let deliveryIncomplete = false;
      // Kept so the caller can classify the failure. Without it every total
      // failure looks alike, and a 400 that will never succeed gets retried on
      // the same schedule as a transient outage.
      let lastSendError: unknown;

      // Try 1: Finalize via coordinator (edit status card → final card)
      if (coordinator) {
        try {
          messageId = await coordinator.finalizeMessage(primarySegment.payload);
        } catch (e) {
          statusFinalizeFailed = true;
          lastSendError = e;
          this.logger.warn('lark.adapter.finalize_failed', {
            error: e instanceof Error ? e.message : String(e),
            correlationId: corrId,
          });
          if (isAmbiguousDeliveryFailure(e)) {
            return this.ambiguousFinalDeliveryFailure(corrId, startedAtMs, e);
          }
        } finally {
          this.coordinators.delete(corrId);
        }
      }

      // Try 2: Send as new card message
      if (!messageId) {
        try {
          const result = await this.messagingClient.sendMessage(
            conversation.chatId,
            primarySegment.payload,
            conversation.replyToMessageId,
            conversation.replyInThread,
            providerIdempotencyKey,
          );
          messageId = result.messageId;
        } catch (e) {
          lastSendError = e;
          this.logger.warn('lark.adapter.send_card_failed', {
            error: e instanceof Error ? e.message : String(e),
            correlationId: corrId,
          });
          if (isAmbiguousDeliveryFailure(e)) {
            return this.ambiguousFinalDeliveryFailure(corrId, startedAtMs, e);
          }
        }
      }

      if (messageId && continuationSegments.length > 0) {
        const continuationResult = await this.sendContinuationCards(
          conversation,
          continuationSegments.map(segment => segment.payload),
          corrId,
        );
        if (!continuationResult.ok) {
          this.logger.warn('lark.adapter.continuation_send_failed', {
            error: continuationResult.error.message,
            correlationId: corrId,
            continuationCount: continuationSegments.length,
            deliveredCount: continuationResult.sentCount,
          });
          if (continuationResult.ambiguous) {
            deliveryIncomplete = true;
          } else {
            const fallback = await this.sendPlainTextFallback(
              conversation,
              continuationSegments
                .slice(continuationResult.sentCount)
                .map(segment => segment.markdown),
              corrId,
            );
            deliveryIncomplete = !fallback.complete;
          }
        }
      }

      if (messageId && stuckCardId && statusFinalizeFailed) {
        await this.updateStuckStatusCard(
          stuckCardId,
          reply.branding,
          deliveryIncomplete
            ? 'The response was only partially delivered. Please try again.'
            : continuationSegments.length > 0
            ? 'Response continued below due to card limits.'
            : 'Response sent below due to card limits.',
          corrId,
        );
      }

      // Try 3: Last resort — send plain text (bypasses card rendering entirely)
      if (!messageId) {
        if (stuckCardId) {
          await this.updateStuckStatusCard(
            stuckCardId,
            reply.branding,
            'Response sent below due to card limits.',
            corrId,
          );
        }
        const fallback = await this.sendPlainTextFallback(
          conversation,
          segments.map(segment => segment.markdown),
          corrId,
        );
        messageId = fallback.messageId;
        deliveryIncomplete = !fallback.complete;
        if (!messageId && fallback.ambiguous) {
          return err(new ChannelError({
            channel: 'lark',
            stage: 'send_final',
            reason: 'ambiguous_delivery',
            message: 'Final delivery outcome is unknown; Divo did not retry to avoid a duplicate.',
          }));
        }
      }

      if (messageId && deliveryIncomplete) {
        this.logger.warn('lark.adapter.final_delivery.failed', {
          correlationId: corrId,
          durationMs: Date.now() - startedAtMs,
          messageId,
          reason: 'partial_delivery',
          segmentCount: segments.length,
        });
        return err(new ChannelError({
          channel: 'lark',
          stage: 'send_final',
          reason: 'partial_delivery',
          message: 'The primary response was delivered, but its continuation could not be sent.',
        }));
      }

      if (messageId) {
        this.logger.info('lark.adapter.final_delivery.completed', {
          correlationId: corrId,
          durationMs: Date.now() - startedAtMs,
          messageId,
          segmentCount: segments.length,
        });
        return ok({ channel: 'lark', messageId: asMessageId(messageId) });
      }

      // All 3 tries failed — clean up the stuck status card so it doesn't
      // show "Preparing response..." forever.
      if (stuckCardId) {
        const failureCard = buildFinalCard({
          markdown: 'Sorry, I couldn\'t deliver the response. Please try again.',
          ...(reply.branding ? { branding: reply.branding } : {}),
        });
        this.messagingClient.updateMessage(stuckCardId, failureCard)
          .catch(e => this.logger.warn('lark.adapter.stuck_card_cleanup_failed', {
            error: e instanceof Error ? e.message : String(e),
            correlationId: corrId,
          }));
      }

      this.logger.warn('lark.adapter.final_delivery.failed', {
        correlationId: corrId,
        durationMs: Date.now() - startedAtMs,
        reason: 'upstream_5xx',
      });
      return err(new ChannelError({
        channel: 'lark', stage: 'send_final', reason: 'upstream_5xx',
        message: 'All delivery attempts failed (finalize, card, plain text)',
        ...(lastSendError ? { cause: lastSendError } : {}),
      }));
    } catch (e) {
      this.coordinators.delete(corrId);
      this.logger.warn('lark.adapter.final_delivery.failed', {
        correlationId: corrId,
        durationMs: Date.now() - startedAtMs,
        reason: 'upstream_5xx',
        error: e instanceof Error ? e.message : String(e),
      });
      return err(new ChannelError({ channel: 'lark', stage: 'send_final', reason: 'upstream_5xx', cause: e }));
    }
  }

  // ── sendDirectCard ───────────────────────────────────────────────────
  // Sends an interactive card to a user by Lark open_id (DM).

  /**
   * Send a prebuilt card to a chat.
   *
   * Deliberately outside the delivery reservation. This carries system notices
   * — sign-in, "I can't reach your workspace" — not the answer to a question,
   * and reserving it would consume the run's `final` key and suppress the reply
   * that follows.
   */
  async sendCardToChat(
    chatId: string,
    cardContent: string,
    replyToMessageId?: string,
    replyInThread?: boolean,
  ): Promise<Result<{ messageId: string }, ChannelError>> {
    try {
      return ok(await this.messagingClient.sendCardToChat(
        chatId,
        cardContent,
        replyToMessageId,
        replyInThread,
      ));
    } catch (e) {
      return err(new ChannelError({
        channel: 'lark',
        stage: 'send_status',
        reason: directCardFailureReason(e),
        cause: e,
      }));
    }
  }

  async sendDirectCard(openId: string, cardContent: string): Promise<Result<{ messageId: string }, ChannelError>> {
    try {
      const result = await this.messagingClient.sendCardToOpenId(openId, cardContent);
      return ok(result);
    } catch (e) {
      return err(new ChannelError({
        channel: 'lark',
        stage: 'send_status',
        reason: directCardFailureReason(e),
        cause: e,
      }));
    }
  }

  // ── updateMessageById ─────────────────────────────────────────────────────
  // Edits an arbitrary message by ID (used by approval webhook to update the card).

  async updateMessageById(messageId: string, cardContent: string): Promise<Result<void, ChannelError>> {
    try {
      await this.messagingClient.updateMessage(messageId, cardContent);
      return ok(undefined);
    } catch (e) {
      return err(new ChannelError({ channel: 'lark', stage: 'edit_status', reason: 'upstream_5xx', cause: e }));
    }
  }

  // ── restoreStatusCoordinator ─────────────────────────────────────────
  // Pre-seeds a coordinator with an existing statusMessageId so that the
  // resume flow edits the original bubble rather than sending a new one.

  restoreStatusCoordinator(correlationId: string, statusMessageId: string, chatId: string): void {
    if (this.coordinators.has(correlationId)) return; // already active
    const coordinator = new LarkStatusCoordinator({
      client:         this.messagingClient,
      chatId,
      correlationId,
      logger:         this.logger,
    });
    // Force the coordinator to know it already has a status message
    (coordinator as any).statusMessageId = statusMessageId;
    this.coordinators.set(correlationId, coordinator);
  }

  /** Read the current status messageId for a run, if a coordinator exists. */
  getStatusMessageId(correlationId: string): string | undefined {
    return this.coordinators.get(correlationId)?.getStatusMessageId();
  }

  /** Register an AbortController for an active run so it can be interrupted. */
  registerAbortController(
    correlationId: string,
    controller: AbortController,
    owner: LarkRunOwner,
  ): void {
    this.abortControllers.set(correlationId, controller);
    this.runOwners.set(correlationId, owner);
  }

  /**
   * Interrupt a run only for its requester or an admin in the same company.
   *
   * Private because a run is addressed by the conversation it belongs to, not
   * by an internal correlation id: `/q` names a conversation, and there is no
   * longer any surface that hands a caller a raw correlation id to stop.
   */
  private interruptRun(correlationId: string, actor: LarkInterruptActor): LarkInterruptResult {
    const controller = this.abortControllers.get(correlationId);
    const owner = this.runOwners.get(correlationId);
    if (!controller || !owner) return 'not_found';
    const isCompanyAdmin = actor.aiRole === 'COMPANY_ADMIN' || actor.aiRole === 'SUPER_ADMIN';
    if (
      actor.companyId !== owner.companyId
      || (actor.userId !== owner.userId && !isCompanyAdmin)
    ) {
      return 'forbidden';
    }
    controller.abort('User interrupted the run');
    this.abortControllers.delete(correlationId);
    this.runOwners.delete(correlationId);
    return 'aborted';
  }

  /** Interrupt the active run in one exact DM, thread, or inline-user session. */
  interruptConversation(
    conversationKey: string,
    actor: LarkInterruptActor,
  ): LarkInterruptResult {
    const active = [...this.runOwners.entries()]
      .find(([, owner]) => owner.conversationKey === conversationKey);
    return active ? this.interruptRun(active[0], actor) : 'not_found';
  }

  /** Clean up abort controller after run completes. */
  cleanupAbortController(correlationId: string): void {
    this.abortControllers.delete(correlationId);
    this.runOwners.delete(correlationId);
  }

  // ── reactToIncoming ──────────────────────────────────────────────────

  async reactToIncoming(messageId: MessageId, emoji: string): Promise<Result<void, ChannelError>> {
    try {
      await this.messagingClient.addReaction(messageId, emoji);
      return ok(undefined);
    } catch (e) {
      return err(new ChannelError({ channel: 'lark', stage: 'send_status', reason: 'upstream_5xx', cause: e }));
    }
  }

  // ── sendToChatId ──────────────────────────────────────────────────────
  // Sends a message to a chatId. Pass replyToMessageId to quote-reply a specific message.

  async sendToChatId(
    chatId: string,
    content: string,
    replyToMessageId?: string,
    idempotencyKey?: string,
    replyInThread?: boolean,
  ): Promise<Result<string, ChannelError>> {
    try {
      const result = await this.messagingClient.sendMessage(
        chatId,
        content,
        replyToMessageId,
        replyInThread,
        idempotencyKey,
      );
      return ok(result.messageId);
    } catch (e) {
      return err(new ChannelError({ channel: 'lark', stage: 'send_status', reason: 'upstream_5xx', cause: e }));
    }
  }

  private async sendContinuationCards(
    conversation: ConversationHandle,
    payloads: readonly string[],
    correlationId: string,
  ): Promise<
    | { ok: true; sentCount: number }
    | { ok: false; sentCount: number; ambiguous: boolean; error: ChannelError }
  > {
    let sentCount = 0;
    for (const payload of payloads) {
      try {
        await this.messagingClient.sendMessage(
          conversation.chatId,
          payload,
          conversation.replyToMessageId,
          conversation.replyInThread,
        );
        sentCount += 1;
      } catch (e) {
        return {
          ok: false,
          sentCount,
          ambiguous: isAmbiguousDeliveryFailure(e),
          error: new ChannelError({
            channel: 'lark',
            stage: 'send_final',
            reason: 'upstream_5xx',
            cause: e,
            message: `Failed to send continuation card: ${e instanceof Error ? e.message : String(e)}`,
          }),
        };
      }
    }
    return { ok: true, sentCount };
  }

  private ambiguousFinalDeliveryFailure(
    correlationId: string,
    startedAtMs: number,
    cause: unknown,
  ): Result<ReplyHandle, ChannelError> {
    this.logger.warn('lark.adapter.final_delivery.failed', {
      correlationId,
      durationMs: Date.now() - startedAtMs,
      reason: 'ambiguous_outcome',
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return err(new ChannelError({
      channel: 'lark',
      stage: 'send_final',
      reason: 'ambiguous_delivery',
      cause,
      message: 'Final delivery outcome is unknown; Divo did not retry to avoid a duplicate.',
    }));
  }

  private async sendPlainTextFallback(
    conversation: ConversationHandle,
    messages: readonly string[],
    correlationId: string,
  ): Promise<{ messageId: string | undefined; complete: boolean; ambiguous: boolean }> {
    let firstMessageId: string | undefined;
    let sentCount = 0;
    const chunks = splitPlainTextMessages(messages.join('\n\n'));
    try {
      for (const chunk of chunks) {
        const textContent = JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        });
        const result = await this.messagingClient.sendMessage(
          conversation.chatId,
          textContent,
          conversation.replyToMessageId,
          conversation.replyInThread,
        );
        firstMessageId ??= result.messageId;
        sentCount += 1;
      }
      if (firstMessageId) {
        this.logger.info('lark.adapter.plain_text_fallback_sent', { correlationId });
      }
      return { messageId: firstMessageId, complete: true, ambiguous: false };
    } catch (e) {
      this.logger.error(firstMessageId
        ? 'lark.adapter.plain_text_fallback_partial'
        : 'lark.adapter.all_delivery_failed', {
        error: e instanceof Error ? e.message : String(e),
        correlationId,
        deliveredCount: sentCount,
        totalCount: chunks.length,
      });
      return {
        messageId: firstMessageId,
        complete: false,
        ambiguous: isAmbiguousDeliveryFailure(e),
      };
    }
  }

  private async updateStuckStatusCard(
    messageId: string,
    branding: FinalReply['branding'],
    text: string,
    correlationId: string,
  ): Promise<void> {
    const redirectCard = buildFinalCard({
      markdown: text,
      ...(branding ? { branding } : {}),
    });
    try {
      await this.messagingClient.updateMessage(messageId, redirectCard);
    } catch (e) {
      this.logger.warn('lark.adapter.stuck_card_cleanup_failed', {
        error: e instanceof Error ? e.message : String(e),
        correlationId,
      });
    }
  }

}

function directCardFailureReason(error: unknown): 'upstream_4xx' | 'upstream_5xx' | 'rate_limited' {
  if (!(error instanceof LarkApiError)) return 'upstream_5xx';
  if (error.status === 429 || error.code === 99991400) return 'rate_limited';
  if (
    (error.status >= 400 && error.status < 500)
    || (error.status === 200 && error.code !== undefined && error.code !== 0)
  ) {
    return 'upstream_4xx';
  }
  return 'upstream_5xx';
}

function isAmbiguousDeliveryFailure(error: unknown): boolean {
  if (error instanceof LarkStatusDrainTimeoutError) return false;
  return !(error instanceof LarkApiError) || error.status === 0;
}

// ── Module-level helpers ────────────────────────────────────────────────────

/**
 * Replace "@_user_X" placeholder keys in a text-type message with real names.
 * Self-mentions (the bot) are stripped entirely so the LLM sees clean intent.
 */
function resolveMentionKeys(
  raw: string,
  mentionByKey: Map<string, MentionRef>,
): string {
  // Replace each @_key occurrence with resolved name or strip if self
  return raw.replace(/@_[a-zA-Z0-9_]+/g, (key) => {
    const mention = mentionByKey.get(key);
    if (!mention) return key; // unknown key — leave as-is
    if (mention.isSelf) return ''; // strip bot self-mention
    return `@${mention.name}`;
  }).replace(/\s{2,}/g, ' ').trim();
}

/**
 * Flatten a Lark "post" (rich text) message into plain text.
 * content.content is a 2D array (paragraphs × inline blocks).
 */
function extractPostText(
  parsed: Record<string, unknown>,
  botOpenId: string,
): { text: string; mentionsSelf: boolean } {
  const paragraphs = (parsed['content'] as unknown[][] | undefined) ?? [];
  const lines: string[] = [];
  let mentionsSelf = false;

  for (const para of paragraphs) {
    const parts: string[] = [];
    for (const block of para) {
      const b = block as Record<string, unknown>;
      const tag = b['tag'] as string | undefined;

      if (tag === 'text') {
        parts.push((b['text'] as string | undefined) ?? '');
      } else if (tag === 'at') {
        const userName = (b['user_name'] as string | undefined) ?? '';
        const userId   = (b['user_id']   as string | undefined) ?? '';
        const isSelf = Boolean(botOpenId && userId === botOpenId);
        mentionsSelf ||= isSelf;
        if (!isSelf) {
          parts.push(`@${userName || userId}`);
        }
        // Self-mention (@Bot) in a post → strip (don't push anything)
      } else if (tag === 'a') {
        // Hyperlink: prefer text over href
        const linkText = (b['text'] as string | undefined) ?? (b['href'] as string | undefined) ?? '';
        parts.push(linkText);
      }
      // img, emotion → skip (not useful for LLM text)
    }
    const line = parts.join('').trim();
    if (line) lines.push(line);
  }

  return { text: lines.join('\n'), mentionsSelf };
}

export const isLarkHumanMessage = (incoming: IncomingMessage): boolean =>
  incoming.senderType === 'user';

export const shouldStartLarkAgent = (incoming: IncomingMessage): boolean =>
  isLarkHumanMessage(incoming)
  && (incoming.chatType === 'p2p' || incoming.mentionsSelf);

function splitPlainTextMessages(text: string, maxChars = 3500): string[] {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    for (let index = 0; index < paragraph.length; index += maxChars) {
      chunks.push(paragraph.slice(index, index + maxChars));
    }
    current = '';
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [normalized.slice(0, maxChars)];
}
