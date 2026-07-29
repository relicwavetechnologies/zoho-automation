import type {
  MailMessageMetadata,
  NewMailEvent,
} from '../../application/mail-ops/mail-ops.types';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_HISTORY_PAGES = 10;
const MAX_RECOVERY_MESSAGES = 100;
const MAX_BODY_CHARS = 50_000;

export interface GmailHistorySync {
  nextHistoryId: string;
  events: NewMailEvent[];
  staleCursorRecovered: boolean;
}

export class GmailHistoryClient {
  constructor(
    private readonly request: typeof fetch = fetch,
  ) {}

  async sync(input: {
    accessToken: string;
    historyId?: string;
  }): Promise<GmailHistorySync> {
    if (!input.historyId) {
      const profile = await this.getJson<{ historyId?: string }>(
        `${GMAIL_API}/profile`,
        input.accessToken,
      );
      if (!profile.historyId) throw new Error('Gmail profile returned no historyId.');
      return {
        nextHistoryId: profile.historyId,
        events: [],
        staleCursorRecovered: false,
      };
    }

    try {
      return await this.syncHistory(input.accessToken, input.historyId);
    } catch (error) {
      if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
      return this.reconcileStaleCursor(input.accessToken);
    }
  }

  async watch(input: {
    accessToken: string;
    topicName: string;
  }): Promise<{ historyId: string; expiration: Date }> {
    const response = await this.getJson<{
      historyId?: string;
      expiration?: string;
    }>(`${GMAIL_API}/watch`, input.accessToken, {
      method: 'POST',
      body: JSON.stringify({
        topicName: input.topicName,
        labelIds: ['INBOX'],
        labelFilterBehavior: 'include',
      }),
    });
    if (!response.historyId || !response.expiration) {
      throw new Error('Gmail watch returned no historyId or expiration.');
    }
    const expiration = new Date(Number(response.expiration));
    if (Number.isNaN(expiration.getTime())) {
      throw new Error('Gmail watch returned an invalid expiration.');
    }
    return { historyId: response.historyId, expiration };
  }

