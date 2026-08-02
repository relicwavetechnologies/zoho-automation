import { createHash } from 'node:crypto';
import type {
  MailMessageMetadata,
  NewMailEvent,
} from '../../application/mail-ops/mail-ops.types';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_HISTORY_PAGES = 10;
const MAX_RECOVERY_MESSAGES = 100;
/**
 * How many `format=full` message fetches run at once.
 *
 * One history pass can name a thousand messages, and firing a thousand
 * concurrent requests at Gmail exhausts the per-user quota and gets the whole
 * batch throttled — which fails the sync and leaves the cursor where it was, so
 * the next pass does exactly the same thing.
 */
const MESSAGE_FETCH_CONCURRENCY = 6;
const MAX_BODY_CHARS = 50_000;

export interface GmailHistorySync {
  nextHistoryId: string;
  events: NewMailEvent[];
  staleCursorRecovered: boolean;
  /**
   * More history was waiting than one pass is willing to read. The cursor
   * returned is a real position part-way through the backlog, so the caller
   * should come straight back rather than wait for the next reconciliation.
   */
  truncated: boolean;
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
        truncated: false,
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
    mailboxEmail: string;
    sourceMessageId: string;
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
    const source = await this.getJson<{ raw?: string }>(
      `${GMAIL_API}/messages/${encodeURIComponent(input.sourceMessageId)}?format=raw`,
      input.accessToken,
    );
    if (!source.raw) throw new Error('Gmail source message returned no raw MIME.');
    const raw = buildForwardMime({
      destination: input.destination,
      mailboxEmail: input.mailboxEmail,
      subject,
      messageId,
      source: input.source,
      sourceRaw: Buffer.from(source.raw, 'base64url'),
      idempotencyKey: input.idempotencyKey,
    });
    const sent = await this.getJson<{ id?: string }>(
      `${GMAIL_API}/messages/send`,
      input.accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ raw: raw.toString('base64url') }),
      },
    );
    if (!sent.id) throw new Error('Gmail send returned no message ID.');
    return sent.id;
  }

  /**
   * Drains history from `historyId` forward, up to a bounded number of pages.
   *
   * The bound used to throw. That wedged the mailbox permanently: the throw
   * failed the sync, the cursor stayed exactly where it was, and five minutes
   * later the same oversized range threw again — forever, on the busiest
   * mailboxes, which are the ones the feature exists for.
   *
   * It now stops and reports where it got to. The subtlety is *which* cursor
   * to report. `payload.historyId` is the mailbox's newest history ID, not the
   * end of the page — handing that back after reading ten pages of a fifteen
   * page backlog would silently skip the last five. So a truncated pass
   * returns the ID of the last history record it actually consumed, and the
   * caller comes straight back for the rest. Re-reading that one record is
   * harmless; events and deliveries are both deduplicated.
   */
  private async syncHistory(
    accessToken: string,
    historyId: string,
  ): Promise<GmailHistorySync> {
    const messageIds = new Set<string>();
    let nextHistoryId = historyId;
    /** Last record we definitely consumed — the only safe truncation cursor. */
    let lastRecordId: string | undefined;
    let truncated = false;
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
        if (history.id) lastRecordId = history.id;
        for (const added of history.messagesAdded ?? []) {
          if (added.message?.id) messageIds.add(added.message.id);
        }
      }
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
      if (page === MAX_HISTORY_PAGES - 1) {
        truncated = true;
        break;
      }
    }
    return {
      // A truncated pass that consumed no record at all leaves the cursor
      // untouched rather than guessing forward — repeating a pass is
      // recoverable, skipping mail is not.
      nextHistoryId: truncated ? lastRecordId ?? historyId : nextHistoryId,
      events: await this.loadEvents(accessToken, [...messageIds]),
      staleCursorRecovered: false,
      truncated,
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
      truncated: false,
    };
  }

  /**
   * Fetch every named message, a few at a time.
   *
   * A message that has gone missing between the history record and this fetch —
   * deleted, or moved by another client — is skipped rather than allowed to
   * fail the pass. It cannot be delivered by anyone, ever, and failing on it
   * would wedge the cursor: the next pass reads the same history, finds the same
   * dead message and dies the same way, while every later arrival waits behind
   * it.
   *
   * Every other failure still aborts the batch. Those are transient, and
   * skipping them would advance the cursor past mail nobody has read.
   */
  private async loadEvents(
    accessToken: string,
    ids: string[],
  ): Promise<NewMailEvent[]> {
    const events: NewMailEvent[] = [];
    for (let start = 0; start < ids.length; start += MESSAGE_FETCH_CONCURRENCY) {
      const batch = ids.slice(start, start + MESSAGE_FETCH_CONCURRENCY);
      const loaded = await Promise.all(
        batch.map(id => this.loadEvent(accessToken, id)),
      );
      for (const event of loaded) {
        if (event) events.push(event);
      }
    }
    return events;
  }

  private async loadEvent(
    accessToken: string,
    id: string,
  ): Promise<NewMailEvent | null> {
    let message: GmailMessage;
    try {
      message = await this.getJson<GmailMessage>(
        `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`,
        accessToken,
      );
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }
    return {
      providerMessageId: id,
      ...(message.threadId ? { providerThreadId: message.threadId } : {}),
      historyId: message.historyId ?? '0',
      metadata: messageMetadata(message),
      occurredAt: new Date(Number(message.internalDate ?? Date.now())),
    };
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

function buildForwardMime(input: {
  destination: string;
  mailboxEmail: string;
  subject: string;
  messageId: string;
  source: MailMessageMetadata;
  sourceRaw: Buffer;
  idempotencyKey: string;
}): Buffer {
  const original = splitRawMessage(input.sourceRaw);
  const contentHeaders = selectContentHeaders(original.headers);
  const boundary = `=_divo_${createHash('sha256')
    .update(input.idempotencyKey)
    .digest('hex')
    .slice(0, 32)}`;
  const intro = [
    'Forwarded by Divo Mail Ops',
    '',
    `From: ${sanitizeHeader(input.source.from)}`,
    `To: ${sanitizeHeader(input.source.to)}`,
    ...(input.source.date
      ? [`Date: ${sanitizeHeader(input.source.date)}`]
      : []),
    `Subject: ${sanitizeHeader(input.source.subject)}`,
  ].join('\r\n');
  const prefix = [
    `From: ${sanitizeHeader(input.mailboxEmail)}`,
    `To: ${sanitizeHeader(input.destination)}`,
    `Subject: ${sanitizeHeader(input.subject)}`,
    `Message-ID: ${input.messageId}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    intro,
    '',
    `--${boundary}`,
    ...contentHeaders,
    '',
    '',
  ].join('\r\n');
  const suffix = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([
    Buffer.from(prefix, 'utf8'),
    original.body,
    Buffer.from(suffix, 'utf8'),
  ]);
}

function splitRawMessage(raw: Buffer): {
  headers: string;
  body: Buffer;
} {
  const crlfBoundary = raw.indexOf(Buffer.from('\r\n\r\n'));
  const lfBoundary = raw.indexOf(Buffer.from('\n\n'));
  const useCrlf = crlfBoundary >= 0
    && (lfBoundary < 0 || crlfBoundary <= lfBoundary);
  const boundary = useCrlf ? crlfBoundary : lfBoundary;
  const separatorLength = useCrlf ? 4 : 2;
  if (boundary < 0) throw new Error('Gmail source message has invalid raw MIME.');
  return {
    headers: raw.subarray(0, boundary).toString('latin1'),
    body: raw.subarray(boundary + separatorLength),
  };
}

function selectContentHeaders(rawHeaders: string): string[] {
  const blocks: string[] = [];
  for (const line of rawHeaders.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line) && blocks.length > 0) {
      blocks[blocks.length - 1] += `\r\n${line}`;
    } else {
      blocks.push(line);
    }
  }
  const allowed = new Set([
    'content-type',
    'content-transfer-encoding',
    'content-language',
  ]);
  const selected = blocks.filter(block => {
    const separator = block.indexOf(':');
    return separator > 0
      && allowed.has(block.slice(0, separator).trim().toLocaleLowerCase());
  });
  if (!selected.some(block => /^content-type:/i.test(block))) {
    selected.unshift('Content-Type: text/plain; charset=UTF-8');
  }
  return selected;
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
