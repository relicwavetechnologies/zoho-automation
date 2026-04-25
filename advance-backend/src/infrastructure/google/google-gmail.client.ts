/**
 * GmailClient — Gmail REST API client.
 *
 * Implements GmailClientPort (defined in google-gmail.tool.ts).
 * Takes a pre-resolved access token (caller is responsible for refreshing via GoogleOAuthService).
 *
 * API base: https://gmail.googleapis.com/gmail/v1/users/me
 * Auth: Authorization: Bearer {accessToken}
 */

import type { GmailClientPort } from '../../application/orchestration/tools/families/google-gmail.tool';

// ─── Constants ────────────────────────────────────────────────────────────────

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Extract a header value from a Gmail message part headers array. */
function getHeader(headers: unknown[], name: string): string {
  const lower = name.toLowerCase();
  const found = (headers as Array<Record<string, unknown>>).find(
    h => typeof h['name'] === 'string' && h['name'].toLowerCase() === lower,
  );
  return typeof found?.['value'] === 'string' ? found['value'] : '';
}

/** Decode base64url to a UTF-8 string. */
function decodeBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const rem    = padded.length % 4;
  const fixed  = rem === 0 ? padded : padded + '==='.slice(0, 4 - rem);
  try {
    return Buffer.from(fixed, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** Walk the MIME tree and extract plain-text or HTML body. */
function extractBody(payload: Record<string, unknown>): string {
  // Direct body on the payload
  const body = asRec(payload['body']);
  if (typeof body['data'] === 'string') {
    return decodeBase64Url(body['data']);
  }
  // Recurse through parts
  const parts = Array.isArray(payload['parts']) ? (payload['parts'] as unknown[]) : [];
  for (const part of parts) {
    const p    = asRec(part);
    const mime = typeof p['mimeType'] === 'string' ? p['mimeType'] : '';
    if (mime === 'text/plain' || mime === 'text/html') {
      const b = asRec(p['body']);
      if (typeof b['data'] === 'string') return decodeBase64Url(b['data']);
    }
    // Nested multipart
    if (mime.startsWith('multipart/')) {
      const nested = extractBody(p);
      if (nested) return nested;
    }
  }
  return '';
}

/** Convert a Gmail internalDate (ms-since-epoch string) to ISO-8601. */
function internalDateToIso(raw: unknown): string {
  if (typeof raw === 'string') {
    const ms = parseInt(raw, 10);
    if (!isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class GmailClient implements GmailClientPort {
  constructor(private readonly accessToken: string) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${GMAIL_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gmail API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async listMessages(
    limit = 10,
    query?: string,
  ): Promise<Array<{
    messageId: string;
    threadId:  string;
    subject:   string;
    from:      string;
    snippet:   string;
    timestamp: string;
    isUnread:  boolean;
  }>> {
    const params = new URLSearchParams({ maxResults: String(Math.min(limit, 50)) });
    if (query) params.set('q', query);

    const list = await this.call<Record<string, unknown>>(`/messages?${params}`);
    const msgs = Array.isArray(list['messages']) ? (list['messages'] as Array<Record<string, unknown>>) : [];

    const results = await Promise.allSettled(
      msgs.map(async m => {
        const id = typeof m['id'] === 'string' ? m['id'] : '';
        if (!id) return null;
        const msg = await this.call<Record<string, unknown>>(
          `/messages/${id}?format=metadata&metadataHeaders=Subject,From`,
        );
        const headers = Array.isArray(msg['payload'] && asRec(msg['payload'])['headers'])
          ? (asRec(msg['payload'])['headers'] as unknown[])
          : [];
        const labels = Array.isArray(msg['labelIds']) ? (msg['labelIds'] as string[]) : [];
        return {
          messageId: id,
          threadId:  typeof msg['threadId']  === 'string' ? msg['threadId']  : '',
          subject:   getHeader(headers, 'Subject') || '(no subject)',
          from:      getHeader(headers, 'From'),
          snippet:   typeof msg['snippet']   === 'string' ? msg['snippet']   : '',
          timestamp: internalDateToIso(msg['internalDate']),
          isUnread:  labels.includes('UNREAD'),
        };
      }),
    );

    type MsgRow = { messageId: string; threadId: string; subject: string; from: string; snippet: string; timestamp: string; isUnread: boolean };
    const out: MsgRow[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== null) {
        out.push(r.value as MsgRow);
      }
    }
    return out;
  }

  async getMessage(messageId: string): Promise<{
    messageId: string;
    threadId:  string;
    subject:   string;
    from:      string;
    to:        string[];
    body:      string;
    timestamp: string;
  }> {
    const msg     = await this.call<Record<string, unknown>>(`/messages/${messageId}?format=full`);
    const payload = asRec(msg['payload']);
    const headers = Array.isArray(payload['headers']) ? (payload['headers'] as unknown[]) : [];

    return {
      messageId,
      threadId:  typeof msg['threadId'] === 'string' ? msg['threadId'] : '',
      subject:   getHeader(headers, 'Subject') || '(no subject)',
      from:      getHeader(headers, 'From'),
      to:        getHeader(headers, 'To').split(',').map(s => s.trim()).filter(Boolean),
      body:      extractBody(payload).slice(0, 10_000),
      timestamp: internalDateToIso(msg['internalDate']),
    };
  }

  async sendMessage(params: {
    to:       string[];
    cc?:      string[];
    subject:  string;
    body:     string;
    threadId?: string;
  }): Promise<{ messageId: string }> {
    const headers = [
      `To: ${params.to.join(', ')}`,
      ...(params.cc?.length ? [`Cc: ${params.cc.join(', ')}`] : []),
      `Subject: ${params.subject}`,
      'Content-Type: text/plain; charset=UTF-8',
      'MIME-Version: 1.0',
    ].join('\r\n');

    const raw    = `${headers}\r\n\r\n${params.body}`;
    const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const body: Record<string, unknown> = { raw: encoded };
    if (params.threadId) body['threadId'] = params.threadId;

    const sent = await this.call<Record<string, unknown>>('/messages/send', {
      method: 'POST',
      body:   JSON.stringify(body),
    });

    const messageId = typeof sent['id'] === 'string' ? sent['id'] : '';
    if (!messageId) throw new Error('Gmail send: response missing message id');
    return { messageId };
  }

  async searchMessages(
    query: string,
    limit = 10,
  ): Promise<Array<{
    messageId: string;
    subject:   string;
    from:      string;
    snippet:   string;
    timestamp: string;
  }>> {
    const full = await this.listMessages(limit, query);
    return full.map(m => ({
      messageId: m.messageId,
      subject:   m.subject,
      from:      m.from,
      snippet:   m.snippet,
      timestamp: m.timestamp,
    }));
  }
}
