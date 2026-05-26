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
import { LarkStatusCoordinator } from './lark-status.coordinator';
import { buildFinalCard } from './lark-card.builder';

export class LarkChannelAdapter implements ChannelAdapter {
  readonly key = 'lark' as const;

  private readonly messagingClient: LarkMessagingClient;
  private readonly logger: Logger;
  private readonly botName: string;
  // One coordinator per in-flight run, keyed by correlationId.
  // Manages single-bubble status updates with rate-limiting and dedup.
  private readonly coordinators = new Map<string, LarkStatusCoordinator>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(deps: { env: TypedEnv; logger: Logger }) {
    this.logger = deps.logger.child({ channel: 'lark' });
    this.botName = deps.env.LARK_BOT_NAME;
    this.messagingClient = new LarkMessagingClient({
      appId: deps.env.LARK_APP_ID,
      appSecret: deps.env.LARK_APP_SECRET,
      logger: this.logger,
    });
  }

  // ── parseIncoming ────────────────────────────────────────────────────

  parseIncoming(raw: unknown): Result<IncomingMessage, ChannelError> {
    try {
      const event = raw as Record<string, unknown>;

      const header = event['header'] as Record<string, unknown> | undefined;
      const eventType = header?.['event_type'] as string | undefined;

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
      const larkOpenId  = (sender['sender_id'] as Record<string, unknown>)['open_id'] as string;
      const createTime  = message['create_time']  as string;
      const parentId    = message['parent_id']    as string | undefined;

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
        const isSelf = name.toLowerCase() === this.botName.toLowerCase();
        return { key, openId, name, isSelf };
      });

