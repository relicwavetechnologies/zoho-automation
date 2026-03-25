import type {
  ChannelAction,
  ChannelAdapter,
  ChannelOutboundMessage,
  ChannelOutboundResult,
  ChannelUpdateMessage,
} from '../base/channel-adapter';
import type { NormalizedIncomingMessageDTO } from '../../contracts';
import config from '../../../config';
import { logger } from '../../../utils/logger';
import { orangeDebug } from '../../../utils/orange-debug';
import type { LarkWebhookEnvelope } from './lark.types';
import { buildLarkTraceMeta } from './lark-observability';
import { larkTenantTokenService, LarkTenantTokenService } from './lark-tenant-token.service';
import { emitRuntimeTrace } from '../../observability';
import { inferLarkMessageType, parseLarkMessageContent } from './lark-message-content';

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

const readTenantKey = (envelope: LarkWebhookEnvelope): string | undefined =>
  readString(envelope.header?.tenant_key)
  ?? readString(envelope.header?.tenantKey)
  ?? readString(envelope.event?.tenant_key)
  ?? readString(envelope.event?.tenantKey)
  ?? readString(envelope.tenant_key)
  ?? readString(envelope.tenantKey)
  ?? readString(envelope.tenantKeyId);

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

const buildEgressTraceMeta = (input: {
  chatId?: string;
  messageId?: string;
  correlationId?: string;
}): Record<string, unknown> =>
  buildLarkTraceMeta({
    channel: 'lark',
    chatId: input.chatId,
    messageId: input.messageId,
    taskId: input.correlationId,
  });

const DEFAULT_LARK_CARD_TITLE = 'Divo AI';
const DEFAULT_LARK_CARD_TAG = 'Finance';
const MAX_LARK_CARD_SUMMARY_LENGTH = 160;
const MAX_LARK_MARKDOWN_ELEMENT_LENGTH = 1200;
const MAX_LARK_CARD_ELEMENT_COUNT = 30;

const normalizeLarkMarkdown = (value: string): string =>
  value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

const stripMarkdownForSummary = (value: string): string =>
  value
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>#-]+/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const extractTitleAndBodyFromMarkdown = (markdown: string): {
  title: string;
  body: string;
} => {
  const normalized = normalizeLarkMarkdown(markdown);
  if (!normalized) {
    return {
      title: DEFAULT_LARK_CARD_TITLE,
      body: 'No content available.',
    };
  }

  const lines = normalized.split('\n');
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyIndex === -1) {
    return {
      title: DEFAULT_LARK_CARD_TITLE,
      body: 'No content available.',
    };
  }

  const firstLine = lines[firstNonEmptyIndex]!.trim();
  const headingMatch = firstLine.match(/^#\s+(.+)$/);
  if (!headingMatch) {
    return {
      title: DEFAULT_LARK_CARD_TITLE,
      body: normalized,
    };
  }

  const body = lines
    .slice(0, firstNonEmptyIndex)
    .concat(lines.slice(firstNonEmptyIndex + 1))
    .join('\n')
    .trim();

  return {
    title: headingMatch[1].trim() || DEFAULT_LARK_CARD_TITLE,
    body: body || normalized,
  };
};

const buildLarkCardSummary = (title: string, body: string): string => {
  const summarySource = stripMarkdownForSummary(body) || stripMarkdownForSummary(title) || DEFAULT_LARK_CARD_TITLE;
  if (summarySource.length <= MAX_LARK_CARD_SUMMARY_LENGTH) {
    return summarySource;
  }
  return `${summarySource.slice(0, MAX_LARK_CARD_SUMMARY_LENGTH - 3)}...`;
};

const buildLarkMarkdownElementV2 = (content: string, options?: {
  textSize?: string;
  margin?: string;
}): Record<string, unknown> => ({
  tag: 'markdown',
  content,
  text_size: options?.textSize ?? 'normal',
  ...(options?.margin ? { margin: options.margin } : {}),
});

const MARKDOWN_TABLE_SEPARATOR_PATTERN = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;

const isMarkdownTableBlock = (block: string): boolean => {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.length >= 3
    && lines[0]!.includes('|')
    && MARKDOWN_TABLE_SEPARATOR_PATTERN.test(lines[1]!);
};

const splitMarkdownTableBlock = (block: string): string[] => {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 3) {
    return [block];
  }

  const [header, separator, ...rows] = lines;
  const prefix = `${header}\n${separator}`;
  if (prefix.length >= MAX_LARK_MARKDOWN_ELEMENT_LENGTH) {
    return [block];
  }

  const chunks: string[] = [];
  let current = prefix;
  for (const row of rows) {
    const candidate = `${current}\n${row}`;
    if (candidate.length <= MAX_LARK_MARKDOWN_ELEMENT_LENGTH) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    current = `${prefix}\n${row}`;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
};

