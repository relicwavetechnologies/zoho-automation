import type { Result } from '../../shared/result';
import type { ChannelError } from '../../shared/errors';
import type { ChannelKey, IncomingMessage } from '../../domain/channel/incoming-message';
import type { StatusUpdate, FinalReply } from '../../domain/channel/outbound';
import type { MessageId, ChatId, CorrelationId } from '../../shared/ids';

// ─── Handles ──────────────────────────────────────────────────────────────

export interface ConversationHandle {
  readonly channel: ChannelKey;
  readonly chatId: ChatId;
  readonly replyToMessageId?: MessageId;
  readonly replyInThread?: boolean;
  readonly correlationId: CorrelationId;
}

export interface StatusHandle {
  readonly channel: ChannelKey;
  readonly messageId: MessageId;
  readonly correlationId: CorrelationId;
}

export interface ReplyHandle {
  readonly channel: ChannelKey;
  readonly messageId: MessageId;
}

// ─── The contract ─────────────────────────────────────────────────────────

/**
 * Implemented by each channel (Lark, Desktop, ...).
 * The engine only ever talks to this interface — never to channel SDKs directly.
 */
export interface ChannelAdapter {
  /** Unique channel key. */
  readonly key: ChannelKey;

  /** Parse a raw webhook/event payload into a domain IncomingMessage. */
  parseIncoming(raw: unknown): Result<IncomingMessage, ChannelError>;

  /**
   * Send an ephemeral status update (e.g. "thinking...", "searching emails...").
   * Returns a handle that can be used to edit/replace it via editStatus.
   */
  sendStatus(
    conversation: ConversationHandle,
    update: StatusUpdate,
  ): Promise<Result<StatusHandle, ChannelError>>;

  /**
   * Edit an existing status message in-place.
   * Falls back to sendStatus if the channel doesn't support editing.
   */
  editStatus(
    handle: StatusHandle,
    update: StatusUpdate,
  ): Promise<Result<StatusHandle, ChannelError>>;

  /**
   * Send the final, persistent reply.
   * Called once per turn after the engine completes.
   */
  sendFinalReply(
    conversation: ConversationHandle,
    reply: FinalReply,
  ): Promise<Result<ReplyHandle, ChannelError>>;

  /** Optional: add a reaction emoji to the triggering message. */
  reactToIncoming?(messageId: MessageId, emoji: string): Promise<Result<void, ChannelError>>;
}

// ─── Registry ─────────────────────────────────────────────────────────────

export class ChannelAdapterRegistry {
  private readonly adapters = new Map<ChannelKey, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.key, adapter);
  }

  get(key: ChannelKey): ChannelAdapter | undefined {
    return this.adapters.get(key);
  }

  has(key: ChannelKey): boolean {
    return this.adapters.has(key);
  }

  keys(): ChannelKey[] {
    return [...this.adapters.keys()];
  }
}
