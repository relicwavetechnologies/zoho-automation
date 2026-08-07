import type {
  LarkMessageRendering,
  LarkMessagingClientPort,
} from '../../../../application/tools/families/lark-messaging.tool';
import type { Client } from '@larksuiteoapi/node-sdk';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';
import type { Logger } from '../../../../shared/logger';
import { planFinalCards } from '../lark-card.builder';
import { extractInteractiveCardText } from '../lark-message-content';
import { sha256 } from '../../../../shared/hash';

/**
 * Lark's own ceiling on the de-duplication key it accepts.
 *
 * Documented as `uuid`, "the max len is 50". Over it Lark refuses the whole
 * request with `99992402 field validation failed` before looking at anything
 * else.
 */
const LARK_MESSAGE_UUID_MAX_LENGTH = 50;

/**
 * A caller's idempotency key, made into something Lark will accept.
 *
 * Callers key their own retries however suits them, and Mail Ops keys a
 * delivery as `mail:` plus a sha256 — sixty-nine characters. Passed through
 * whole that is nineteen characters past Lark's limit, so every Lark delivery
 * a mail rule ever attempted was refused outright, five times over, from the
 * feature's first day. Nothing about it was intermittent: the request never
 * reached the point of having a message to send.
 *
 * Hashed rather than truncated, because a prefix is only unique if the caller's
 * keys happen to differ early, and that is a property of somebody else's key
 * scheme rather than something this boundary can promise. The digest is
 * deterministic, so a retry of the same delivery still de-duplicates against
 * the attempt before it — which is the whole reason the key is sent at all.
 */
export function larkMessageUuid(idempotencyKey: string): string {
  if (idempotencyKey.length <= LARK_MESSAGE_UUID_MAX_LENGTH) return idempotencyKey;
  return sha256(idempotencyKey).slice(0, LARK_MESSAGE_UUID_MAX_LENGTH);
}

/**
 * Accept either a raw card body or the `{ msg_type, card }` envelope the card
 * builders produce, and return what the messages API wants. Shared so a card
 * sent to a chat and the same card sent to a person cannot disagree about how
 * to unwrap it.
 */
function unwrapCardPayload(cardContent: string): { msgType: string; apiContent: string } {
  try {
    const wrapper = JSON.parse(cardContent) as Record<string, unknown>;
    if (typeof wrapper['msg_type'] === 'string') {
      const msgType = wrapper['msg_type'];
      if (msgType === 'interactive' && wrapper['card'] !== undefined) {
        return {
          msgType,
          apiContent: typeof wrapper['card'] === 'string'
            ? wrapper['card']
            : JSON.stringify(wrapper['card']),
        };
      }
      return { msgType, apiContent: cardContent };
    }
  } catch { /* send as-is */ }
  return { msgType: 'interactive', apiContent: cardContent };
}

interface LarkMessagingClientDeps {
  appId: string;
  appSecret: string;
  logger: Logger;
  apiBaseUrl?: string;
  sdkClient?: Pick<Client, 'request'>;
}

interface SendMessageResult {
  messageId: string;
}

interface BotIdentity {
  openId: string;
  name?: string;
}

export interface LarkThreadMessage {
  readonly messageId: string;
  readonly text: string;
  readonly senderId: string;
  readonly senderName?: string;
  readonly timestamp: string;
}

export interface LarkInteractiveMessageCard {
  readonly chatId: string;
  readonly card: Record<string, unknown>;
}

export type LarkChatMode = 'p2p' | 'group' | 'topic';

const MAX_CHAT_MEMBER_PAGES = 20;

/**
 * SDK-backed client for Lark bot messaging APIs.
 * All business logic lives in LarkChannelAdapter, not here.
 */
export class LarkMessagingClient {
  private readonly logger: Logger;
  private readonly sdk: LarkHttpClient;

