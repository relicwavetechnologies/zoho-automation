import type {
  ChannelAdapter,
  ChannelOutboundMessage,
  ChannelOutboundResult,
  ChannelUpdateMessage,
} from '../base/channel-adapter';
import type { NormalizedIncomingMessageDTO } from '../../contracts';
import type { LarkWebhookEnvelope } from './lark.types';

const DEFAULT_LARK_API_BASE_URL = 'https://open.larksuite.com';

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null) {
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
    return readString(parsed.text) ?? raw;
  } catch {
    return raw;
  }
};

const toIsoTimestamp = (source?: string): string => {
  if (!source) {
    return new Date().toISOString();
  }

  const numeric = Number(source);
  if (Number.isFinite(numeric) && numeric > 0) {
    const millis = source.length >= 13 ? numeric : numeric * 1000;
    return new Date(millis).toISOString();
  }

  const asDate = new Date(source);
  if (!Number.isNaN(asDate.valueOf())) {
    return asDate.toISOString();
  }

  return new Date().toISOString();
};

export class LarkChannelAdapter implements ChannelAdapter {
  public readonly channel = 'lark' as const;

  private readonly apiBaseUrl: string;

  private readonly tenantAccessToken?: string;

  public constructor() {
    this.apiBaseUrl = process.env.LARK_API_BASE_URL ?? DEFAULT_LARK_API_BASE_URL;
    this.tenantAccessToken = process.env.LARK_BOT_TENANT_ACCESS_TOKEN;
  }

  public normalizeIncomingEvent(event: unknown): Readonly<NormalizedIncomingMessageDTO> | null {
    const envelope = asRecord(event) as LarkWebhookEnvelope | null;
    if (!envelope?.event?.message) {
      return null;
    }

    const sender = envelope.event.sender;
    const message = envelope.event.message;

    const userId =
      readString(sender?.sender_id?.open_id) ??
      readString(sender?.sender_id?.user_id) ??
      readString(sender?.employee_id);
    const chatId = readString(message.chat_id);
    const messageId = readString(message.message_id);

    if (!userId || !chatId || !messageId) {
      return null;
    }

    const normalized: NormalizedIncomingMessageDTO = {
      channel: 'lark',
      userId,
      chatId,
      chatType: message.chat_type === 'group' ? 'group' : 'p2p',
      messageId,
      timestamp: toIsoTimestamp(readString(message.create_time)),
      text: parseLarkTextContent(message.content),
      rawEvent: event,
    };

    return Object.freeze(normalized);
  }

  public async sendMessage(input: ChannelOutboundMessage): Promise<ChannelOutboundResult> {
    if (!this.tenantAccessToken) {
      return {
        channel: this.channel,
        status: 'failed',
        chatId: input.chatId,
        error: {
          type: 'API_ERROR',
          classifiedReason: 'Missing LARK_BOT_TENANT_ACCESS_TOKEN',
          rawMessage: 'Lark outbound send skipped because bot token is not configured.',
          retriable: false,
        },
      };
    }

    const response = await fetch(`${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.tenantAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: input.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: input.text }),
      }),
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      return {
        channel: this.channel,
        status: 'failed',
        chatId: input.chatId,
        providerResponse: payload,
        error: {
          type: 'API_ERROR',
          classifiedReason: 'Lark send message API request failed',
          rawMessage: readString(payload.msg) ?? response.statusText,
          retriable: response.status >= 500,
        },
      };
    }

    const data = asRecord(payload.data);
    return {
      channel: this.channel,
      status: 'sent',
      chatId: input.chatId,
      messageId: readString(data?.message_id),
      providerResponse: payload,
    };
  }

  public async updateMessage(input: ChannelUpdateMessage): Promise<ChannelOutboundResult> {
    if (!this.tenantAccessToken) {
      return {
        channel: this.channel,
        status: 'failed',
        messageId: input.messageId,
        error: {
          type: 'API_ERROR',
          classifiedReason: 'Missing LARK_BOT_TENANT_ACCESS_TOKEN',
          rawMessage: 'Lark outbound update skipped because bot token is not configured.',
          retriable: false,
        },
      };
    }

    const response = await fetch(`${this.apiBaseUrl}/open-apis/im/v1/messages/${input.messageId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.tenantAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: JSON.stringify({ text: input.text }),
      }),
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      return {
        channel: this.channel,
        status: 'failed',
        messageId: input.messageId,
        providerResponse: payload,
        error: {
          type: 'API_ERROR',
          classifiedReason: 'Lark update message API request failed',
          rawMessage: readString(payload.msg) ?? response.statusText,
          retriable: response.status >= 500,
        },
      };
    }

    return {
      channel: this.channel,
      status: 'updated',
      messageId: input.messageId,
      providerResponse: payload,
    };
  }
}
