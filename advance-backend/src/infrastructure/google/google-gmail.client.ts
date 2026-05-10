/**
 * GmailClient — Gmail REST API client.
 *
 * API base: https://gmail.googleapis.com/gmail/v1/users/me
 * Auth: Authorization: Bearer {accessToken}
 */

import { EmailComposerService } from '../../application/email/email-composer.service';
import type { EmailAddress, DivoEmailTemplateData } from '../../application/email/email.types';
import type { ResolvedAttachment } from '../../application/email/attachment.types';
import type {
  GmailClientPort,
  GmailDraftDetail,
  GmailLabel,
  GmailMessageDetail,
  GmailMessageListItem,
  GmailThreadDetail,
  GmailThreadListItem,
} from '../../application/orchestration/tools/families/google-gmail.tool';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function getHeader(headers: unknown[], name: string): string {
  const lower = name.toLowerCase();
  const found = (headers as Array<Record<string, unknown>>).find(
    h => typeof h['name'] === 'string' && h['name'].toLowerCase() === lower,
  );
  return typeof found?.['value'] === 'string' ? found['value'] : '';
}

function decodeBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const rem = padded.length % 4;
  const fixed = rem === 0 ? padded : padded + '==='.slice(0, 4 - rem);
  try {
    return Buffer.from(fixed, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function extractBody(payload: Record<string, unknown>): string {
  const body = asRec(payload['body']);
  if (typeof body['data'] === 'string') return decodeBase64Url(body['data']);

  const parts = Array.isArray(payload['parts']) ? (payload['parts'] as unknown[]) : [];
  const preferred = parts.find(part => asRec(part)['mimeType'] === 'text/plain')
    ?? parts.find(part => asRec(part)['mimeType'] === 'text/html');
  if (preferred) {
    const preferredBody = asRec(asRec(preferred)['body']);
    if (typeof preferredBody['data'] === 'string') return decodeBase64Url(preferredBody['data']);
  }

  for (const part of parts) {
    const p = asRec(part);
    const mime = typeof p['mimeType'] === 'string' ? p['mimeType'] : '';
    if (mime.startsWith('multipart/')) {
      const nested = extractBody(p);
      if (nested) return nested;
    }
  }
  return '';
}

function internalDateToIso(raw: unknown): string {
  if (typeof raw === 'string') {
    const ms = parseInt(raw, 10);
    if (!isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

function splitAddresses(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizeSubjectForReply(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject || '(no subject)'}`;
}

function normalizeSubjectForForward(subject: string): string {
  return /^fwd?:/i.test(subject.trim()) ? subject : `Fwd: ${subject || '(no subject)'}`;
}

function parseEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase();
}

function uniqueAddresses(values: readonly string[], exclude: readonly string[] = []): string[] {
  const excluded = new Set(exclude.map(parseEmailAddress));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = parseEmailAddress(value);
    if (!key || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function toEmailAddresses(values: readonly string[] | undefined): EmailAddress[] {
  return (values ?? []).map(email => ({ email }));
}

function messageIdHeader(headers: unknown[]): string | undefined {
  const value = getHeader(headers, 'Message-ID');
  return value ? value.trim() : undefined;
}

export class GmailClient implements GmailClientPort {
  constructor(
    private readonly accessToken: string,
    private readonly composer = new EmailComposerService(),
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${GMAIL_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Gmail API ${res.status}: ${text.slice(0, 500)}`);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async listMessages(limit = 10, query?: string): Promise<GmailMessageListItem[]> {
    const params = new URLSearchParams({ maxResults: String(Math.min(limit, 50)) });
    if (query) params.set('q', query);

    const list = await this.call<Record<string, unknown>>(`/messages?${params}`);
    const msgs = Array.isArray(list['messages']) ? (list['messages'] as Array<Record<string, unknown>>) : [];
    const results = await Promise.allSettled(msgs.map(async m => {
      const id = typeof m['id'] === 'string' ? m['id'] : '';
      if (!id) return null;
      const msg = await this.call<Record<string, unknown>>(
        `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      );
      const payload = asRec(msg['payload']);
      const headers = Array.isArray(payload['headers']) ? (payload['headers'] as unknown[]) : [];
      const labels = Array.isArray(msg['labelIds']) ? (msg['labelIds'] as string[]) : [];
      return {
        messageId: id,
        threadId: typeof msg['threadId'] === 'string' ? msg['threadId'] : '',
        subject: getHeader(headers, 'Subject') || '(no subject)',
        from: getHeader(headers, 'From'),
        snippet: typeof msg['snippet'] === 'string' ? msg['snippet'] : '',
        timestamp: internalDateToIso(msg['internalDate']),
        isUnread: labels.includes('UNREAD'),
      };
    }));

    const out: GmailMessageListItem[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) out.push(result.value);
    }
    return out;
  }

  async getMessage(messageId: string): Promise<GmailMessageDetail> {
    const msg = await this.call<Record<string, unknown>>(`/messages/${messageId}?format=full`);
    return this.toMessageDetail(msg, messageId);
  }

  async searchMessages(query: string, limit = 10): Promise<GmailMessageListItem[]> {
    return this.listMessages(limit, query);
  }

  async sendMessage(params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body?: string;
    bodyHtml?: string;
    template?: DivoEmailTemplateData;
    threadId?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: readonly ResolvedAttachment[];
  }): Promise<{ messageId: string; threadId?: string }> {
    const built = this.buildRawMessage(params);
    const body: Record<string, unknown> = { raw: built.encodedRaw };
    if (params.threadId) body['threadId'] = params.threadId;

    const sent = await this.call<Record<string, unknown>>('/messages/send', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const messageId = typeof sent['id'] === 'string' ? sent['id'] : '';
    if (!messageId) throw new Error('Gmail send: response missing message id');
    return {
      messageId,
      ...(typeof sent['threadId'] === 'string' ? { threadId: sent['threadId'] } : {}),
    };
  }

  async createDraft(params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body?: string;
    bodyHtml?: string;
    template?: DivoEmailTemplateData;
    threadId?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: readonly ResolvedAttachment[];
  }): Promise<{ draftId: string; messageId?: string; threadId?: string }> {
    const built = this.buildRawMessage(params);
    const draft = await this.call<Record<string, unknown>>('/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw: built.encodedRaw, ...(params.threadId ? { threadId: params.threadId } : {}) } }),
    });
    return this.toDraftIds(draft, 'create');
  }

  async getDraft(draftId: string): Promise<GmailDraftDetail> {
    const draft = await this.call<Record<string, unknown>>(`/drafts/${encodeURIComponent(draftId)}?format=full`);
    return this.toDraftDetail(draft, draftId);
  }

  async updateDraft(draftId: string, params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body?: string;
    bodyHtml?: string;
    template?: DivoEmailTemplateData;
    threadId?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: readonly ResolvedAttachment[];
  }): Promise<{ draftId: string; messageId?: string; threadId?: string }> {
    const built = this.buildRawMessage(params);
    const draft = await this.call<Record<string, unknown>>(`/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT',
      body: JSON.stringify({ id: draftId, message: { raw: built.encodedRaw, ...(params.threadId ? { threadId: params.threadId } : {}) } }),
    });
    return this.toDraftIds(draft, 'update');
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.call<void>(`/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
  }

  async sendDraft(draftId: string): Promise<{ messageId: string; threadId?: string }> {
    const sent = await this.call<Record<string, unknown>>('/drafts/send', {
      method: 'POST',
      body: JSON.stringify({ id: draftId }),
    });
    const messageId = typeof sent['id'] === 'string' ? sent['id'] : '';
    if (!messageId) throw new Error('Gmail draft send: response missing message id');
    return {
      messageId,
      ...(typeof sent['threadId'] === 'string' ? { threadId: sent['threadId'] } : {}),
    };
  }

  async listThreads(limit = 10, query?: string): Promise<GmailThreadListItem[]> {
    const params = new URLSearchParams({ maxResults: String(Math.min(limit, 50)) });
    if (query) params.set('q', query);

    const list = await this.call<Record<string, unknown>>(`/threads?${params}`);
    const threads = Array.isArray(list['threads']) ? (list['threads'] as Array<Record<string, unknown>>) : [];
    const results = await Promise.allSettled(threads.map(async t => {
      const id = typeof t['id'] === 'string' ? t['id'] : '';
      if (!id) return null;
      const detail = await this.getThread(id);
      const latest = detail.messages.at(-1);
      return {
        threadId: id,
        messageCount: detail.messages.length,
        latestMessageId: latest?.messageId ?? '',
        subject: detail.subject,
        participants: detail.participants,
        snippet: detail.snippet,
        timestamp: latest?.timestamp ?? new Date().toISOString(),
      };
    }));

    const out: GmailThreadListItem[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) out.push(result.value);
    }
    return out;
  }

  async getThread(threadId: string): Promise<GmailThreadDetail> {
    const thread = await this.call<Record<string, unknown>>(`/threads/${encodeURIComponent(threadId)}?format=full`);
    const messagesRaw = Array.isArray(thread['messages']) ? (thread['messages'] as Record<string, unknown>[]) : [];
    const messages = messagesRaw.map(m => this.toMessageDetail(m));
    const participants = uniqueAddresses(messages.flatMap(m => [m.from, ...m.to, ...m.cc].filter(Boolean)));
    return {
      threadId,
      subject: messages[0]?.subject ?? '(no subject)',
      participants,
      snippet: typeof thread['snippet'] === 'string' ? thread['snippet'] : messages.at(-1)?.snippet ?? '',
      messages,
    };
  }

  async replyToMessage(messageId: string, params: {
    body?: string;
    bodyHtml?: string;
    template?: DivoEmailTemplateData;
    cc?: string[];
    bcc?: string[];
    replyAll?: boolean;
    attachments?: readonly ResolvedAttachment[];
  }): Promise<{ messageId: string; threadId?: string }> {
    const original = await this.getMessage(messageId);
    const profileEmail = await this.getProfileEmail().catch(() => '');
    const to = params.replyAll
      ? uniqueAddresses([original.from, ...original.to], [profileEmail])
      : uniqueAddresses([original.from], [profileEmail]);
    const cc = params.replyAll
      ? uniqueAddresses([...(params.cc ?? []), ...original.cc], [profileEmail, ...to])
      : params.cc;

    return this.sendMessage({
      to,
      ...(cc?.length ? { cc } : {}),
      ...(params.bcc?.length ? { bcc: params.bcc } : {}),
      subject: normalizeSubjectForReply(original.subject),
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.bodyHtml !== undefined ? { bodyHtml: params.bodyHtml } : {}),
      ...(params.template !== undefined ? { template: params.template } : {}),
      threadId: original.threadId,
      ...(original.rfcMessageId ? { inReplyTo: original.rfcMessageId } : {}),
      references: [...original.references, ...(original.rfcMessageId ? [original.rfcMessageId] : [])],
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
    });
  }

  async forwardMessage(messageId: string, params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
    bodyHtml?: string;
    template?: DivoEmailTemplateData;
    includeOriginal?: boolean;
    attachments?: readonly ResolvedAttachment[];
  }): Promise<{ messageId: string; threadId?: string }> {
    const original = await this.getMessage(messageId);
    const forwardText = params.includeOriginal === false
      ? params.body
      : [
        params.body,
        '---------- Forwarded message ---------',
        `From: ${original.from}`,
        `Date: ${original.timestamp}`,
        `Subject: ${original.subject}`,
        `To: ${original.to.join(', ')}`,
        '',
        original.body,
      ].filter(Boolean).join('\n');

    return this.sendMessage({
      to: params.to,
      ...(params.cc?.length ? { cc: params.cc } : {}),
      ...(params.bcc?.length ? { bcc: params.bcc } : {}),
      subject: params.subject ?? normalizeSubjectForForward(original.subject),
      ...(forwardText !== undefined ? { body: forwardText } : {}),
      ...(params.bodyHtml !== undefined ? { bodyHtml: params.bodyHtml } : {}),
      ...(params.template !== undefined ? { template: params.template } : {}),
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
    });
  }

  async listLabels(): Promise<GmailLabel[]> {
    const res = await this.call<Record<string, unknown>>('/labels');
    const labels = Array.isArray(res['labels']) ? (res['labels'] as Record<string, unknown>[]) : [];
    return labels.map(label => ({
      id: typeof label['id'] === 'string' ? label['id'] : '',
      name: typeof label['name'] === 'string' ? label['name'] : '',
      type: typeof label['type'] === 'string' ? label['type'] : '',
    })).filter(label => label.id && label.name);
  }

  async applyLabels(messageIds: string[], labelIds: string[], labelNames?: string[]): Promise<{ modified: number; labelIds: string[] }> {
    const resolvedLabelIds = await this.resolveLabelIds(labelIds, labelNames);
    await Promise.all(messageIds.map(id => this.modifyMessageLabels(id, resolvedLabelIds, [])));
    return { modified: messageIds.length, labelIds: resolvedLabelIds };
  }

  async removeLabels(messageIds: string[], labelIds: string[], labelNames?: string[]): Promise<{ modified: number; labelIds: string[] }> {
    const resolvedLabelIds = await this.resolveLabelIds(labelIds, labelNames);
    await Promise.all(messageIds.map(id => this.modifyMessageLabels(id, [], resolvedLabelIds)));
    return { modified: messageIds.length, labelIds: resolvedLabelIds };
  }

  async archiveMessages(messageIds: string[]): Promise<{ modified: number }> {
    await Promise.all(messageIds.map(id => this.modifyMessageLabels(id, [], ['INBOX'])));
    return { modified: messageIds.length };
  }

  async markRead(messageIds: string[]): Promise<{ modified: number }> {
    await Promise.all(messageIds.map(id => this.modifyMessageLabels(id, [], ['UNREAD'])));
    return { modified: messageIds.length };
  }

  async markUnread(messageIds: string[]): Promise<{ modified: number }> {
    await Promise.all(messageIds.map(id => this.modifyMessageLabels(id, ['UNREAD'], [])));
    return { modified: messageIds.length };
  }

  async starMessages(messageIds: string[]): Promise<{ modified: number }> {
    await Promise.all(messageIds.map(id => this.modifyMessageLabels(id, ['STARRED'], [])));
    return { modified: messageIds.length };
  }

  async unstarMessages(messageIds: string[]): Promise<{ modified: number }> {
    await Promise.all(messageIds.map(id => this.modifyMessageLabels(id, [], ['STARRED'])));
    return { modified: messageIds.length };
  }

  async trashMessages(messageIds: string[]): Promise<{ modified: number }> {
    await Promise.all(messageIds.map(id => this.call<Record<string, unknown>>(`/messages/${encodeURIComponent(id)}/trash`, { method: 'POST' })));
    return { modified: messageIds.length };
  }

  async untrashMessages(messageIds: string[]): Promise<{ modified: number }> {
    await Promise.all(messageIds.map(id => this.call<Record<string, unknown>>(`/messages/${encodeURIComponent(id)}/untrash`, { method: 'POST' })));
    return { modified: messageIds.length };
  }

  private buildRawMessage(params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body?: string;
    bodyHtml?: string;
    template?: DivoEmailTemplateData;
    threadId?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: readonly ResolvedAttachment[];
  }): { encodedRaw: string } {
    return this.composer.compose({
      to: toEmailAddresses(params.to),
      ...(params.cc?.length ? { cc: toEmailAddresses(params.cc) } : {}),
      ...(params.bcc?.length ? { bcc: toEmailAddresses(params.bcc) } : {}),
      subject: params.subject,
      ...(params.body !== undefined ? { text: params.body } : {}),
      ...(params.bodyHtml !== undefined ? { html: params.bodyHtml } : {}),
      ...(params.template !== undefined ? { template: params.template } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.inReplyTo ? { inReplyTo: params.inReplyTo } : {}),
      ...(params.references?.length ? { references: params.references } : {}),
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
    });
  }

  private toMessageDetail(msg: Record<string, unknown>, fallbackId?: string): GmailMessageDetail {
    const payload = asRec(msg['payload']);
    const headers = Array.isArray(payload['headers']) ? (payload['headers'] as unknown[]) : [];
    const messageId = typeof msg['id'] === 'string' ? msg['id'] : fallbackId ?? '';
    const rawReferences = getHeader(headers, 'References');
    const labelIds = Array.isArray(msg['labelIds']) ? (msg['labelIds'] as string[]) : [];
    const rfcMessageId = messageIdHeader(headers);
    return {
      messageId,
      threadId: typeof msg['threadId'] === 'string' ? msg['threadId'] : '',
      ...(rfcMessageId ? { rfcMessageId } : {}),
      references: rawReferences ? rawReferences.split(/\s+/).filter(Boolean) : [],
      subject: getHeader(headers, 'Subject') || '(no subject)',
      from: getHeader(headers, 'From'),
      snippet: typeof msg['snippet'] === 'string' ? msg['snippet'] : '',
      isUnread: labelIds.includes('UNREAD'),
      to: splitAddresses(getHeader(headers, 'To')),
      cc: splitAddresses(getHeader(headers, 'Cc')),
      bcc: splitAddresses(getHeader(headers, 'Bcc')),
      body: extractBody(payload).slice(0, 20_000),
      timestamp: internalDateToIso(msg['internalDate']),
      labelIds,
    };
  }

  private toDraftIds(draft: Record<string, unknown>, op: string): { draftId: string; messageId?: string; threadId?: string } {
    const draftId = typeof draft['id'] === 'string' ? draft['id'] : '';
    if (!draftId) throw new Error(`Gmail draft ${op}: response missing draft id`);
    const message = asRec(draft['message']);
    return {
      draftId,
      ...(typeof message['id'] === 'string' ? { messageId: message['id'] } : {}),
      ...(typeof message['threadId'] === 'string' ? { threadId: message['threadId'] } : {}),
    };
  }

  private toDraftDetail(draft: Record<string, unknown>, fallbackId: string): GmailDraftDetail {
    const message = asRec(draft['message']);
    return {
      draftId: typeof draft['id'] === 'string' ? draft['id'] : fallbackId,
      message: this.toMessageDetail(message),
    };
  }

  private async modifyMessageLabels(messageId: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    await this.call<Record<string, unknown>>(`/messages/${encodeURIComponent(messageId)}/modify`, {
      method: 'POST',
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }

  private async resolveLabelIds(labelIds: string[], labelNames: string[] | undefined): Promise<string[]> {
    if (!labelNames?.length) return labelIds;
    const labels = await this.listLabels();
    const byName = new Map(labels.map(label => [label.name.toLowerCase(), label.id]));
    const resolved = labelNames.map(name => byName.get(name.toLowerCase()) ?? name);
    return uniqueAddresses([...labelIds, ...resolved]);
  }

  private async getProfileEmail(): Promise<string> {
    const profile = await this.call<Record<string, unknown>>('/profile');
    return typeof profile['emailAddress'] === 'string' ? profile['emailAddress'] : '';
  }
}
