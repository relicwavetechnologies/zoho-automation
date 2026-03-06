import type { LarkWebhookEnvelope } from './lark.types';

export type LarkIngressInvalidReason =
  | 'unknown_type'
  | 'missing_challenge'
  | 'missing_event_payload'
  | 'missing_message_fields'
  | 'missing_sender_fields'
  | 'unsupported_message_shape';

export type LarkIngressIgnoreReason =
  | 'unsupported_event_callback'
  | 'unsupported_message_type'
  | 'empty_text_message';

export type LarkIngressParseResult =
  | { kind: 'url_verification'; challenge: string }
  | {
    kind: 'event_callback_message';
    envelope: LarkWebhookEnvelope;
    eventType?: string;
    eventId?: string;
    larkTenantKey?: string;
  }
  | {
    kind: 'event_callback_ignored';
    reason: LarkIngressIgnoreReason;
    eventType?: string;
    eventId?: string;
    larkTenantKey?: string;
  }
  | { kind: 'invalid'; reason: LarkIngressInvalidReason; details?: string };

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as Record<string, unknown>;
};

const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseLarkTextContent = (content: unknown): string => {
  const raw = readString(content);
  if (!raw) {
    return '';
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return readString(parsed.text) ?? '';
  } catch {
    return raw;
  }
};

const hasSenderIdentity = (envelope: LarkWebhookEnvelope): boolean => {
  const sender = envelope.event?.sender;
  return Boolean(
    readString(sender?.sender_id?.open_id)
    ?? readString(sender?.sender_id?.user_id)
    ?? readString(sender?.employee_id),
  );
};

const hasMessageIdentity = (envelope: LarkWebhookEnvelope): boolean => {
  const message = envelope.event?.message;
  return Boolean(readString(message?.message_id) && readString(message?.chat_id));
};

const readTenantKey = (envelope: LarkWebhookEnvelope): string | undefined =>
  readString(envelope.header?.tenant_key)
  ?? readString(envelope.header?.tenantKey)
  ?? readString(envelope.event?.tenant_key)
  ?? readString(envelope.event?.tenantKey)
  ?? readString(envelope.tenant_key)
  ?? readString(envelope.tenantKey)
  ?? readString(envelope.tenantKeyId);

const readEventMetadata = (
  envelope: LarkWebhookEnvelope,
): { eventType?: string; eventId?: string; larkTenantKey?: string } => ({
  eventType: readString(envelope.header?.event_type),
  eventId: readString(envelope.header?.event_id),
  larkTenantKey: readTenantKey(envelope),
});

export const parseLarkIngressPayload = (payload: unknown): LarkIngressParseResult => {
  const record = asRecord(payload);
  if (!record) {
    return {
      kind: 'invalid',
      reason: 'unknown_type',
      details: 'Payload must be an object',
    };
  }

  const envelope = record as LarkWebhookEnvelope;
  // Lark v1 schema has top-level `type`, Lark v2 schema uses `schema: "2.0"` with `header`
  const schema = readString(envelope.schema);
  const type = readString(envelope.type);

  if (type === 'url_verification') {
    const challenge = readString(envelope.challenge);
    if (!challenge) {
      return {
        kind: 'invalid',
        reason: 'missing_challenge',
      };
    }
    return {
      kind: 'url_verification',
      challenge,
    };
  }

  // Treat as an event callback if type is explicitly 'event_callback' OR if it's schema 2.0
  if (type === 'event_callback' || schema === '2.0') {
    if (!envelope.event || typeof envelope.event !== 'object') {
      return {
        kind: 'invalid',
        reason: 'missing_event_payload',
      };
    }

    const metadata = readEventMetadata(envelope);
    const message = envelope.event.message;

    // Lark v2 message callback event type is 'im.message.receive_v1'
    if (metadata.eventType !== 'im.message.receive_v1' && !message) {
      return {
        kind: 'event_callback_ignored',
        reason: 'unsupported_event_callback',
        ...metadata,
      };
    }

    if (!message) {
      return {
        kind: 'invalid',
        reason: 'missing_message_fields',
      };
    }

    const msgType = readString(message.msg_type) ?? 'text';
    if (msgType !== 'text') {
      return {
        kind: 'event_callback_ignored',
        reason: 'unsupported_message_type',
        ...metadata,
      };
    }

    const parsedText = parseLarkTextContent(message.content);
    if (parsedText.trim().length === 0) {
      return {
        kind: 'event_callback_ignored',
        reason: 'empty_text_message',
        ...metadata,
      };
    }

    if (!hasSenderIdentity(envelope)) {
      return {
        kind: 'invalid',
        reason: 'missing_sender_fields',
      };
    }

    if (!hasMessageIdentity(envelope)) {
      return {
        kind: 'invalid',
        reason: 'missing_message_fields',
      };
    }

    return {
      kind: 'event_callback_message',
      envelope,
      ...metadata,
    };
  }

  return {
    kind: 'invalid',
    reason: 'unknown_type',
    details: `Unsupported top-level type: ${type ?? 'missing'} (schema: ${schema ?? 'missing'})`,
  };
};