const splitLarkMarkdownIntoElements = (content: string): string[] => {
  const normalized = normalizeLarkMarkdown(content);
  if (!normalized) {
    return ['No content available.'];
  }

  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return [normalized];
  }

  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (isMarkdownTableBlock(block)) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitMarkdownTableBlock(block));
      continue;
    }

    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= MAX_LARK_MARKDOWN_ELEMENT_LENGTH) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (block.length <= MAX_LARK_MARKDOWN_ELEMENT_LENGTH) {
      current = block;
      continue;
    }

    const lines = block.split('\n');
    let lineChunk = '';
    for (const line of lines) {
      const nextLineChunk = lineChunk ? `${lineChunk}\n${line}` : line;
      if (nextLineChunk.length <= MAX_LARK_MARKDOWN_ELEMENT_LENGTH) {
        lineChunk = nextLineChunk;
        continue;
      }
      if (lineChunk) {
        chunks.push(lineChunk);
      }
      if (line.length <= MAX_LARK_MARKDOWN_ELEMENT_LENGTH) {
        lineChunk = line;
        continue;
      }
      for (let offset = 0; offset < line.length; offset += MAX_LARK_MARKDOWN_ELEMENT_LENGTH) {
        chunks.push(line.slice(offset, offset + MAX_LARK_MARKDOWN_ELEMENT_LENGTH));
      }
      lineChunk = '';
    }
    if (lineChunk) {
      current = lineChunk;
    }
  }

  if (current) {
    chunks.push(current);
  }

  if (chunks.length <= MAX_LARK_CARD_ELEMENT_COUNT) {
    return chunks;
  }

  const kept = chunks.slice(0, MAX_LARK_CARD_ELEMENT_COUNT - 1);
  const overflowText = chunks.slice(MAX_LARK_CARD_ELEMENT_COUNT - 1).join('\n\n');
  kept.push(`${overflowText.slice(0, MAX_LARK_MARKDOWN_ELEMENT_LENGTH - 32)}\n\n_Continued in follow-up if needed._`);
  return kept;
};

const buildLarkButtonElementV2 = (action: ChannelAction, index: number): Record<string, unknown> => ({
  tag: 'button',
  element_id: `action_${index + 1}`,
  text: {
    tag: 'plain_text',
    content: action.label,
  },
  type:
    action.style === 'primary'
      ? 'primary_filled'
      : action.style === 'danger'
        ? 'danger_filled'
        : 'default',
  width: 'fill',
  behaviors: [
    {
      type: 'callback',
      value: { id: action.id, ...action.value },
    },
  ],
});

