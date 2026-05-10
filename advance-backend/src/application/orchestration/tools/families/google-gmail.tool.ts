import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import type { DivoEmailTemplateData, DivoEmailTemplateVariant } from '../../../email/email.types';

const GmailOpSchema = z.enum([
  'list',
  'get',
  'search',
  'send',
  'reply',
  'reply_all',
  'forward',
  'thread_list',
  'thread_get',
  'draft_create',
  'draft_get',
  'draft_update',
  'draft_delete',
  'draft_send',
  'label_list',
  'label_apply',
  'label_remove',
  'archive',
  'mark_read',
  'mark_unread',
  'star',
  'unstar',
  'trash',
  'untrash',
]);

const DivoTemplateIdSchema = z.enum([
  'divo-standard-v1',
  'divo-executive-v1',
  'divo-proposal-v1',
  'divo-follow-up-v1',
  'divo-report-v1',
  'divo-finance-v1',
]);

const GmailArgsSchema = z.object({
  op: GmailOpSchema,
  messageId: z.string().optional(),
  messageIds: z.array(z.string()).optional(),
  threadId: z.string().optional(),
  draftId: z.string().optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  /** Legacy plain-text body field kept for backward compatibility. */
  body: z.string().optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  templateId: DivoTemplateIdSchema.optional(),
  templateData: z.record(z.unknown()).optional(),
  query: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  labelNames: z.array(z.string()).optional(),
  includeOriginal: z.boolean().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type GmailArgs = z.infer<typeof GmailArgsSchema>;

const GmailResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  message: z.string().optional(),
  messageId: z.string().optional(),
  draftId: z.string().optional(),
  threadId: z.string().optional(),
});
type GmailResult = z.infer<typeof GmailResultSchema>;

export interface GmailMessageListItem {
  readonly messageId: string;
  readonly threadId: string;
  readonly subject: string;
  readonly from: string;
  readonly snippet: string;
  readonly timestamp: string;
  readonly isUnread: boolean;
}

export interface GmailMessageDetail extends GmailMessageListItem {
  readonly rfcMessageId?: string;
  readonly references: readonly string[];
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly body: string;
  readonly labelIds: readonly string[];
}

export interface GmailDraftDetail {
  readonly draftId: string;
  readonly message: GmailMessageDetail;
}

export interface GmailThreadListItem {
  readonly threadId: string;
  readonly messageCount: number;
  readonly latestMessageId: string;
  readonly subject: string;
  readonly participants: readonly string[];
  readonly snippet: string;
  readonly timestamp: string;
}

export interface GmailThreadDetail {
  readonly threadId: string;
  readonly subject: string;
  readonly participants: readonly string[];
  readonly snippet: string;
  readonly messages: readonly GmailMessageDetail[];
}

export interface GmailLabel {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface GmailClientPort {
  listMessages(limit?: number, query?: string): Promise<GmailMessageListItem[]>;
  getMessage(messageId: string): Promise<GmailMessageDetail>;
  sendMessage(params: {
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
  }): Promise<{ messageId: string; threadId?: string }>;
  searchMessages(query: string, limit?: number): Promise<GmailMessageListItem[]>;
  createDraft(params: {
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
  }): Promise<{ draftId: string; messageId?: string; threadId?: string }>;
  getDraft(draftId: string): Promise<GmailDraftDetail>;
  updateDraft(draftId: string, params: {
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
  }): Promise<{ draftId: string; messageId?: string; threadId?: string }>;
  deleteDraft(draftId: string): Promise<void>;
  sendDraft(draftId: string): Promise<{ messageId: string; threadId?: string }>;
  listThreads(limit?: number, query?: string): Promise<GmailThreadListItem[]>;
  getThread(threadId: string): Promise<GmailThreadDetail>;
  replyToMessage(messageId: string, params: {
    body?: string;
    bodyHtml?: string;
    template?: DivoEmailTemplateData;
    cc?: string[];
    bcc?: string[];
    replyAll?: boolean;
  }): Promise<{ messageId: string; threadId?: string }>;
  forwardMessage(messageId: string, params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
    bodyHtml?: string;
    template?: DivoEmailTemplateData;
    includeOriginal?: boolean;
  }): Promise<{ messageId: string; threadId?: string }>;
  listLabels(): Promise<GmailLabel[]>;
  applyLabels(messageIds: string[], labelIds: string[], labelNames?: string[]): Promise<{ modified: number; labelIds: string[] }>;
  removeLabels(messageIds: string[], labelIds: string[], labelNames?: string[]): Promise<{ modified: number; labelIds: string[] }>;
  archiveMessages(messageIds: string[]): Promise<{ modified: number }>;
  markRead(messageIds: string[]): Promise<{ modified: number }>;
  markUnread(messageIds: string[]): Promise<{ modified: number }>;
  starMessages(messageIds: string[]): Promise<{ modified: number }>;
  unstarMessages(messageIds: string[]): Promise<{ modified: number }>;
  trashMessages(messageIds: string[]): Promise<{ modified: number }>;
  untrashMessages(messageIds: string[]): Promise<{ modified: number }>;
}

