import type { ChatId, CorrelationId, MessageId } from '../../shared/ids';

export type ChannelKey = 'lark' | 'desktop' | 'airnote';
export type ChatType = 'p2p' | 'group';

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
  /** Display name of the mentioned user or bot. */
  readonly name: string;
  /** True when this mention is the bot itself. */
  readonly isSelf: boolean;
}

export interface IncomingMessage {
  readonly channel: ChannelKey;
  readonly messageId: MessageId;
  readonly chatId: ChatId;
  readonly chatType: ChatType;
  readonly userExternalId: string;    // lark open_id, desktop user token, etc.
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
  readonly replyToMessageId?: MessageId;
  readonly traceId: CorrelationId;
  /** All resolved mentions from this message. */
  readonly mentions: readonly MentionRef[];
  /** True when the bot itself was @mentioned (always true in p2p). */
  readonly mentionsSelf: boolean;
  /** Opaque original event payload — for debugging only, never logic. */
  readonly raw: unknown;
}