  constructor(deps: LarkMessagingClientDeps) {
    this.logger = deps.logger.child({ larkClient: 'messaging' });
    this.sdk = new LarkHttpClient({
      appId: deps.appId,
      appSecret: deps.appSecret,
      ...(deps.apiBaseUrl ? { apiBaseUrl: deps.apiBaseUrl } : {}),
      ...(deps.sdkClient ? { sdkClient: deps.sdkClient } : {}),
    });
  }

  async getBotIdentity(): Promise<BotIdentity> {
    const data = await this.sdk.request<{
      bot?: { open_id?: string; bot_name?: string };
    }>('GET', '/open-apis/bot/v3/info');
    const openId = data.bot?.open_id?.trim();
    if (!openId) throw new Error('Lark bot identity response did not include open_id');
    return {
      openId,
      ...(data.bot?.bot_name ? { name: data.bot.bot_name } : {}),
    };
  }

  async listThreadMessages(threadId: string, limit = 12): Promise<LarkThreadMessage[]> {
    type ListResponse = { items?: Array<Record<string, unknown>> };
    const data = await this.sdk.request<ListResponse>(
      'GET',
      '/open-apis/im/v1/messages',
      {
        query: {
          container_id_type: 'thread',
          container_id: threadId,
          sort_type: 'ByCreateTimeDesc',
          page_size: Math.min(50, Math.max(1, limit)),
          with_sender_name: 'true',
        },
      },
    );
    return (data.items ?? []).map(message => messageFromLarkApi(message));
  }

  async getInteractiveMessageCard(messageId: string): Promise<LarkInteractiveMessageCard> {
    const data = await this.sdk.request<{
      items?: Array<{
        chat_id?: string;
        msg_type?: string;
        body?: { content?: unknown };
      }>;
    }>('GET', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
    const message = data.items?.[0];
    const chatId = message?.chat_id?.trim();
    if (!message || message.msg_type !== 'interactive' || !chatId) {
      throw new Error('Lark message response did not include an interactive card');
    }
    const parsed = typeof message.body?.content === 'string'
      ? JSON.parse(message.body.content) as unknown
      : message.body?.content;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Lark interactive message did not include a valid card body');
    }
    return { chatId, card: parsed as Record<string, unknown> };
  }