  async forward(input: {
    accessToken: string;
    destination: string;
    source: MailMessageMetadata;
    idempotencyKey: string;
  }): Promise<string> {
    const messageId = `<${input.idempotencyKey.replace(/[^a-z0-9.-]/gi, '')}@mailops.divo>`;
    const query = new URLSearchParams({
      q: `in:sent rfc822msgid:${messageId}`,
      maxResults: '1',
    });
    const existing = await this.getJson<{ messages?: Array<{ id: string }> }>(
      `${GMAIL_API}/messages?${query}`,
      input.accessToken,
    );
    if (existing.messages?.[0]?.id) return existing.messages[0].id;

    const subject = /^fwd:/i.test(input.source.subject)
      ? input.source.subject
      : `Fwd: ${input.source.subject || '(no subject)'}`;
    const body = [
      'Forwarded by Divo Mail Ops',
      '',
      `From: ${input.source.from}`,
      `To: ${input.source.to}`,
      ...(input.source.date ? [`Date: ${input.source.date}`] : []),
      `Subject: ${input.source.subject}`,
      '',
      input.source.bodyText || input.source.snippet,
    ].join('\r\n');
    const raw = [
      `To: ${sanitizeHeader(input.destination)}`,
      `Subject: ${sanitizeHeader(subject)}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ].join('\r\n');
    const sent = await this.getJson<{ id?: string }>(
      `${GMAIL_API}/messages/send`,
      input.accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
      },
    );
    if (!sent.id) throw new Error('Gmail send returned no message ID.');
    return sent.id;
  }

  private async syncHistory(
    accessToken: string,
    historyId: string,
  ): Promise<GmailHistorySync> {
    const messageIds = new Set<string>();
    let nextHistoryId = historyId;
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const query = new URLSearchParams({
        startHistoryId: historyId,
        historyTypes: 'messageAdded',
        labelId: 'INBOX',
        maxResults: '100',
        ...(pageToken ? { pageToken } : {}),
      });
      const payload = await this.getJson<{
        historyId?: string;
        nextPageToken?: string;
        history?: Array<{
          id?: string;
          messagesAdded?: Array<{ message?: { id?: string } }>;
        }>;
      }>(`${GMAIL_API}/history?${query}`, accessToken);
      nextHistoryId = payload.historyId ?? nextHistoryId;
      for (const history of payload.history ?? []) {
        for (const added of history.messagesAdded ?? []) {
          if (added.message?.id) messageIds.add(added.message.id);
        }
      }
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
      if (page === MAX_HISTORY_PAGES - 1) {
        throw new Error('Gmail history exceeded the bounded page limit.');
      }
    }
    return {
      nextHistoryId,
      events: await this.loadEvents(accessToken, [...messageIds]),
      staleCursorRecovered: false,
    };
  }

  private async reconcileStaleCursor(
    accessToken: string,
  ): Promise<GmailHistorySync> {
    const query = new URLSearchParams({
      q: 'in:inbox newer_than:1d',
      maxResults: String(MAX_RECOVERY_MESSAGES),
    });
    const [profile, messages] = await Promise.all([
      this.getJson<{ historyId?: string }>(`${GMAIL_API}/profile`, accessToken),
      this.getJson<{ messages?: Array<{ id?: string }> }>(
        `${GMAIL_API}/messages?${query}`,
        accessToken,
      ),
    ]);
    if (!profile.historyId) throw new Error('Gmail profile returned no historyId.');
    const ids = (messages.messages ?? [])
      .map(message => message.id)
      .filter((id): id is string => Boolean(id));
    return {
      nextHistoryId: profile.historyId,
      events: await this.loadEvents(accessToken, ids),
      staleCursorRecovered: true,
    };
  }

  private async loadEvents(
    accessToken: string,
    ids: string[],
  ): Promise<NewMailEvent[]> {
    return Promise.all(ids.map(async id => {
      const message = await this.getJson<GmailMessage>(
        `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`,
        accessToken,
      );
      return {
        providerMessageId: id,
        ...(message.threadId ? { providerThreadId: message.threadId } : {}),
        historyId: message.historyId ?? '0',
        metadata: messageMetadata(message),
        occurredAt: new Date(Number(message.internalDate ?? Date.now())),
      };
    }));
  }

  private async getJson<T>(
    url: string,
    accessToken: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.request(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new GmailApiError(response.status, providerError(payload));
    }
    return payload as T;
  }
}

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
  headers?: Array<{ name?: string; value?: string }>;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  historyId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailMessagePart;
}

function messageMetadata(message: GmailMessage): MailMessageMetadata {
  const headers = new Map(
    (message.payload?.headers ?? []).map(header => [
      header.name?.toLocaleLowerCase() ?? '',
      header.value ?? '',
    ]),
  );
  return {
    from: headers.get('from') ?? '',
    to: headers.get('to') ?? '',
    subject: headers.get('subject') ?? '',
    ...(headers.get('date') ? { date: headers.get('date')! } : {}),
    snippet: message.snippet ?? '',
    bodyText: extractBody(message.payload).slice(0, MAX_BODY_CHARS),
    hasAttachment: hasAttachment(message.payload),
  };
}

function extractBody(part: GmailMessagePart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBody(part.body.data);
  }
  const plain = (part.parts ?? [])
    .map(child => extractBody(child))
    .find(Boolean);
  if (plain) return plain;
  if (part.mimeType === 'text/html' && part.body?.data) {
    return stripHtml(decodeBody(part.body.data));
  }
  return '';
}

function hasAttachment(part: GmailMessagePart | undefined): boolean {
  if (!part) return false;
  return Boolean(part.filename?.trim())
    || (part.parts ?? []).some(child => hasAttachment(child));
}

function decodeBody(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function providerError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'Gmail API request failed.';
  const error = (payload as Record<string, unknown>)['error'];
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return 'Gmail API request failed.';
}
