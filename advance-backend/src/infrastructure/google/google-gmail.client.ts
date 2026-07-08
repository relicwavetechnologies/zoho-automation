/**
 * GmailClient — Gmail client backed by @googleapis/gmail.
 */

import { gmail } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
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

function toOAuth2Client(auth: OAuth2Client | string): OAuth2Client {
  if (typeof auth !== 'string') return auth;
  const client = new OAuth2Client();
  client.setCredentials({ access_token: auth });
  return client;
}

export class GmailClient implements GmailClientPort {
  private readonly client;

  constructor(
    auth: string | OAuth2Client,
    private readonly composer = new EmailComposerService(),
  ) {
    this.client = gmail({ version: 'v1', auth: toOAuth2Client(auth) });
  }

  async listMessages(limit = 10, query?: string): Promise<GmailMessageListItem[]> {
    const list = await this.client.users.messages.list({
      userId: 'me',
      maxResults: Math.min(limit, 50),
      ...(query ? { q: query } : {}),
    });
    const msgs = list.data.messages ?? [];
    const results = await Promise.allSettled(msgs.map(async m => {
      const id = m.id ?? '';
      if (!id) return null;
      const msg = await this.client.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      });
      const data = msg.data as Record<string, unknown>;
      const payload = asRec(data['payload']);
      const headers = Array.isArray(payload['headers']) ? (payload['headers'] as unknown[]) : [];
      const labels = Array.isArray(data['labelIds']) ? (data['labelIds'] as string[]) : [];
      return {
        messageId: id,
        threadId: typeof data['threadId'] === 'string' ? data['threadId'] : '',
        subject: getHeader(headers, 'Subject') || '(no subject)',
        from: getHeader(headers, 'From'),
        snippet: typeof data['snippet'] === 'string' ? data['snippet'] : '',
        timestamp: internalDateToIso(data['internalDate']),
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
    const msg = await this.client.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    return this.toMessageDetail(msg.data as Record<string, unknown>, messageId);
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

    const sent = await this.client.users.messages.send({
      userId: 'me',
      requestBody: body,
    });

    const messageId = sent.data.id ?? '';
    if (!messageId) throw new Error('Gmail send: response missing message id');
    return {
      messageId,
      ...(sent.data.threadId ? { threadId: sent.data.threadId } : {}),
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
    const draft = await this.client.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: built.encodedRaw,
          ...(params.threadId ? { threadId: params.threadId } : {}),
        },
      },
    });
    return this.toDraftIds(draft.data as Record<string, unknown>, 'create');
  }

  async getDraft(draftId: string): Promise<GmailDraftDetail> {
    const draft = await this.client.users.drafts.get({ userId: 'me', id: draftId, format: 'full' });
    return this.toDraftDetail(draft.data as Record<string, unknown>, draftId);
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
    const draft = await this.client.users.drafts.update({
      userId: 'me',
      id: draftId,
      requestBody: {
        id: draftId,
        message: {
          raw: built.encodedRaw,
          ...(params.threadId ? { threadId: params.threadId } : {}),
        },
      },
    });
    return this.toDraftIds(draft.data as Record<string, unknown>, 'update');
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.client.users.drafts.delete({ userId: 'me', id: draftId });
  }

  async sendDraft(draftId: string): Promise<{ messageId: string; threadId?: string }> {
    const sent = await this.client.users.drafts.send({
      userId: 'me',
      requestBody: { id: draftId },
    });
    const messageId = sent.data.id ?? '';
    if (!messageId) throw new Error('Gmail draft send: response missing message id');
    return {
      messageId,
      ...(sent.data.threadId ? { threadId: sent.data.threadId } : {}),
    };
  }

  async listThreads(limit = 10, query?: string): Promise<GmailThreadListItem[]> {
    const list = await this.client.users.threads.list({
      userId: 'me',
      maxResults: Math.min(limit, 50),
      ...(query ? { q: query } : {}),
    });
    const threads = list.data.threads ?? [];
    const results = await Promise.allSettled(threads.map(async t => {
      const id = t.id ?? '';
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
    const res = await this.client.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    const thread = res.data as Record<string, unknown>;
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
    const res = await this.client.users.labels.list({ userId: 'me' });
    const labels = res.data.labels ?? [];
    return labels.map(label => ({
      id: label.id ?? '',
      name: label.name ?? '',
      type: label.type ?? '',
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
    await Promise.all(messageIds.map(id => this.client.users.messages.trash({ userId: 'me', id })));
    return { modified: messageIds.length };
  }

  async untrashMessages(messageIds: string[]): Promise<{ modified: number }> {
    await Promise.all(messageIds.map(id => this.client.users.messages.untrash({ userId: 'me', id })));
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
    await this.client.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds, removeLabelIds },
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
    const profile = await this.client.users.getProfile({ userId: 'me' });
    return profile.data.emailAddress ?? '';
  }
}
