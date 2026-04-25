import type { LarkMessagingClientPort } from '../../../../application/orchestration/tools/families/lark-messaging.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';
import type { Logger } from '../../../../shared/logger';

interface LarkMessagingClientDeps {
  appId: string;
  appSecret: string;
  logger: Logger;
}

interface SendMessageResult {
  messageId: string;
}

/**
 * Thin HTTP client for Lark messaging APIs.
 * All business logic lives in LarkChannelAdapter, not here.
 */
export class LarkMessagingClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly logger: Logger;
  private tenantToken?: string;
  private tokenExpiresAt = 0;

  constructor(deps: LarkMessagingClientDeps) {
    this.appId = deps.appId;
    this.appSecret = deps.appSecret;
    this.logger = deps.logger.child({ larkClient: 'messaging' });
  }

  async sendMessage(
    receiveId: string,
    content: string,
    replyToMessageId?: string,
    replyInThread?: boolean,
  ): Promise<SendMessageResult> {
    const token = await this.getToken();
    const url = 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id';

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

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Lark sendMessage failed: ${res.status} ${JSON.stringify(data)}`);
    }

    const msgData = data['data'] as Record<string, unknown>;
    return { messageId: msgData['message_id'] as string };
  }

  async updateMessage(messageId: string, content: string): Promise<void> {
    const token = await this.getToken();
    const url = `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}`;

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

    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: apiContent }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(`Lark updateMessage failed: ${res.status} ${JSON.stringify(data)}`);
    }
  }

  /**
   * Send an interactive card to a specific user by their Lark open_id (DM).
   * Uses receive_id_type=open_id so we don't need a chat_id.
   */
  async sendCardToOpenId(openId: string, cardContent: string): Promise<{ messageId: string }> {
    const token = await this.getToken();
    const url = 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id';

    let msgType = 'interactive';
    let apiContent = cardContent;
    try {
      const wrapper = JSON.parse(cardContent) as Record<string, unknown>;
      if (typeof wrapper['msg_type'] === 'string') {
        msgType = wrapper['msg_type'];
        if (msgType === 'interactive' && wrapper['card'] !== undefined) {
          apiContent = typeof wrapper['card'] === 'string'
            ? wrapper['card']
            : JSON.stringify(wrapper['card']);
        }
      }
    } catch { /* send as-is */ }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receive_id: openId, content: apiContent, msg_type: msgType }),
    });

    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Lark sendCardToOpenId failed: ${res.status} ${JSON.stringify(data)}`);
    }
    const msgData = data['data'] as Record<string, unknown>;
    return { messageId: msgData['message_id'] as string };
  }

  async addReaction(messageId: string, reactionType: string): Promise<void> {
    const token = await this.getToken();
    const url = `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reactions`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction_type: { emoji_type: reactionType } }),
    });
  }

  private async getToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.tenantToken;
    }
    const res = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || data['code'] !== 0) {
      throw new Error(`Failed to get Lark tenant token: ${JSON.stringify(data)}`);
    }
    this.tenantToken = data['tenant_access_token'] as string;
    this.tokenExpiresAt = Date.now() + ((data['expire'] as number) * 1000);
    return this.tenantToken;
  }
}

// ── Tool-facing client (implements LarkMessagingClientPort) ────────────────

export class LarkToolMessagingClient implements LarkMessagingClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async sendMessage(chatId: string, text: string): Promise<{ messageId: string }> {
    type SendResponse = { message_id?: string; message?: Record<string, unknown> };
    const data = await this.http.request<SendResponse>(
      'POST',
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      { body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) } },
    );
    return { messageId: (data.message_id ?? (data.message as Record<string, unknown>)?.['message_id'] ?? '') as string };
  }

  async replyMessage(messageId: string, text: string): Promise<{ messageId: string }> {
    type ReplyResponse = { message_id?: string };
    const data = await this.http.request<ReplyResponse>(
      'POST',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { body: { msg_type: 'text', content: JSON.stringify({ text }) } },
    );
    return { messageId: (data.message_id ?? '') as string };
  }

  async listMessages(chatId: string, limit?: number): Promise<Array<{ messageId: string; text: string; senderId: string; timestamp: string }>> {
    type ListResponse = { items?: Array<Record<string, unknown>> };
    const data = await this.http.request<ListResponse>(
      'GET',
      `/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}`,
      { query: { page_size: limit ?? 20 } },
    );
    return (data.items ?? []).map(m => ({
      messageId: m['message_id'] as string ?? '',
      text: (() => { try { return (JSON.parse(m['body'] as string ?? '{}') as Record<string, unknown>)['text'] as string ?? ''; } catch { return ''; } })(),
      senderId: (m['sender'] as Record<string, unknown>)?.['id'] as string ?? '',
      timestamp: m['create_time'] as string ?? '',
    }));
  }

  async getMessage(messageId: string): Promise<{ messageId: string; text: string; senderId: string; timestamp: string }> {
    type GetResponse = { items?: Array<Record<string, unknown>> };
    const data = await this.http.request<GetResponse>(
      'GET',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    );
    const m = (data.items ?? [])[0] ?? {};
    return {
      messageId: m['message_id'] as string ?? messageId,
      text: (() => { try { return (JSON.parse(m['body'] as string ?? '{}') as Record<string, unknown>)['text'] as string ?? ''; } catch { return ''; } })(),
      senderId: (m['sender'] as Record<string, unknown>)?.['id'] as string ?? '',
      timestamp: m['create_time'] as string ?? '',
    };
  }
}
