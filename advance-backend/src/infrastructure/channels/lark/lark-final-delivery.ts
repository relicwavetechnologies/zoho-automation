import type { ConversationHandle } from '../../../application/channels/channel.adapter';
import type { FinalReply } from '../../../domain/channel/outbound';

export interface LarkFinalDeliveryEnvelope {
  readonly version: 1;
  readonly reply: FinalReply;
  readonly target: {
    readonly chatId: string;
    readonly replyToMessageId?: string;
    readonly replyInThread?: boolean;
  };
}

export const buildLarkFinalDeliveryEnvelope = (
  conversation: ConversationHandle,
  reply: FinalReply,
): LarkFinalDeliveryEnvelope => ({
  version: 1,
  reply,
  target: {
    chatId: String(conversation.chatId),
    ...(conversation.replyToMessageId
      ? { replyToMessageId: String(conversation.replyToMessageId) }
      : {}),
    ...(conversation.replyInThread !== undefined
      ? { replyInThread: conversation.replyInThread }
      : {}),
  },
});

export function parseLarkFinalDeliveryEnvelope(
  payload: Record<string, unknown>,
): LarkFinalDeliveryEnvelope | null {
  const reply = asRecord(payload['reply']);
  const target = asRecord(payload['target']);
  if (
    payload['version'] !== 1
    || reply?.['kind'] !== 'final'
    || typeof reply['text'] !== 'string'
    || !isReplyFormat(reply['format'])
    || typeof target?.['chatId'] !== 'string'
    || !target['chatId']
    || !isOptionalString(target['replyToMessageId'])
    || !isOptionalBoolean(target['replyInThread'])
  ) {
    return null;
  }
  return payload as unknown as LarkFinalDeliveryEnvelope;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const isReplyFormat = (value: unknown): value is FinalReply['format'] =>
  value === 'text' || value === 'markdown' || value === 'interactive_card';

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';

const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === 'boolean';
