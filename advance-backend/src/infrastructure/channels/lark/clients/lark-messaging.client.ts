import type {
  LarkMessageRendering,
  LarkMessagingClientPort,
} from '../../../../application/orchestration/tools/families/lark-messaging.tool';
import type { Client } from '@larksuiteoapi/node-sdk';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';
import type { Logger } from '../../../../shared/logger';
import { planFinalCards } from '../lark-card.builder';

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

    const body: Record<string, unknown> = {
      receive_id: receiveId,
      content:    apiContent,
      msg_type:   msgType,
    };
    if (replyToMessageId) {
      body['reply_in_thread'] = replyInThread ?? true;
      body['quote_reply_msg_id'] = replyToMessageId;
    }
    if (idempotencyKey) {
      body['uuid'] = idempotencyKey;
    }

    const data = await this.sdk.request<{ message_id?: string }>(
      'POST',
      '/open-apis/im/v1/messages',
      { query: { receive_id_type: 'chat_id' }, body },
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
  async sendCardToChat(chatId: string, cardContent: string): Promise<{ messageId: string }> {
    const { msgType, apiContent } = unwrapCardPayload(cardContent);
    const data = await this.sdk.request<{ message_id?: string }>(
      'POST',
      '/open-apis/im/v1/messages',
      {
        query: { receive_id_type: 'chat_id' },
        body: { receive_id: chatId, content: apiContent, msg_type: msgType },
      },
    );
    return { messageId: data.message_id ?? '' };
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

function extractInteractiveCardText(card: Record<string, unknown>): string {
  const parts: string[] = [];
  collectCardText(card, parts, new WeakSet<object>());
  return parts.join('\n');
}

function collectCardText(value: unknown, parts: string[], visited: WeakSet<object>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectCardText(entry, parts, visited);
    return;
  }

  const record = recordValue(value);
  if (!record || visited.has(record)) return;
  visited.add(record);

  const tag = stringValue(record['tag']);
  if (tag === 'markdown' || tag === 'lark_md' || tag === 'plain_text') {
    addText(parts, record['content']);
    return;
  }
  if (tag === 'text') {
    addText(parts, record['content']);
    addText(parts, record['text']);
    return;
  }

  if (tag === 'div' || tag === 'button' || tag === 'confirm') {
    collectCardText(record['text'], parts, visited);
  }

  // These are the containers and text-bearing fields defined by Lark Card 2.0.
  // Deliberately do not walk every property: that would expose opaque IDs,
  // URLs, or hidden card state to the agent.
  for (const key of ['header', 'title', 'body', 'elements', 'fields', 'columns', 'extra', 'confirm'] as const) {
    collectCardText(record[key], parts, visited);
  }
}

function addText(parts: string[], value: unknown): void {
  const text = stringValue(value).trim();
  if (text && parts[parts.length - 1] !== text) parts.push(text);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