const inferAction = (op: GmailArgs['op']): ToolActionGroup => {
  if (op === 'send' || op === 'reply' || op === 'reply_all' || op === 'forward' || op === 'draft_send') return 'send';
  if (op === 'draft_create') return 'create';
  if (
    op === 'draft_update' || op === 'label_apply' || op === 'label_remove' ||
    op === 'archive' || op === 'mark_read' || op === 'mark_unread' ||
    op === 'star' || op === 'unstar' || op === 'trash' || op === 'untrash'
  ) return 'update';
  if (op === 'draft_delete') return 'delete';
  return 'read';
};

export const createGoogleGmailTool = (deps: {
  getClient: (companyId: string, userId: string) => Promise<GmailClientPort | null>;
}): Tool<GmailArgs, GmailResult> => ({
  id: asToolId('googleGmail'),
  family: 'google',
  actionGroups: new Set(['read', 'send', 'create', 'update', 'delete']),
  argsSchema: GmailArgsSchema,
  resultSchema: GmailResultSchema,
  description: 'List, read, search, draft, send, reply, reply-all, forward, thread, label, and organize Gmail messages. Attachments are intentionally deferred to Phase 2.',
  parameterDocs: `
- op: list | get | search | send | reply | reply_all | forward | thread_list | thread_get | draft_create | draft_get | draft_update | draft_delete | draft_send | label_list | label_apply | label_remove | archive | mark_read | mark_unread | star | unstar | trash | untrash
- messageId: Gmail message ID for get/reply/reply_all/forward or single-message mailbox actions
- messageIds: Gmail message IDs for batch mailbox actions
- threadId: Gmail thread ID for thread_get or legacy reply/send threading
- draftId: Gmail draft ID for draft get/update/delete/send
- to: Recipient email addresses for send/forward/draft_create/draft_update
- cc: CC recipient email addresses
- bcc: BCC recipient email addresses
- Recipient safety: every to/cc/bcc value must be a real resolved email. Placeholder/test domains are rejected; resolve named people through context/Lark contacts or ask the user.
- subject: Email subject
- body/bodyText: Plain-text email body. body is a legacy alias.
- bodyHtml: HTML body. Always provide bodyText too unless templateId is used.
- templateId/templateData: Divo branded HTML template selection and semantic data. Template IDs: divo-standard-v1, divo-executive-v1, divo-proposal-v1, divo-follow-up-v1, divo-report-v1, divo-finance-v1.
- query: Gmail search query string for search/thread_list/list
- labelIds/labelNames: Labels for label apply/remove flows
- includeOriginal: For forward, include original message metadata/body unless false
- inReplyTo/references: RFC reply headers for legacy thread sends
- limit: Max messages or threads (default 10)
  `.trim(),

  permissionCheck(args: GmailArgs, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action = inferAction(args.op);
    const allowed = perm.allowedActionsByTool.get(asToolId('googleGmail'))?.has(action) ?? false;
    if (!allowed) return err(new PermissionError({ toolId: 'googleGmail', action, reason: 'not_allowed' }));
    return ok(action);
  },

  async execute(args: GmailArgs, ctx: ToolExecutionContext): Promise<Result<GmailResult, ToolError>> {
    const client = await deps.getClient(ctx.runContext.companyId, ctx.runContext.userId);
    if (!client) {
      return err(new ToolError({ toolId: 'googleGmail', reason: 'unrecoverable', message: 'Google account not connected for this user' }));
    }

    try {
      switch (args.op) {
        case 'list': {
          const msgs = await client.listMessages(args.limit ?? 10, args.query);
          return ok({ success: true, data: msgs, message: `Found ${msgs.length} emails` });
        }
        case 'get': {
          if (!args.messageId) return badArgs('messageId required for get');
          const msg = await client.getMessage(args.messageId);
          return ok({ success: true, data: msg });
        }
        case 'search': {
          if (!args.query) return badArgs('query required for search');
          const msgs = await client.searchMessages(args.query, args.limit ?? 10);
          return ok({ success: true, data: msgs, message: `Found ${msgs.length} emails` });
        }
        case 'send': {
          const compose = requireComposedEmail(args, { requireTo: true, requireSubject: true });
          if (!compose.ok) return compose;
          const r = await client.sendMessage(compose.value);
          return ok({ success: true, messageId: r.messageId, threadId: r.threadId, message: 'Email sent' });
        }
        case 'draft_create': {
          const compose = requireComposedEmail(args, { requireTo: true, requireSubject: true });
          if (!compose.ok) return compose;
          const r = await client.createDraft(compose.value);
          return ok({ success: true, draftId: r.draftId, messageId: r.messageId, threadId: r.threadId, message: 'Draft created' });
        }
        case 'draft_get': {
          if (!args.draftId) return badArgs('draftId required for draft_get');
          return ok({ success: true, data: await client.getDraft(args.draftId) });
        }
        case 'draft_update': {
          if (!args.draftId) return badArgs('draftId required for draft_update');
          const compose = requireComposedEmail(args, { requireTo: true, requireSubject: true });
          if (!compose.ok) return compose;
          const r = await client.updateDraft(args.draftId, compose.value);
          return ok({ success: true, draftId: r.draftId, messageId: r.messageId, threadId: r.threadId, message: 'Draft updated' });
        }
        case 'draft_delete': {
          if (!args.draftId) return badArgs('draftId required for draft_delete');
          await client.deleteDraft(args.draftId);
          return ok({ success: true, draftId: args.draftId, message: 'Draft deleted' });
        }
        case 'draft_send': {
          if (!args.draftId) return badArgs('draftId required for draft_send');
          const r = await client.sendDraft(args.draftId);
          return ok({ success: true, messageId: r.messageId, threadId: r.threadId, draftId: args.draftId, message: 'Draft sent' });
        }
        case 'thread_list': {
          const threads = await client.listThreads(args.limit ?? 10, args.query);
          return ok({ success: true, data: threads, message: `Found ${threads.length} threads` });
        }
        case 'thread_get': {
          if (!args.threadId) return badArgs('threadId required for thread_get');
          return ok({ success: true, data: await client.getThread(args.threadId) });
        }
        case 'reply': {
          const body = bodyText(args);
          const template = buildTemplate(args, body);
          const recipients = validateProvidedRecipientEmails({
            ...(args.cc ? { cc: args.cc } : {}),
            ...(args.bcc ? { bcc: args.bcc } : {}),
          });
          if (!recipients.ok) return recipients;
          if (!body && !args.bodyHtml && !template) return badArgs('bodyText/body/bodyHtml/templateId required for reply');
          if (args.messageId) {
            const r = await client.replyToMessage(args.messageId, {
              ...(body !== undefined ? { body } : {}),
              ...(args.bodyHtml !== undefined ? { bodyHtml: args.bodyHtml } : {}),
              ...(template !== undefined ? { template } : {}),
              ...(args.cc?.length ? { cc: args.cc } : {}),
              ...(args.bcc?.length ? { bcc: args.bcc } : {}),
            });
            return ok({ success: true, messageId: r.messageId, threadId: r.threadId, message: 'Reply sent' });
          }
          const compose = requireComposedEmail(args, { requireTo: true, requireSubject: false, requireThread: true });
          if (!compose.ok) return compose;
          const r = await client.sendMessage({ ...compose.value, subject: args.subject ?? 'Re:' });
          return ok({ success: true, messageId: r.messageId, threadId: r.threadId, message: 'Reply sent' });
        }
        case 'reply_all': {
          if (!args.messageId) return badArgs('messageId required for reply_all');
          const body = bodyText(args);
          const template = buildTemplate(args, body);
          const recipients = validateProvidedRecipientEmails({
            ...(args.cc ? { cc: args.cc } : {}),
            ...(args.bcc ? { bcc: args.bcc } : {}),
          });
          if (!recipients.ok) return recipients;
          if (!body && !args.bodyHtml && !template) return badArgs('bodyText/body/bodyHtml/templateId required for reply_all');
          const r = await client.replyToMessage(args.messageId, {
            ...(body !== undefined ? { body } : {}),
            ...(args.bodyHtml !== undefined ? { bodyHtml: args.bodyHtml } : {}),
            ...(template !== undefined ? { template } : {}),
            ...(args.cc?.length ? { cc: args.cc } : {}),
            ...(args.bcc?.length ? { bcc: args.bcc } : {}),
            replyAll: true,
          });
          return ok({ success: true, messageId: r.messageId, threadId: r.threadId, message: 'Reply-all sent' });
        }
        case 'forward': {
          if (!args.messageId) return badArgs('messageId required for forward');
          if (!args.to?.length) return badArgs('to required for forward');
          const recipients = validateProvidedRecipientEmails({
            to: args.to,
            ...(args.cc ? { cc: args.cc } : {}),
            ...(args.bcc ? { bcc: args.bcc } : {}),
          });
          if (!recipients.ok) return recipients;
          const body = bodyText(args);
          const template = buildTemplate(args, body);
          const r = await client.forwardMessage(args.messageId, {
            to: args.to,
            ...(args.cc?.length ? { cc: args.cc } : {}),
            ...(args.bcc?.length ? { bcc: args.bcc } : {}),
            ...(args.subject ? { subject: args.subject } : {}),
            ...(body !== undefined ? { body } : {}),
            ...(args.bodyHtml !== undefined ? { bodyHtml: args.bodyHtml } : {}),
            ...(template !== undefined ? { template } : {}),
            ...(args.includeOriginal !== undefined ? { includeOriginal: args.includeOriginal } : {}),
          });
          return ok({ success: true, messageId: r.messageId, threadId: r.threadId, message: 'Email forwarded' });
        }
        case 'label_list':
          return ok({ success: true, data: await client.listLabels() });
        case 'label_apply': {
          const ids = messageIds(args);
          if (!ids.length) return badArgs('messageId or messageIds required for label_apply');
          if (!args.labelIds?.length && !args.labelNames?.length) return badArgs('labelIds or labelNames required for label_apply');
          return ok({ success: true, data: await client.applyLabels(ids, args.labelIds ?? [], args.labelNames), message: 'Labels applied' });
        }
        case 'label_remove': {
          const ids = messageIds(args);
          if (!ids.length) return badArgs('messageId or messageIds required for label_remove');
          if (!args.labelIds?.length && !args.labelNames?.length) return badArgs('labelIds or labelNames required for label_remove');
          return ok({ success: true, data: await client.removeLabels(ids, args.labelIds ?? [], args.labelNames), message: 'Labels removed' });
        }
        case 'archive':
          return mailboxAction(args, ids => client.archiveMessages(ids), 'Archived');
        case 'mark_read':
          return mailboxAction(args, ids => client.markRead(ids), 'Marked read');
        case 'mark_unread':
          return mailboxAction(args, ids => client.markUnread(ids), 'Marked unread');
        case 'star':
          return mailboxAction(args, ids => client.starMessages(ids), 'Starred');
        case 'unstar':
          return mailboxAction(args, ids => client.unstarMessages(ids), 'Unstarred');
        case 'trash':
          return mailboxAction(args, ids => client.trashMessages(ids), 'Moved to trash');
        case 'untrash':
          return mailboxAction(args, ids => client.untrashMessages(ids), 'Restored from trash');
        default:
          return badArgs(`Gmail operation "${args.op}" is not handled by this client.`);
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'googleGmail', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});

function bodyText(args: GmailArgs): string | undefined {
  return args.bodyText ?? args.body;
}

function messageIds(args: GmailArgs): string[] {
  return [...(args.messageIds ?? []), ...(args.messageId ? [args.messageId] : [])];
}

function requireComposedEmail(
  args: GmailArgs,
  opts: { requireTo: boolean; requireSubject: boolean; requireThread?: boolean },
): Result<Parameters<GmailClientPort['sendMessage']>[0], ToolError> {
  const body = bodyText(args);
  const template = buildTemplate(args, body);
  if (opts.requireTo && !args.to?.length) return badArgs('to required');
  if (opts.requireSubject && !args.subject) return badArgs('subject required');
  if (opts.requireThread && !args.threadId) return badArgs('threadId required');
  if (!body && !args.bodyHtml && !template) return badArgs('bodyText/body/bodyHtml/templateId required');
  const recipients = validateProvidedRecipientEmails({
    ...(args.to ? { to: args.to } : {}),
    ...(args.cc ? { cc: args.cc } : {}),
    ...(args.bcc ? { bcc: args.bcc } : {}),
  });
  if (!recipients.ok) return recipients;

  return ok({
    to: args.to ?? [],
    ...(args.cc?.length ? { cc: args.cc } : {}),
    ...(args.bcc?.length ? { bcc: args.bcc } : {}),
    subject: args.subject ?? '',
    ...(body !== undefined ? { body } : {}),
    ...(args.bodyHtml !== undefined ? { bodyHtml: args.bodyHtml } : {}),
    ...(template !== undefined ? { template } : {}),
    ...(args.threadId ? { threadId: args.threadId } : {}),
    ...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}),
    ...(args.references?.length ? { references: args.references } : {}),
  });
}

function buildTemplate(args: GmailArgs, fallbackText?: string): DivoEmailTemplateData | undefined {
  if (!args.templateId) return undefined;
  const data = args.templateData ?? {};
  const title = readString(data, 'title') ?? args.subject ?? 'Divo update';
  const intro = readString(data, 'intro') ?? fallbackText;
  const preheader = readString(data, 'preheader');
  const eyebrow = readString(data, 'eyebrow');
  const sections = readSections(data);
  const signatureName = readString(data, 'signatureName');
  const signatureTitle = readString(data, 'signatureTitle');
  const footerNote = readString(data, 'footerNote');
  return {
    variant: variantFor(args.templateId),
    title,
    ...(preheader ? { preheader } : {}),
    ...(eyebrow ? { eyebrow } : {}),
    ...(intro ? { intro } : {}),
    ...(sections?.length ? { sections } : {}),
    ...(signatureName ? { signatureName } : {}),
    ...(signatureTitle ? { signatureTitle } : {}),
    ...(footerNote ? { footerNote } : {}),
  };
}

function variantFor(templateId: z.infer<typeof DivoTemplateIdSchema>): DivoEmailTemplateVariant {
  switch (templateId) {
    case 'divo-executive-v1': return 'executive';
    case 'divo-proposal-v1': return 'proposal';
    case 'divo-follow-up-v1': return 'follow_up';
    case 'divo-report-v1': return 'report_delivery';
    case 'divo-finance-v1': return 'invoice_or_finance';
    case 'divo-standard-v1':
    default: return 'standard';
  }
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readSections(data: Record<string, unknown>): DivoEmailTemplateData['sections'] | undefined {
  const sections = data['sections'];
  if (!Array.isArray(sections)) return undefined;
  const out: Array<NonNullable<DivoEmailTemplateData['sections']>[number]> = [];
  for (const section of sections) {
    const rec = section && typeof section === 'object' && !Array.isArray(section) ? section as Record<string, unknown> : {};
    const body = readString(rec, 'body');
    if (!body) continue;
    const heading = readString(rec, 'heading');
    const bullets = Array.isArray(rec['bullets'])
      ? rec['bullets'].filter((item): item is string => typeof item === 'string')
      : undefined;
    out.push({
      ...(heading ? { heading } : {}),
      body,
      ...(bullets?.length ? { bullets } : {}),
    });
  }
  return out.length ? out : undefined;
}

function badArgs(message: string): Result<never, ToolError> {
  return err(new ToolError({ toolId: 'googleGmail', reason: 'bad_args', message }));
}

function validateProvidedRecipientEmails(input: {
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
}): Result<void, ToolError> {
  for (const [field, values] of Object.entries(input)) {
    for (const raw of values ?? []) {
      const validation = validateDeliverableEmail(raw);
      if (!validation.ok) {
        return badArgs(`${field} recipient "${raw}" is not safe to send: ${validation.reason}. Resolve the person through Lark contacts/context search or ask the user for the real email address.`);
      }
    }
  }
  return ok(undefined);
}

function validateDeliverableEmail(raw: string): { ok: true } | { ok: false; reason: string } {
  const email = extractEmailAddress(raw).toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    return { ok: false, reason: 'not a valid email address' };
  }

  const domain = email.split('@')[1] ?? '';
  const blockedDomains = new Set([
    'example.com',
    'example.org',
    'example.net',
    'test.com',
    'localhost',
    'local',
    'invalid',
  ]);

  if (
    blockedDomains.has(domain) ||
    domain.endsWith('.example') ||
    domain.endsWith('.test') ||
    domain.endsWith('.invalid') ||
    domain.endsWith('.localhost') ||
    domain.endsWith('.local')
  ) {
    return { ok: false, reason: 'placeholder or test domain' };
  }

  return { ok: true };
}

function extractEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/<([^>]+)>/);
  return (match?.[1] ?? trimmed).trim();
}

async function mailboxAction(
  args: GmailArgs,
  fn: (ids: string[]) => Promise<{ modified: number }>,
  label: string,
): Promise<Result<GmailResult, ToolError>> {
  const ids = messageIds(args);
  if (!ids.length) return badArgs(`messageId or messageIds required for ${args.op}`);
  const data = await fn(ids);
  return ok({ success: true, data, message: `${label} ${data.modified} message(s)` });
}
