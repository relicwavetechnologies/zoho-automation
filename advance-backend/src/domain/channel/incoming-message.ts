import type { ChatId, CorrelationId, MessageId } from '../../shared/ids';

export type ChannelKey = 'lark' | 'desktop' | 'airnote';
export type ChatType = 'p2p' | 'group';
export type GroupReplyMode = 'threaded' | 'inline';

export interface AttachmentRef {
  readonly type: 'image' | 'file' | 'audio';
  readonly url?: string;
  readonly fileKey?: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly sizeBytes?: number;
}

/** A resolved mention extracted from the raw message. */
export interface MentionRef {
  /** The placeholder key used in text (e.g. "@_user_1"). */
  readonly key: string;
  /** Lark open_id of the mentioned user or bot. */
  readonly openId: string;
  /** Lark user_id when supplied by the event. */
  readonly userId?: string;
  /** Lark union_id when supplied by the event. */
  readonly unionId?: string;
  /** Display name of the mentioned user or bot. */
  readonly name: string;
  /** True when this mention is the bot itself. */
  readonly isSelf: boolean;
}

export interface ReferencedMessage {
  readonly messageId: string;
  readonly status: 'available' | 'deleted' | 'invisible' | 'forbidden' | 'unsupported' | 'unavailable';
  readonly messageType?: string;
  readonly text: string;
  readonly senderExternalId: string;
  readonly senderName?: string;
  readonly imageUrls: readonly string[];
  readonly omittedImageCount?: number;
}

export interface IncomingMessage {
  readonly channel: ChannelKey;
  readonly messageId: MessageId;
  readonly chatId: ChatId;
  readonly chatType: ChatType;
  /** External tenant/install identity supplied by the channel envelope. */
  readonly tenantKey?: string;
  /** External application identity supplied by the channel envelope. */
  readonly appId?: string;
  readonly userExternalId: string;    // lark open_id, desktop user token, etc.
  /** Additional stable sender identities when supplied by the channel. */
  readonly senderUserId?: string;
  readonly senderUnionId?: string;
  /** Resolved human-readable sender identity for shared conversation history. */
  readonly senderName?: string;
  /** Lark sender type when supplied by the channel event. */
  readonly senderType?: 'user' | 'bot' | 'app' | 'unknown';
  /**
   * Clean user intent text.
   * Self-mentions (@BotName) are stripped; other @mentions are replaced with
   * the real display name (e.g. "@Alice") so the LLM sees natural language.
   */
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
  /** Image URLs (Cloudinary or base64 data URLs) for multimodal LLM embedding in P2P. */
  readonly imageUrls?: readonly string[];
  readonly timestamp: string;         // ISO 8601
  /** Direct message being replied to; distinct from root/thread ownership. */
  readonly parentMessageId?: MessageId;
  /** Root message of the Lark thread when supplied. */
  readonly rootMessageId?: MessageId;
  /** Native Lark thread identity when supplied. */
  readonly threadId?: string;
  /**
   * Group delivery and working-context mode resolved by the backend.
   * Absent means the safe product default: one context per thread.
   */
  readonly groupReplyMode?: GroupReplyMode;
  /** Compatibility alias for callers that still expect the direct parent. */
  readonly replyToMessageId?: MessageId;
  readonly traceId: CorrelationId;
  /** All resolved mentions from this message. */
  readonly mentions: readonly MentionRef[];
  /** True when the bot itself was @mentioned (always true in p2p). */
  readonly mentionsSelf: boolean;
  /** Opaque original event payload — for debugging only, never logic. */
  readonly raw: unknown;
}
