/**
 * Turn an OpenWA webhook payload into the row Divo stores.
 *
 * Ported from the follow-up agent's `normalize`, and kept pure: it takes a
 * payload and returns a value, so the awkward parts — which field holds the chat
 * id, whose name to trust — are testable without a gateway or a database.
 */

export interface NormalizedWhatsappMessage {
  readonly waMessageId: string;
  readonly waChatId: string;
  /**
   * The chat's display name, but only when the payload actually carries one.
   *
   * Empty for groups and for outbound direct messages, and that emptiness is
   * deliberate. A group payload never carries the subject, and an outbound
   * direct message names *us*, not the counterpart — writing either would
   * replace a good chat name with a phone number. The chat-list refresh fills
   * these in properly.
   */
  readonly chatName: string;
  readonly isGroup: boolean;
  readonly senderName: string;
  readonly fromMe: boolean;
  readonly body: string;
  readonly type: string;
  readonly quotedText: string | null;
  readonly occurredAt: Date;
}

/** Raw shape as OpenWA sends it. Every field is optional because it is theirs, not ours. */
export interface OpenWaMessagePayload {
  readonly id?: string;
  readonly chatId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly author?: string;
  readonly isGroup?: boolean;
  readonly fromMe?: boolean;
  readonly body?: string;
  readonly type?: string;
  readonly timestamp?: number | string;
  readonly senderPhone?: string;
  readonly isStatusBroadcast?: boolean;
  readonly kind?: string;
  readonly contact?: { readonly name?: string; readonly pushName?: string };
  readonly quotedMessage?: { readonly body?: string };
}

export interface WhatsappWebhookEnvelope {
  readonly event?: string;
  readonly sessionId?: string;
  readonly data?: OpenWaMessagePayload;
}

/** Strip the WhatsApp JID down to the digits people recognise. */
const digits = (jid: string | undefined): string =>
  String(jid ?? '').split('@')[0]?.split(':')[0] ?? '';

/**
 * Why an envelope was not stored.
 *
 * `ignored` and `not_a_conversation` are ordinary and expected many times a day;
 * `malformed` means the gateway sent something we could not read, which is worth
 * seeing in logs. Keeping them distinct is what stops a real gateway fault
 * hiding inside routine noise.
 */
export type WhatsappIngestRejection =
  | 'ignored_event'
  | 'not_a_conversation'
  | 'malformed';

export type NormalizeOutcome =
  | { readonly ok: true; readonly message: NormalizedWhatsappMessage; readonly sessionId: string }
  | { readonly ok: false; readonly reason: WhatsappIngestRejection };

/** Events that carry a conversation. Anything else is not ours to store. */
const CONVERSATION_EVENTS = new Set(['message.received', 'message.sent']);

export function normalizeWhatsappEnvelope(
  envelope: WhatsappWebhookEnvelope,
  fallbackSessionId?: string,
): NormalizeOutcome {
  if (!envelope.event || !CONVERSATION_EVENTS.has(envelope.event)) {
    return { ok: false, reason: 'ignored_event' };
  }
  return normalizeWhatsappPayload(envelope.data, envelope.sessionId ?? fallbackSessionId);
}

/**
 * The same rules, applied to a bare message payload.
 *
 * History reads return messages without an event envelope. They must go through
 * exactly this code rather than a second parser: a re-read that decided the chat
 * id or the sender name differently from the webhook path would write duplicate
 * rows under different chats, and the repair would be worse than the gap.
 */
export function normalizeWhatsappPayload(
  data: OpenWaMessagePayload | undefined,
  sessionId: string | undefined,
): NormalizeOutcome {
  if (!data?.id) return { ok: false, reason: 'malformed' };

  // Status updates and channel broadcasts arrive on the same stream as real
  // conversations. Nobody owes anybody a follow-up over a status post.
  if (data.isStatusBroadcast || data.kind === 'status' || data.kind === 'channel') {
    return { ok: false, reason: 'not_a_conversation' };
  }

  if (!sessionId) return { ok: false, reason: 'malformed' };

  const isGroup = Boolean(data.isGroup);
  const fromMe = Boolean(data.fromMe);

  // In a group the chat is where it was sent; in a direct message it is
  // whichever end is not us.
  const waChatId = data.chatId ?? (isGroup ? data.from : fromMe ? data.to : data.from);
  if (!waChatId) return { ok: false, reason: 'malformed' };

  const senderId = isGroup ? (data.author ?? data.from) : fromMe ? 'me' : data.from;
  const senderName = fromMe
    ? 'You'
    : data.contact?.name
      || data.contact?.pushName
      || data.senderPhone
      || digits(senderId)
      || 'Unknown';

  const timestamp = Number(data.timestamp);
  // OpenWA sends seconds. A missing or unparseable stamp becomes "now" rather
  // than 1970, which would drop the message outside every analysis window and
  // make it invisible instead of merely imprecise.
  const occurredAt = Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000)
    : new Date();

  return {
    ok: true,
    sessionId,
    message: {
      waMessageId: data.id,
      waChatId,
      chatName: !isGroup && !fromMe ? senderName : '',
      isGroup,
      senderName,
      fromMe,
      body: data.body ?? '',
      type: data.type ?? 'text',
      quotedText: data.quotedMessage?.body ?? null,
      occurredAt,
    },
  };
}
