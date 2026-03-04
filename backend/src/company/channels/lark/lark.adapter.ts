import type {
  ChannelAdapter,
  ChannelOutboundMessage,
  ChannelOutboundResult,
  ChannelUpdateMessage,
} from '../base/channel-adapter';
import type { NormalizedIncomingMessageDTO } from '../../contracts';
import config from '../../../config';
import { logger } from '../../../utils/logger';
import type { LarkWebhookEnvelope } from './lark.types';
import { larkTenantTokenService, LarkTenantTokenService } from './lark-tenant-token.service';

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
};

type LarkResponseLike = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
};

type LarkAdapterOptions = {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  tokenService?: Pick<LarkTenantTokenService, 'getAccessToken'>;
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

const buildApiErrorResult = (input: {
  context: 'send' | 'update';
  response: LarkResponseLike;
  payload: Record<string, unknown>;
  chatId?: string;
  messageId?: string;
}): ChannelOutboundResult => ({
  channel: 'lark',
  status: 'failed',
  chatId: input.chatId,
  messageId: input.messageId,
  providerResponse: input.payload,
  error: {
    type: 'API_ERROR',
    classifiedReason:
      input.context === 'send'
        ? 'Lark send message API request failed'
        : 'Lark update message API request failed',
    rawMessage: readString(input.payload.msg) ?? input.response.statusText,
    retriable: input.response.status >= 500,
  },
});

const isTokenInvalidFailure = (response: LarkResponseLike, payload: Record<string, unknown>): boolean => {
  if (response.status === 401) {
    return true;
  }

  const code = typeof payload.code === 'number' ? payload.code : undefined;
  if (code !== undefined && [99991661, 99991663, 99991668, 99991677].includes(code)) {
    return true;
  }

  const message = (readString(payload.msg) ?? '').toLowerCase();
  return message.includes('tenant_access_token') && (message.includes('invalid') || message.includes('expired'));
};

export class LarkChannelAdapter implements ChannelAdapter {
  public readonly channel = 'lark' as const;

  private readonly apiBaseUrl: string;

  private readonly fetchImpl: typeof fetch;

  private readonly tokenService: Pick<LarkTenantTokenService, 'getAccessToken'>;

  public constructor(options: LarkAdapterOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? config.LARK_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenService = options.tokenService ?? larkTenantTokenService;
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
    const requestPath = '/open-apis/im/v1/messages?receive_id_type=chat_id';
    const body = {
      receive_id: input.chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: input.text }),
    };

    const result = await this.requestWithTokenRetry({
      method: 'POST',
      requestPath,
      body,
      context: 'send',
      chatId: input.chatId,
    });

    if (!result.ok) {
      logger.warn('lark.send.failed', {
        chatId: input.chatId,
        correlationId: input.correlationId,
        error: result.result.error,
      });
      return result.result;
    }

    const data = asRecord(result.payload.data);
    const outbound: ChannelOutboundResult = {
      channel: this.channel,
      status: 'sent' as const,
      chatId: input.chatId,
      messageId: readString(data?.message_id),
      providerResponse: result.payload,
    };
    logger.success('lark.send.success', {
      chatId: input.chatId,
      correlationId: input.correlationId,
      messageId: outbound.messageId,
    });
    return outbound;
  }

  public async updateMessage(input: ChannelUpdateMessage): Promise<ChannelOutboundResult> {
    const result = await this.requestWithTokenRetry({
      method: 'PATCH',
      requestPath: `/open-apis/im/v1/messages/${input.messageId}`,
      body: {
        content: JSON.stringify({ text: input.text }),
      },
      context: 'update',
      messageId: input.messageId,
    });

    if (!result.ok) {
      logger.warn('lark.update.failed', {
        messageId: input.messageId,
        correlationId: input.correlationId,
        error: result.result.error,
      });
      return result.result;
    }

    const outbound: ChannelOutboundResult = {
      channel: this.channel,
      status: 'updated' as const,
      messageId: input.messageId,
      providerResponse: result.payload,
    };
    logger.success('lark.update.success', {
      messageId: input.messageId,
      correlationId: input.correlationId,
    });
    return outbound;
  }

  private async requestWithTokenRetry(input: {
    method: 'POST' | 'PATCH';
    requestPath: string;
    body: Record<string, unknown>;
    context: 'send' | 'update';
    chatId?: string;
    messageId?: string;
  }): Promise<
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; result: ChannelOutboundResult }
  > {
    let token: string;
    try {
      token = await this.tokenService.getAccessToken();
    } catch (error) {
        logger.error('lark.token.unavailable', {
          context: input.context,
          chatId: input.chatId,
          messageId: input.messageId,
          error,
        });
        return {
          ok: false,
          result: {
            channel: this.channel,
            status: 'failed',
            chatId: input.chatId,
            messageId: input.messageId,
            error: {
              type: 'API_ERROR',
              classifiedReason: 'lark_tenant_token_unavailable',
              rawMessage: error instanceof Error ? error.message : 'Lark tenant token unavailable',
              retriable: false,
            },
          },
        };
      }

      let firstAttempt = await this.performRequest(input, token);
      if (!firstAttempt.response.ok && isTokenInvalidFailure(firstAttempt.response, firstAttempt.payload)) {
        logger.warn('lark.token.refresh.required', {
          context: input.context,
          statusCode: firstAttempt.response.status,
          responseCode: firstAttempt.payload.code,
          responseMessage: firstAttempt.payload.msg,
        });
        try {
          token = await this.tokenService.getAccessToken({ forceRefresh: true });
        } catch (error) {
          logger.error('lark.token.refresh.failed', {
            context: input.context,
            chatId: input.chatId,
            messageId: input.messageId,
            error,
          });
          return {
            ok: false,
            result: {
              channel: this.channel,
              status: 'failed',
              chatId: input.chatId,
              messageId: input.messageId,
              providerResponse: firstAttempt.payload,
              error: {
                type: 'API_ERROR',
                classifiedReason: 'lark_tenant_token_refresh_failed',
                rawMessage: error instanceof Error ? error.message : 'Lark token refresh failed',
                retriable: true,
              },
            },
          };
        }
        firstAttempt = await this.performRequest(input, token);
      }

      if (!firstAttempt.response.ok) {
        logger.error('lark.api.request_failed', {
          context: input.context,
          statusCode: firstAttempt.response.status,
          statusText: firstAttempt.response.statusText,
          responseCode: firstAttempt.payload.code,
          responseMessage: firstAttempt.payload.msg,
          chatId: input.chatId,
          messageId: input.messageId,
        });
        return {
          ok: false,
          result: buildApiErrorResult({
            context: input.context,
            response: firstAttempt.response,
            payload: firstAttempt.payload,
            chatId: input.chatId,
            messageId: input.messageId,
          }),
        };
      }

      return {
        ok: true,
        payload: firstAttempt.payload,
      };
    }

    private async performRequest(
      input: {
        method: 'POST' | 'PATCH';
        requestPath: string;
        body: Record<string, unknown>;
      },
      token: string,
    ): Promise<{ response: LarkResponseLike; payload: Record<string, unknown> }> {
      const response = await this.fetchImpl(`${this.apiBaseUrl}${input.requestPath}`, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input.body),
      });

      let payload: Record<string, unknown> = {};
      try {
        const parsed = await response.json();
        payload = asRecord(parsed) ?? {};
      } catch {
        payload = {};
      }

      return {
        response,
        payload,
      };
    }
}