      // Lookup map: "@_user_1" → MentionRef
      const mentionByKey = new Map<string, MentionRef>(mentions.map(m => [m.key, m]));
      const mentionsSelf = mentions.some(m => m.isSelf) || chatType === 'p2p';

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
          text = extractPostText(parsed, mentionByKey, this.botName);
        } else {
          // Plain "text" message: content.text holds the raw string with @_user_X keys.
          const raw = (parsed['text'] as string | undefined) ?? '';
          text = resolveMentionKeys(raw, mentionByKey, this.botName);
        }
      }

      const traceId = asCorrelationId(`${messageId}-${createTime}`);

      return ok({
        channel: 'lark',
        messageId: asMessageId(messageId),
        chatId: asChatId(chatId),
        chatType: chatType === 'p2p' ? 'p2p' : 'group',
        userExternalId: larkOpenId,
        text: text.trim(),
        attachments: [],
        timestamp: new Date(Number(createTime)).toISOString(),
        ...(parentId ? { replyToMessageId: asMessageId(parentId) } : {}),
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

  async sendFinalReply(
    conversation: ConversationHandle,
    reply: FinalReply,
  ): Promise<Result<ReplyHandle, ChannelError>> {
    const corrId = String(conversation.correlationId);
    const coordinator = this.coordinators.get(corrId);

    try {
      const content = buildFinalCard({
        markdown: reply.text,
        ...(reply.branding        ? { branding:       reply.branding }        : {}),
        ...(reply.actions         ? { actions:        reply.actions  }        : {}),
        ...(reply.executionTrace  ? { executionTrace: reply.executionTrace }  : {}),
      });

      let messageId: string | undefined;

      // Try 1: Finalize via coordinator (edit status card → final card)
      if (coordinator) {
        try {
          messageId = await coordinator.finalizeMessage(content);
        } catch (e) {
          this.logger.warn('lark.adapter.finalize_failed', {
            error: e instanceof Error ? e.message : String(e),
            correlationId: corrId,
          });
        } finally {
          this.coordinators.delete(corrId);
        }
      }

      // Try 2: Send as new card message
      if (!messageId) {
        try {
          const result = await this.messagingClient.sendMessage(
            conversation.chatId,
            content,
            conversation.replyToMessageId,
            conversation.replyInThread,
          );
          messageId = result.messageId;
        } catch (e) {
          this.logger.warn('lark.adapter.send_card_failed', {
            error: e instanceof Error ? e.message : String(e),
            correlationId: corrId,
          });
        }
      }

      // Try 3: Last resort — send plain text (bypasses card rendering entirely)
      if (!messageId) {
        try {
          const plainText = reply.text.slice(0, 4000);
          const textContent = JSON.stringify({
            msg_type: 'text',
            content: JSON.stringify({ text: plainText }),
          });
          const result = await this.messagingClient.sendMessage(
            conversation.chatId,
            textContent,
            conversation.replyToMessageId,
            conversation.replyInThread,
          );
          messageId = result.messageId;
          this.logger.info('lark.adapter.plain_text_fallback_sent', { correlationId: corrId });
        } catch (e) {
          this.logger.error('lark.adapter.all_delivery_failed', {
            error: e instanceof Error ? e.message : String(e),
            correlationId: corrId,
          });
        }
      }

      if (messageId) {
        return ok({ channel: 'lark', messageId: asMessageId(messageId) });
      }

      return err(new ChannelError({
        channel: 'lark', stage: 'send_final', reason: 'upstream_5xx',
        message: 'All delivery attempts failed (finalize, card, plain text)',
      }));
    } catch (e) {
      this.coordinators.delete(corrId);
      return err(new ChannelError({ channel: 'lark', stage: 'send_final', reason: 'upstream_5xx', cause: e }));
    }
  }

  // ── sendDirectCard ───────────────────────────────────────────────────
  // Sends an interactive card to a user by Lark open_id (DM).

  async sendDirectCard(openId: string, cardContent: string): Promise<Result<{ messageId: string }, ChannelError>> {
    try {
      const result = await this.messagingClient.sendCardToOpenId(openId, cardContent);
      return ok(result);
    } catch (e) {
      return err(new ChannelError({ channel: 'lark', stage: 'send_status', reason: 'upstream_5xx', cause: e }));
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
  registerAbortController(correlationId: string, controller: AbortController): void {
    this.abortControllers.set(correlationId, controller);
  }

  /** Interrupt a running agent by correlationId. Returns true if a run was found and aborted. */
  interruptRun(correlationId: string): boolean {
    const controller = this.abortControllers.get(correlationId);
    if (!controller) return false;
    controller.abort('User interrupted the run');
    this.abortControllers.delete(correlationId);
    return true;
  }

  /** Find the correlationId for a run by its status message ID. */
  findCorrelationByStatusMessage(messageId: string): string | undefined {
    for (const [corrId, coordinator] of this.coordinators) {
      if (coordinator.getStatusMessageId() === messageId) return corrId;
    }
    return undefined;
  }

  /** Clean up abort controller after run completes. */
  cleanupAbortController(correlationId: string): void {
    this.abortControllers.delete(correlationId);
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

  async sendToChatId(chatId: string, content: string, replyToMessageId?: string): Promise<Result<string, ChannelError>> {
    try {
      const result = await this.messagingClient.sendMessage(chatId, content, replyToMessageId);
      return ok(result.messageId);
    } catch (e) {
      return err(new ChannelError({ channel: 'lark', stage: 'send_status', reason: 'upstream_5xx', cause: e }));
    }
  }

}

// ── Module-level helpers ────────────────────────────────────────────────────

/**
 * Replace "@_user_X" placeholder keys in a text-type message with real names.
 * Self-mentions (the bot) are stripped entirely so the LLM sees clean intent.
 */
function resolveMentionKeys(
  raw: string,
  mentionByKey: Map<string, MentionRef>,
  botName: string,
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
  mentionByKey: Map<string, MentionRef>,
  botName: string,
): string {
  const paragraphs = (parsed['content'] as unknown[][] | undefined) ?? [];
  const lines: string[] = [];

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
        // Check by name first, then fall back to key lookup
        const isSelf = userName.toLowerCase() === botName.toLowerCase();
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

  return lines.join('\n');
}