  /** Resolve the provider-authoritative mode for one exact chat. */
  async getChatMode(chatId: string): Promise<LarkChatMode> {
    const data = await this.sdk.request<{ chat_mode?: string }>(
      'GET',
      `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
    );
    const mode = data.chat_mode?.trim();
    if (mode === 'p2p' || mode === 'group' || mode === 'topic') return mode;
    throw new Error(`Lark chat response did not include a supported chat_mode for ${chatId}`);
  }

  /** Resolve an exact chat's live open-ID membership with bounded pagination. */
  async listChatMemberOpenIds(chatId: string, limit = 1_000): Promise<string[]> {
    const boundedLimit = Math.min(1_000, Math.max(1, limit));
    const members = new Set<string>();
    let pageToken: string | undefined;
    let pageCount = 0;

    while (members.size < boundedLimit) {
      if (pageCount >= MAX_CHAT_MEMBER_PAGES) {
        throw new Error(`Lark chat membership exceeded ${MAX_CHAT_MEMBER_PAGES} pages`);
      }
      pageCount += 1;
      type ListMembersResponse = {
        items?: Array<{ member_id?: string }>;
        has_more?: boolean;
        page_token?: string;
      };
      const data = await this.sdk.request<ListMembersResponse>(
        'GET',
        `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`,
        {
          query: {
            member_id_type: 'open_id',
            page_size: Math.min(100, boundedLimit - members.size),
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
      );
      for (const item of data.items ?? []) {
        const openId = item.member_id?.trim();
        if (openId) members.add(openId);
      }
      if (!data.has_more) return [...members];
      const nextPageToken = data.page_token?.trim();
      if (!nextPageToken || nextPageToken === pageToken) {
        throw new Error('Lark chat membership pagination did not advance');
      }
      pageToken = nextPageToken;
    }

    if (members.size >= boundedLimit) {
      throw new Error(`Lark chat membership exceeds the bounded limit of ${boundedLimit}`);
    }
    return [...members];
  }

  /**
   * @param idempotencyKey Passed to Lark as `uuid`. Lark deduplicates sends
   *   carrying the same value, which closes the window this cannot close on its
   *   own: a send that succeeds at Lark but whose HTTP response is lost looks
   *   identical to a send that never happened, and retrying it would post a
   *   second copy of the same reply. Max 50 characters.
   */
  async sendMessage(
    receiveId: string,
    content: string,
    replyToMessageId?: string,
    replyInThread?: boolean,
    idempotencyKey?: string,
  ): Promise<SendMessageResult> {
    // The adapter builders embed { msg_type, content|card } in the content string.
    // Parse it here so the Lark API gets the right msg_type and the correct inner content.
    let msgType = 'text';
    let apiContent = content;
    try {
      const wrapper = JSON.parse(content) as Record<string, unknown>;
      if (typeof wrapper['msg_type'] === 'string') {
        msgType = wrapper['msg_type'];
        if (msgType === 'interactive' && wrapper['card'] !== undefined) {
          // Interactive card: inner payload is in the 'card' key
          apiContent = typeof wrapper['card'] === 'string'
            ? wrapper['card']
            : JSON.stringify(wrapper['card']);
        } else if (wrapper['content'] !== undefined) {
          // Text / other: inner payload is in the 'content' key
          apiContent = typeof wrapper['content'] === 'string'
            ? wrapper['content']
            : JSON.stringify(wrapper['content']);
        }
      }
    } catch { /* not a wrapper — send as-is */ }

    if (msgType === 'text') {
      try {
        const parsedTextContent = JSON.parse(apiContent) as unknown;
        if (
          parsedTextContent === null
          || typeof parsedTextContent !== 'object'
          || Array.isArray(parsedTextContent)
        ) {
          apiContent = JSON.stringify({ text: apiContent });
        }
      } catch {
        apiContent = JSON.stringify({ text: apiContent });
      }
    }

    const body: Record<string, unknown> = {
      content:  apiContent,
      msg_type: msgType,
    };
    if (replyToMessageId) {
      body['reply_in_thread'] = replyInThread ?? true;
    } else {
      body['receive_id'] = receiveId;
    }
    if (idempotencyKey) {
      body['uuid'] = larkMessageUuid(idempotencyKey);
    }

    const path = replyToMessageId
      ? `/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`
      : '/open-apis/im/v1/messages';
    const data = await this.sdk.request<{ message_id?: string }>(
      'POST',
      path,
      replyToMessageId
        ? { body }
        : { query: { receive_id_type: 'chat_id' }, body },
    );
    return { messageId: data.message_id ?? '' };
  }

  async updateMessage(messageId: string, content: string): Promise<void> {
    // Same wrapper extraction as sendMessage — builders embed {msg_type, card|content}.
    // Lark PATCH endpoint expects only the inner card/content JSON as the `content` field.
    let apiContent = content;
    try {
      const wrapper = JSON.parse(content) as Record<string, unknown>;
      if (wrapper['card'] !== undefined) {
        apiContent = typeof wrapper['card'] === 'string'
          ? wrapper['card']
          : JSON.stringify(wrapper['card']);
      } else if (wrapper['content'] !== undefined) {
        apiContent = typeof wrapper['content'] === 'string'
          ? wrapper['content']
          : JSON.stringify(wrapper['content']);
      }
    } catch { /* not a wrapper — send as-is */ }

    await this.sdk.request(
      'PATCH',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { body: { content: apiContent } },
    );
  }

  /**
   * Send an interactive card to a specific user by their Lark open_id (DM).
   * Uses receive_id_type=open_id so we don't need a chat_id.
   */
  async sendCardToOpenId(openId: string, cardContent: string): Promise<{ messageId: string }> {
    const { msgType, apiContent } = unwrapCardPayload(cardContent);

    const data = await this.sdk.request<{ message_id?: string }>(
      'POST',
      '/open-apis/im/v1/messages',
      {
        query: { receive_id_type: 'open_id' },
        body: { receive_id: openId, content: apiContent, msg_type: msgType },
      },
    );
    return { messageId: data.message_id ?? '' };
  }

  /**
   * Send a prebuilt interactive card to a chat.
   *
   * Same payload handling as `sendCardToOpenId`, addressed by `chat_id` so one
   * caller works for a DM and a group alike — a card that only reaches direct
   * chats would silently degrade to nothing in the group case.
   */
  async sendCardToChat(
    chatId: string,
    cardContent: string,
    replyToMessageId?: string,
    replyInThread?: boolean,
  ): Promise<{ messageId: string }> {
    return this.sendMessage(chatId, cardContent, replyToMessageId, replyInThread);
  }

  async addReaction(messageId: string, reactionType: string): Promise<void> {
    await this.sdk.request(
      'POST',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      { body: { reaction_type: { emoji_type: reactionType } } },
    );
  }
}

// ── Tool-facing client (implements LarkMessagingClientPort) ────────────────

export class LarkToolMessagingClient implements LarkMessagingClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: { rendering?: LarkMessageRendering },
  ): Promise<{ messageId: string }> {
    return this.sendToRecipient({
      receiveId: chatId,
      receiveIdType: 'chat_id',
      text,
      rendering: options?.rendering ?? 'card',
    });
  }

  async replyMessage(
    messageId: string,
    text: string,
    options?: { rendering?: LarkMessageRendering },
  ): Promise<{ messageId: string }> {
    type ReplyResponse = { message_id?: string };
    const rendering = options?.rendering ?? 'card';
    if (rendering === 'text') {
      const data = await this.http.request<ReplyResponse>(
        'POST',
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
        { body: { msg_type: 'text', content: JSON.stringify({ text }) } },
      );
      return { messageId: data.message_id ?? '' };
    }

    let firstMessageId: string | undefined;
    for (const segment of planFinalCards({ markdown: text })) {
      const data = await this.http.request<ReplyResponse>(
        'POST',
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
        {
          body: {
            msg_type: 'interactive',
            content: unwrapInteractiveCardPayload(segment.payload),
          },
        },
      );
      const sentMessageId = data.message_id ?? '';
      if (!firstMessageId && sentMessageId) firstMessageId = sentMessageId;
    }
    return { messageId: firstMessageId ?? '' };
  }

  async listMessages(chatId: string, limit?: number): Promise<Array<{ messageId: string; text: string; senderId: string; timestamp: string }>> {
    type ListResponse = { items?: Array<Record<string, unknown>> };
    const data = await this.http.request<ListResponse>(
      'GET',
      '/open-apis/im/v1/messages',
      {
        query: {
          container_id_type: 'chat',
          container_id: chatId,
          sort_type: 'ByCreateTimeDesc',
          page_size: limit ?? 20,
        },
      },
    );
    return (data.items ?? []).map(message => messageFromLarkApi(message));
  }

  async sendDm(
    openId: string,
    text: string,
    options?: { rendering?: LarkMessageRendering },
  ): Promise<{ messageId: string }> {
    return this.sendToRecipient({
      receiveId: openId,
      receiveIdType: 'open_id',
      text,
      rendering: options?.rendering ?? 'card',
    });
  }

  async listChats(limit?: number): Promise<Array<{ chatId: string; name: string; type: string; memberCount?: number }>> {
    type ListChatsResponse = { items?: Array<Record<string, unknown>> };
    const data = await this.http.request<ListChatsResponse>(
      'GET',
      '/open-apis/im/v1/chats',
      { query: { page_size: limit ?? 20 } },
    );
    return (data.items ?? []).map(c => ({
      chatId:      c['chat_id'] as string ?? '',
      name:        c['name'] as string ?? '',
      type:        (c['chat_mode'] ?? c['chat_type'] ?? '') as string,
      ...(c['member_count'] !== undefined ? { memberCount: c['member_count'] as number } : {}),
    }));
  }

  async mentionMessage(
    chatId: string,
    text: string,
    mentionOpenIds: string[],
    options?: { rendering?: LarkMessageRendering },
  ): Promise<{ messageId: string }> {
    const rendering = options?.rendering ?? 'card';
    if (rendering === 'card') {
      const mentions = mentionOpenIds.map(toLarkMentionTag).join(' ');
      return this.sendToRecipient({
        receiveId: chatId,
        receiveIdType: 'chat_id',
        text: `${mentions}${mentions && text ? ' ' : ''}${text}`,
        rendering,
      });
    }

    const elements: Array<Record<string, unknown>> = [];
    for (const userId of mentionOpenIds) {
      elements.push({ tag: 'at', user_id: userId });
      elements.push({ tag: 'text', text: ' ' });
    }
    if (text) elements.push({ tag: 'text', text });
    const postContent = JSON.stringify({ zh_cn: { title: '', content: [elements] } });
    type SendResponse = { message_id?: string; message?: Record<string, unknown> };
    const data = await this.http.request<SendResponse>(
      'POST',
      '/open-apis/im/v1/messages',
      {
        query: { receive_id_type: 'chat_id' },
        body: { receive_id: chatId, msg_type: 'post', content: postContent },
      },
    );
    return { messageId: (data.message_id ?? (data.message as Record<string, unknown>)?.['message_id'] ?? '') as string };
  }

  private async sendToRecipient(input: {
    receiveId: string;
    receiveIdType: 'chat_id' | 'open_id';
    text: string;
    rendering: LarkMessageRendering;
  }): Promise<{ messageId: string }> {
    type SendResponse = { message_id?: string; message?: Record<string, unknown> };
    const query = { receive_id_type: input.receiveIdType };
    if (input.rendering === 'text') {
      const data = await this.http.request<SendResponse>(
        'POST',
        '/open-apis/im/v1/messages',
        {
          query,
          body: { receive_id: input.receiveId, msg_type: 'text', content: JSON.stringify({ text: input.text }) },
        },
      );
      return { messageId: messageIdFromSendResponse(data) };
    }

    let firstMessageId: string | undefined;
    for (const segment of planFinalCards({ markdown: input.text })) {
      const data = await this.http.request<SendResponse>(
        'POST',
        '/open-apis/im/v1/messages',
        {
          query,
          body: {
            receive_id: input.receiveId,
            msg_type: 'interactive',
            content: unwrapInteractiveCardPayload(segment.payload),
          },
        },
      );
      const sentMessageId = messageIdFromSendResponse(data);
      if (!firstMessageId && sentMessageId) firstMessageId = sentMessageId;
    }
    return { messageId: firstMessageId ?? '' };
  }

  async searchMessages(chatId: string, query: string, limit?: number): Promise<Array<{ messageId: string; text: string; senderId: string; timestamp: string }>> {
    type SearchResponse = {
      items?: Array<Record<string, unknown>>;
      page_token?: string;
      has_more?: boolean;
    };
    const target = Math.min(50, Math.max(1, limit ?? 20));
    const needle = query.trim().toLocaleLowerCase();
    const matches: ToolMessage[] = [];
    const maxScanned = 500;
    let scanned = 0;
    let pageToken: string | undefined;

    // Lark's history endpoint has no server-side text query. Search a bounded,
    // newest-first history window locally instead of pretending the provider
    // performed a semantic search.
    do {
      const data = await this.http.request<SearchResponse>(
        'GET',
        '/open-apis/im/v1/messages',
        {
          query: {
            container_id_type: 'chat',
            container_id: chatId,
            sort_type: 'ByCreateTimeDesc',
            page_size: Math.min(50, maxScanned - scanned),
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
      );
      const messages = (data.items ?? []).map(message => messageFromLarkApi(message));
      scanned += messages.length;
      matches.push(...messages.filter(message => message.text.toLocaleLowerCase().includes(needle)));
      pageToken = data.has_more && matches.length < target && scanned < maxScanned
        ? data.page_token
        : undefined;
    } while (pageToken);

    return matches.slice(0, target);
  }
}

function messageIdFromSendResponse(data: { message_id?: string; message?: Record<string, unknown> }): string {
  return (data.message_id ?? data.message?.['message_id'] ?? '') as string;
}

function toLarkMentionTag(openId: string): string {
  // Lark open IDs are generated identifiers. Reject anything that could alter
  // the card's Markdown markup if a malformed resolver implementation is used.
  if (!/^[A-Za-z0-9_-]+$/.test(openId)) {
    throw new Error('Invalid Lark open ID for card mention');
  }
  return `<at id=${openId}></at>`;
}

function unwrapInteractiveCardPayload(payload: string): string {
  const wrapper = JSON.parse(payload) as Record<string, unknown>;
  const card = wrapper['card'];
  return typeof card === 'string' ? card : JSON.stringify(card);
}

type ToolMessage = {
  messageId: string;
  text: string;
  senderId: string;
  senderName?: string;
  timestamp: string;
};

function messageFromLarkApi(message: Record<string, unknown>, fallbackMessageId = ''): ToolMessage {
  const messageType = stringValue(message['msg_type']);
  const content = parseLarkMessageBody(message['body']);
  const sender = recordValue(message['sender']);

  return {
    messageId: stringValue(message['message_id']) || fallbackMessageId,
    text: extractLarkMessageText(messageType, content),
    senderId: stringValue(sender?.['id']),
    ...(stringValue(sender?.['sender_name'])
      ? { senderName: stringValue(sender?.['sender_name']) }
      : {}),
    timestamp: stringValue(message['create_time']),
  };
}

/**
 * Lark message responses put the JSON payload in `body.content`. `body` itself
 * is an object, so parsing it directly coerces it to "[object Object]" and
 * silently discards every message through the previous error fallback.
 */
function parseLarkMessageBody(body: unknown): Record<string, unknown> {
  const bodyRecord = recordValue(body);
  const content = bodyRecord?.['content'] ?? body;
  if (recordValue(content)) return recordValue(content) ?? {};
  if (typeof content !== 'string') return {};

  try {
    return recordValue(JSON.parse(content)) ?? {};
  } catch {
    return {};
  }
}

function extractLarkMessageText(messageType: string, content: Record<string, unknown>): string {
  switch (messageType) {
    case 'text':
      return stringValue(content['text']) || '[Empty text message]';
    case 'post': {
      const text = extractPostText(content);
      return text || '[Empty rich-text message]';
    }
    case 'interactive': {
      const text = extractInteractiveCardText(content);
      return text || '[Interactive card]';
    }
    case 'image':
      return '[Image]';
    case 'file':
      return `[File: ${stringValue(content['file_name']) || 'attachment'}]`;
    case 'audio':
      return '[Audio]';
    case 'media':
      return '[Media]';
    case 'sticker':
      return '[Sticker]';
    default:
      return messageType ? `[${messageType} message]` : '[Lark message with unreadable content]';
  }
}

function extractPostText(content: Record<string, unknown>): string {
  const localized = postContentForLocale(content);
  const parts: string[] = [];
  const title = stringValue(localized['title']);
  if (title) parts.push(title);

  const rows = localized['content'];
  if (!Array.isArray(rows)) return parts.join('\n');
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const line = row.map(extractPostBlockText).filter(Boolean).join('');
    if (line) parts.push(line);
  }
  return parts.join('\n');
}

function postContentForLocale(content: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(content['content'])) return content;
  for (const value of Object.values(content)) {
    const localized = recordValue(value);
    if (localized && Array.isArray(localized['content'])) return localized;
  }
  return content;
}

function extractPostBlockText(block: unknown): string {
  const value = recordValue(block);
  if (!value) return '';
  switch (stringValue(value['tag'])) {
    case 'text':
      return stringValue(value['text']);
    case 'at':
      return `@${stringValue(value['user_name']) || 'someone'}`;
    case 'a':
      return stringValue(value['text']) || stringValue(value['href']);
    case 'img':
      return '[Image]';
    case 'media':
      return '[Media]';
    default:
      return '';
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