const buildLarkCardContent = (text: string, actions?: ChannelAction[]): Record<string, unknown> => {
  const { title, body } = extractTitleAndBodyFromMarkdown(text);
  const normalizedBody = normalizeLarkMarkdown(body);
  const elements: Array<Record<string, unknown>> = splitLarkMarkdownIntoElements(normalizedBody).map((chunk, index) =>
    buildLarkMarkdownElementV2(chunk, {
      textSize: 'normal',
      ...(index === 0 ? {} : { margin: '8px 0 0 0' }),
    }));

  if (actions && actions.length > 0) {
    elements.push(
      buildLarkMarkdownElementV2('---', { margin: '8px 0 4px 0' }),
    );
    elements.push(
      buildLarkMarkdownElementV2('**Actions**', { textSize: 'heading', margin: '0 0 4px 0' }),
    );
    elements.push(
      ...actions.map((action, index) => buildLarkButtonElementV2(action, index)),
    );
  }

  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward: true,
      summary: {
        content: buildLarkCardSummary(title, normalizedBody),
      },
    },
    header: {
      template: 'default',
      title: {
        tag: 'plain_text',
        content: DEFAULT_LARK_CARD_TITLE,
      },
      ...(title !== DEFAULT_LARK_CARD_TITLE
        ? {
          subtitle: {
            tag: 'plain_text',
            content: title,
          },
        }
        : {}),
      text_tag_list: [
        {
          tag: 'text_tag',
          text: {
            tag: 'plain_text',
            content: DEFAULT_LARK_CARD_TAG,
          },
          color: 'green',
        },
      ],
    },
    body: {
      vertical_spacing: '8px',
      padding: '12px 12px 12px 12px',
      elements,
    },
  };
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
    if (!envelope) {
      return null;
    }

    // Check if it's a card action
    const eventType = readString(envelope.header?.event_type);
    const nestedAction = envelope.event && typeof envelope.event === 'object' ? asRecord(envelope.event.action) : null;
    const cardAction = asRecord(envelope.action) ?? nestedAction;
    if (eventType === 'card.action.trigger' && cardAction) {
      const context = envelope.event?.context;
      const operator = envelope.event?.operator;
      const openId =
        readString(envelope.open_id)
        ?? readString(operator?.open_id)
        ?? readString(envelope.event?.operator?.operator_id?.open_id);
      const userId =
        readString(envelope.user_id)
        ?? readString(operator?.user_id)
        ?? readString(envelope.event?.operator?.operator_id?.user_id)
        ?? openId;
      const messageId =
        readString(envelope.open_message_id)
        ?? readString(context?.open_message_id)
        ?? readString((context as Record<string, unknown> | undefined)?.message_id)
        ?? readString((envelope.event as Record<string, unknown> | undefined)?.open_message_id)
        ?? readString(envelope.header?.event_id);
      const chatId =
        readString(envelope.open_chat_id)
        ?? readString(context?.open_chat_id)
        ?? readString((context as Record<string, unknown> | undefined)?.chat_id)
        ?? readString((envelope.event as Record<string, unknown> | undefined)?.open_chat_id)
        ?? messageId
        ?? userId;

      if (!userId || !chatId || !messageId) {
        return null;
      }

      const payloadText = JSON.stringify(cardAction.value ?? {});

      const normalized: NormalizedIncomingMessageDTO = {
        channel: 'lark',
        userId,
        chatId,
        chatType: 'p2p', // Interactive cards can be in groups, but p2p is a safe default fallback if unmarked
        messageId,
        timestamp: new Date().toISOString(),
        text: `[Interactive Card Action] ${payloadText}`,
        rawEvent: event,
        trace: {
          larkTenantKey: readTenantKey(envelope),
          larkOpenId: openId,
          larkUserId:
            readString(envelope.user_id)
            ?? readString(operator?.user_id),
        },
      };

      return Object.freeze(normalized);
    }

    if (!envelope?.event?.message) {
      return null;
    }

    const sender = envelope.event.sender;
    const message = envelope.event.message;

    const userId =
      readString(sender?.sender_id?.open_id) ??
      readString(sender?.sender_id?.user_id) ??
      readString(sender?.employee_id);
    const larkOpenId = readString(sender?.sender_id?.open_id);
    const larkUserId = readString(sender?.sender_id?.user_id);
    const chatId = readString(message.chat_id);
    const messageId = readString(message.message_id);
    const msgType = inferLarkMessageType({
      msgType: readString(message.msg_type),
      altMsgType: readString((message as Record<string, unknown>).message_type),
      content: message.content,
    });

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
      text: parseLarkMessageContent(message.content, msgType),
      rawEvent: event,
      trace: {
        larkTenantKey: readTenantKey(envelope),
        larkOpenId,
        larkUserId,
      },
    };

    return Object.freeze(normalized);
  }

  public async sendMessage(input: ChannelOutboundMessage): Promise<ChannelOutboundResult> {
    // Lark open_id values start with "ou_"; chat IDs start with "oc_".
    // When targeting a user directly (DM), switch the receive_id_type accordingly.
    const receiveIdType = input.chatId.startsWith('ou_') ? 'open_id' : 'chat_id';
    const isReply = Boolean(input.replyToMessageId?.trim());
    const requestPath = isReply
      ? `/open-apis/im/v1/messages/${input.replyToMessageId!.trim()}/reply`
      : `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
    const format = input.format ?? 'interactive';
    const body = {
      ...(isReply ? {} : { receive_id: input.chatId }),
      msg_type: format === 'text' ? 'text' : 'interactive',
      ...(isReply ? { reply_in_thread: input.replyInThread ?? true } : {}),
      content: JSON.stringify(
        format === 'text'
          ? { text: input.text }
          : buildLarkCardContent(input.text, input.actions),
      ),
    };
    logger.info('lark.egress.send.start', {
      ...buildEgressTraceMeta({
        chatId: input.chatId,
        correlationId: input.correlationId,
      }),
      receiveIdType,
      replyToMessageId: input.replyToMessageId ?? null,
      replyInThread: isReply ? (input.replyInThread ?? true) : null,
      format,
      requestPath,
      textLength: input.text.length,
      contentLength: typeof body.content === 'string' ? body.content.length : 0,
    });
    orangeDebug('lark.egress.send.start', {
      chatId: input.chatId,
      correlationId: input.correlationId,
      receiveIdType,
      format,
      textPreview: input.text.slice(0, 120),
    });

    const result = await this.requestWithTokenRetry({
      method: 'POST',
      requestPath,
      body,
      context: 'send',
      chatId: input.chatId,
    });

    if (!result.ok) {
      logger.warn('lark.egress.send.failed', {
        ...buildEgressTraceMeta({
          chatId: input.chatId,
          correlationId: input.correlationId,
        }),
        receiveIdType,
        format,
        requestPath,
        error: result.result.error,
      });
      emitRuntimeTrace({
        event: 'lark.egress.send.failed',
        level: 'warn',
        taskId: input.correlationId,
        metadata: {
          chatId: input.chatId,
          error: result.result.error,
        },
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
    logger.success('lark.egress.send.success', buildEgressTraceMeta({
      chatId: input.chatId,
      messageId: outbound.messageId,
      correlationId: input.correlationId,
    }));
    orangeDebug('lark.egress.send.success', {
      chatId: input.chatId,
      messageId: outbound.messageId,
      correlationId: input.correlationId,
    });
    emitRuntimeTrace({
      event: 'lark.egress.send.success',
      level: 'info',
      taskId: input.correlationId,
      messageId: outbound.messageId,
      metadata: {
        chatId: input.chatId,
      },
    });
    return outbound;
  }

  public async updateMessage(input: ChannelUpdateMessage): Promise<ChannelOutboundResult> {
    const format = input.format ?? 'interactive';
    logger.info('lark.egress.update.start', {
      ...buildEgressTraceMeta({
        messageId: input.messageId,
        correlationId: input.correlationId,
      }),
      requestPath: `/open-apis/im/v1/messages/${input.messageId}`,
      format,
      textLength: input.text.length,
      contentLength:
        format === 'text'
          ? JSON.stringify({ text: input.text }).length
          : JSON.stringify(buildLarkCardContent(input.text, input.actions)).length,
    });
    orangeDebug('lark.egress.update.start', {
      messageId: input.messageId,
      correlationId: input.correlationId,
      format,
      textPreview: input.text.slice(0, 120),
    });
    const result = await this.requestWithTokenRetry({
      method: 'PATCH',
      requestPath: `/open-apis/im/v1/messages/${input.messageId}`,
      body: {
        msg_type: format === 'text' ? 'text' : 'interactive',
        content: JSON.stringify(
          format === 'text'
            ? { text: input.text }
            : buildLarkCardContent(input.text, input.actions),
        ),
      },
      context: 'update',
      messageId: input.messageId,
    });

    if (!result.ok) {
      logger.warn('lark.egress.update.failed', {
        ...buildEgressTraceMeta({
          messageId: input.messageId,
          correlationId: input.correlationId,
        }),
        requestPath: `/open-apis/im/v1/messages/${input.messageId}`,
        format,
        error: result.result.error,
      });
      emitRuntimeTrace({
        event: 'lark.egress.update.failed',
        level: 'warn',
        taskId: input.correlationId,
        messageId: input.messageId,
        metadata: {
          error: result.result.error,
        },
      });
      return result.result;
    }

    const outbound: ChannelOutboundResult = {
      channel: this.channel,
      status: 'updated' as const,
      messageId: input.messageId,
      providerResponse: result.payload,
    };
    logger.success('lark.egress.update.success', buildEgressTraceMeta({
      messageId: input.messageId,
      correlationId: input.correlationId,
    }));
    orangeDebug('lark.egress.update.success', {
      messageId: input.messageId,
      correlationId: input.correlationId,
    });
    emitRuntimeTrace({
      event: 'lark.egress.update.success',
      level: 'info',
      taskId: input.correlationId,
      messageId: input.messageId,
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

  /**
   * Downloads a file or image from Lark's message resources endpoint.
   * messageId  — the Lark message_id containing the file
   * fileKey    — the image_key or file_key from the content JSON
   * fileType   — 'image' | 'file' (determines which endpoint variant)
   */
  public async downloadFile(input: {
    messageId: string;
    fileKey: string;
    fileType: 'image' | 'file';
  }): Promise<{ buffer: Buffer; contentType: string } | null> {
    let token: string;
    try {
      token = await this.tokenService.getAccessToken();
    } catch (error) {
      logger.warn('lark.file.download.token_failed', { messageId: input.messageId, fileKey: input.fileKey, error });
      return null;
    }

    const url = `${this.apiBaseUrl}/open-apis/im/v1/messages/${input.messageId}/resources/${input.fileKey}?type=${input.fileType}`;
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        logger.warn('lark.file.download.failed', {
          messageId: input.messageId,
          fileKey: input.fileKey,
          status: response.status,
          statusText: response.statusText,
        });
        return null;
      }

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const arrayBuffer = await response.arrayBuffer();
      return { buffer: Buffer.from(arrayBuffer), contentType };
    } catch (error) {
      logger.warn('lark.file.download.error', { messageId: input.messageId, fileKey: input.fileKey, error });
      return null;
    }
  }
}
