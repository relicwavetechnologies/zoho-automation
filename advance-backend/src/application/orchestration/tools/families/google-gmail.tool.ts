import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import type { DivoEmailTemplateData, DivoEmailTemplateVariant } from '../../../email/email.types';
import { buildTemplateFromPlainText } from '../../../email/plain-text-to-template';
import type { AttachmentPolicyViolation, AttachmentRef, ResolvedAttachment } from '../../../email/attachment.types';
import { GMAIL_DRAFT_READ_SCOPES, GMAIL_MODIFY_SCOPES, GMAIL_READ_SCOPES, GMAIL_SEND_SCOPES } from '../../../google/google-scope-policy';

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

const AttachmentArgSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('file_asset'), fileAssetId: z.string() }),
  z.object({ source: z.literal('outbound_artifact'), artifactId: z.string() }),
  z.object({ source: z.literal('google_drive'), connectionId: z.string().min(1), fileId: z.string(), exportMimeType: z.string().optional() }),
  z.object({ source: z.literal('lark'), messageId: z.string(), fileKey: z.string(), fileName: z.string().optional() }),
  z.object({ source: z.literal('cloudinary'), publicId: z.string(), fileName: z.string().optional(), resourceType: z.string().optional() }),
]);

const GmailArgsSchema = z.object({
  connectionId: z.string().min(1),
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
  attachments: z.array(AttachmentArgSchema).max(10).optional(),
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
    attachments?: readonly ResolvedAttachment[];
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
    attachments?: readonly ResolvedAttachment[];
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
    attachments?: readonly ResolvedAttachment[];
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
    attachments?: readonly ResolvedAttachment[];
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
    attachments?: readonly ResolvedAttachment[];
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
  if (
    op === 'send' || op === 'reply' || op === 'reply_all' || op === 'forward' ||
    op === 'draft_create' || op === 'draft_update' || op === 'draft_delete' || op === 'draft_send'
  ) return 'send';
  if (
    op === 'label_apply' || op === 'label_remove' || op === 'archive' || op === 'mark_read' || op === 'mark_unread' ||
    op === 'star' || op === 'unstar' || op === 'trash' || op === 'untrash'
  ) return 'update';
  return 'read';
};

const requiredScopesForOp = (op: GmailArgs['op']): readonly string[] => {
  if (
    op === 'send' || op === 'reply' || op === 'reply_all' || op === 'forward' ||
    op === 'draft_create' || op === 'draft_update' || op === 'draft_delete' || op === 'draft_send'
  ) return GMAIL_SEND_SCOPES;
  if (
    op === 'label_apply' || op === 'label_remove' || op === 'archive' || op === 'mark_read' || op === 'mark_unread' ||
    op === 'star' || op === 'unstar' || op === 'trash' || op === 'untrash'
  ) return GMAIL_MODIFY_SCOPES;
  if (op === 'draft_get') return GMAIL_DRAFT_READ_SCOPES;
  return GMAIL_READ_SCOPES;
};

export const createGoogleGmailTool = (deps: {
  getClient: (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: 'read_only' | 'read_write';
    readonly requiredScopes: readonly string[];
  }) => Promise<GmailClientPort | null>;
  resolveAttachments?: (
    refs: readonly AttachmentRef[],
    ctx: { readonly companyId: string; readonly userId: string },
  ) => Promise<Result<ResolvedAttachment[], AttachmentPolicyViolation>>;
}): Tool<GmailArgs, GmailResult> => ({
  id: asToolId('googleGmail'),
  family: 'google',
  actionGroups: new Set(['read', 'send', 'update']),
  argsSchema: GmailArgsSchema,
  resultSchema: GmailResultSchema,
  description: 'List, read, search, draft, send, reply, reply-all, forward, thread, label, organize Gmail messages, and attach resolved files.',
  parameterDocs: `
- op: list | get | search | send | reply | reply_all | forward | thread_list | thread_get | draft_create | draft_get | draft_update | draft_delete | draft_send | label_list | label_apply | label_remove | archive | mark_read | mark_unread | star | unstar | trash | untrash
- connectionId: Required backend connection id from connections.list. Select the personal or shared Google account explicitly.
- messageId: Gmail message ID for get/reply/reply_all/forward or single-message mailbox actions
- messageIds: Gmail message IDs for batch mailbox actions
- threadId: Gmail thread ID for thread_get or legacy reply/send threading
- draftId: Gmail draft ID for draft get/update/delete/send
- to: Recipient email addresses for send/forward/draft_create/draft_update
- cc: CC recipient email addresses
- bcc: BCC recipient email addresses
- Recipient safety: every to/cc/bcc value must be a real resolved email. Placeholder/test domains are rejected; resolve named people through context/Lark contacts or ask the user.
- subject: Email subject
- body/bodyText: Well-structured plain text. Divo wraps it in the T1 HTML template (multipart plain+HTML) with sections parsed from ALL CAPS headings and bullet lines. Use clear paragraphs, greet by name, sign off professionally. body is a legacy alias.
- bodyHtml: Optional raw HTML body; skips the Divo template when provided.
- templateId/templateData: Optional structured template (divo-standard-v1, divo-finance-v1, divo-proposal-v1, divo-executive-v1, divo-follow-up-v1, divo-report-v1). When omitted, bodyText is auto-formatted into the HTML template.
- attachments: Optional files to attach for send/draft/reply/forward. Sources: file_asset{fileAssetId}, outbound_artifact{artifactId}, google_drive{connectionId,fileId,exportMimeType?}, lark{messageId,fileKey,fileName?}, cloudinary{publicId, fileName?, resourceType?}. When a previous tool call returns csvPublicId (from Zoho/data-processor exports), use source=cloudinary with that publicId to attach the CSV. Limits: 10 files, 10 MB each, 18 MB total; executable/script/macro file extensions are blocked.
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
    const action = inferAction(args.op);
    const client = await deps.getClient({
      companyId:     ctx.runContext.companyId,
      userId:        ctx.runContext.userId,
      connectionId:  args.connectionId,
      minimumAccess: action === 'read' ? 'read_only' : 'read_write',
      requiredScopes: requiredScopesForOp(args.op),
    });
    if (!client) {
      return err(new ToolError({ toolId: 'googleGmail', reason: 'unrecoverable', message: 'Google connection is unavailable or not allowed for this operation' }));
    }

    try {
      switch (args.op) {
        case 'list': {
          ctx.onProgress?.('Fetching emails…');
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
          ctx.onProgress?.('Searching emails…');
          const msgs = await client.searchMessages(args.query, args.limit ?? 10);
          return ok({ success: true, data: msgs, message: `Found ${msgs.length} emails` });
        }
        case 'send': {
          ctx.onProgress?.('Sending email…');
          const compose = requireComposedEmail(args, { requireTo: true, requireSubject: true });
          if (!compose.ok) return compose;
          const attachments = await resolveAttachmentsForArgs(args, ctx, deps);
          if (!attachments.ok) return attachments;
          const r = await client.sendMessage(withAttachments(compose.value, attachments.value));
          return ok({ success: true, messageId: r.messageId, threadId: r.threadId, message: 'Email sent' });
        }
        case 'draft_create': {
          const compose = requireComposedEmail(args, { requireTo: true, requireSubject: true });
          if (!compose.ok) return compose;
          const attachments = await resolveAttachmentsForArgs(args, ctx, deps);
          if (!attachments.ok) return attachments;
          const r = await client.createDraft(withAttachments(compose.value, attachments.value));
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
          const attachments = await resolveAttachmentsForArgs(args, ctx, deps);
          if (!attachments.ok) return attachments;
          const r = await client.updateDraft(args.draftId, withAttachments(compose.value, attachments.value));
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
          ctx.onProgress?.('Sending reply…');
          const body = bodyText(args);
          const presentation = buildEmailPresentation(args, body);
          const recipients = validateProvidedRecipientEmails({
            ...(args.cc ? { cc: args.cc } : {}),
            ...(args.bcc ? { bcc: args.bcc } : {}),
          });
          if (!recipients.ok) return recipients;
          const content = validateRenderableContent(body, presentation);
          if (!content.ok) return content;
          const attachments = await resolveAttachmentsForArgs(args, ctx, deps);
          if (!attachments.ok) return attachments;
          if (args.messageId) {
            const r = await client.replyToMessage(args.messageId, {
              ...(body !== undefined ? { body } : {}),
              ...(presentation.bodyHtml !== undefined ? { bodyHtml: presentation.bodyHtml } : {}),
              ...(presentation.template !== undefined ? { template: presentation.template } : {}),
              ...(args.cc?.length ? { cc: args.cc } : {}),
              ...(args.bcc?.length ? { bcc: args.bcc } : {}),
              ...(attachments.value?.length ? { attachments: attachments.value } : {}),
            });
            return ok({ success: true, messageId: r.messageId, threadId: r.threadId, message: 'Reply sent' });
          }
          const compose = requireComposedEmail(args, { requireTo: true, requireSubject: false, requireThread: true });
          if (!compose.ok) return compose;
          const r = await client.sendMessage(withAttachments({ ...compose.value, subject: args.subject ?? 'Re:' }, attachments.value));
          return ok({ success: true, messageId: r.messageId, threadId: r.threadId, message: 'Reply sent' });
        }
        case 'reply_all': {
          if (!args.messageId) return badArgs('messageId required for reply_all');
          const body = bodyText(args);
          const presentation = buildEmailPresentation(args, body);
          const recipients = validateProvidedRecipientEmails({
            ...(args.cc ? { cc: args.cc } : {}),
            ...(args.bcc ? { bcc: args.bcc } : {}),
          });
          if (!recipients.ok) return recipients;
          const content = validateRenderableContent(body, presentation);
          if (!content.ok) return content;
          const attachments = await resolveAttachmentsForArgs(args, ctx, deps);
          if (!attachments.ok) return attachments;
          const r = await client.replyToMessage(args.messageId, {
            ...(body !== undefined ? { body } : {}),
            ...(presentation.bodyHtml !== undefined ? { bodyHtml: presentation.bodyHtml } : {}),
            ...(presentation.template !== undefined ? { template: presentation.template } : {}),
            ...(args.cc?.length ? { cc: args.cc } : {}),
            ...(args.bcc?.length ? { bcc: args.bcc } : {}),
            replyAll: true,
            ...(attachments.value?.length ? { attachments: attachments.value } : {}),
          });
          return ok({ success: true, messageId: r.messageId, threadId: r.threadId, message: 'Reply-all sent' });
        }
        case 'forward': {
          ctx.onProgress?.('Forwarding email…');
          if (!args.messageId) return badArgs('messageId required for forward');
          if (!args.to?.length) return badArgs('to required for forward');
          const recipients = validateProvidedRecipientEmails({
            to: args.to,
            ...(args.cc ? { cc: args.cc } : {}),
            ...(args.bcc ? { bcc: args.bcc } : {}),
          });
          if (!recipients.ok) return recipients;
          const body = bodyText(args);
          const presentation = buildEmailPresentation(args, body);
          const attachments = await resolveAttachmentsForArgs(args, ctx, deps);
          if (!attachments.ok) return attachments;
          const r = await client.forwardMessage(args.messageId, {
            to: args.to,
            ...(args.cc?.length ? { cc: args.cc } : {}),
            ...(args.bcc?.length ? { bcc: args.bcc } : {}),
            ...(args.subject ? { subject: args.subject } : {}),
            ...(body !== undefined ? { body } : {}),
            ...(presentation.bodyHtml !== undefined ? { bodyHtml: presentation.bodyHtml } : {}),
            ...(presentation.template !== undefined ? { template: presentation.template } : {}),
            ...(args.includeOriginal !== undefined ? { includeOriginal: args.includeOriginal } : {}),
            ...(attachments.value?.length ? { attachments: attachments.value } : {}),
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

async function resolveAttachmentsForArgs(
  args: GmailArgs,
  ctx: ToolExecutionContext,
  deps: {
    readonly resolveAttachments?: (
      refs: readonly AttachmentRef[],
      ctx: { readonly companyId: string; readonly userId: string },
    ) => Promise<Result<ResolvedAttachment[], AttachmentPolicyViolation>>;
  },
): Promise<Result<ResolvedAttachment[] | undefined, ToolError>> {
  if (!args.attachments?.length) return ok(undefined);
  if (!deps.resolveAttachments) {
    return badArgs('Email attachments are not enabled for this environment.');
  }

  const resolved = await deps.resolveAttachments(toAttachmentRefs(args.attachments), {
    companyId: ctx.runContext.companyId,
    userId: ctx.runContext.userId,
  });
  if (!resolved.ok) return badArgs(resolved.error.message);
  return ok(resolved.value);
}

function toAttachmentRefs(attachments: NonNullable<GmailArgs['attachments']>): AttachmentRef[] {
  return attachments.map(attachment => {
    switch (attachment.source) {
      case 'file_asset':
        return { source: 'file_asset', fileAssetId: attachment.fileAssetId };
      case 'outbound_artifact':
        return { source: 'outbound_artifact', artifactId: attachment.artifactId };
      case 'google_drive':
        return {
          source: 'google_drive',
          connectionId: attachment.connectionId,
          fileId: attachment.fileId,
          ...(attachment.exportMimeType ? { exportMimeType: attachment.exportMimeType } : {}),
        };
      case 'lark':
        return {
          source: 'lark',
          messageId: attachment.messageId,
          fileKey: attachment.fileKey,
          ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
        };
      case 'cloudinary':
        return {
          source: 'cloudinary',
          publicId: attachment.publicId,
          ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
          ...(attachment.resourceType ? { resourceType: attachment.resourceType } : {}),
        };
    }
  });
}

function withAttachments<T extends object>(
  params: T,
  attachments: readonly ResolvedAttachment[] | undefined,
): T & { readonly attachments?: readonly ResolvedAttachment[] } {
  return attachments?.length ? { ...params, attachments } : params;
}

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
  const presentation = buildEmailPresentation(args, body);
  if (opts.requireTo && !args.to?.length) return badArgs('to required');
  if (opts.requireSubject && !args.subject) return badArgs('subject required');
  if (opts.requireThread && !args.threadId) return badArgs('threadId required');
  const content = validateRenderableContent(body, presentation);
  if (!content.ok) return content;
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
    ...(presentation.bodyHtml !== undefined ? { bodyHtml: presentation.bodyHtml } : {}),
    ...(presentation.template !== undefined ? { template: presentation.template } : {}),
    ...(args.threadId ? { threadId: args.threadId } : {}),
    ...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}),
    ...(args.references?.length ? { references: args.references } : {}),
  });
}

function buildEmailPresentation(args: GmailArgs, fallbackText?: string): {
  readonly bodyHtml?: string;
  readonly template?: DivoEmailTemplateData;
} {
  const explicitHtml = args.bodyHtml?.trim();
  if (explicitHtml) {
    return { bodyHtml: explicitHtml };
  }

  if (args.templateId) {
    const template = buildTemplate(args, fallbackText);
    if (template) return { template };
  }

  const body = fallbackText?.trim();
  if (body) {
    return {
      template: buildTemplateFromPlainText(args.subject ?? 'Divo message', body),
    };
  }

  return {};
}

function buildTemplate(args: GmailArgs, fallbackText?: string): DivoEmailTemplateData | undefined {
  if (!args.templateId) return undefined;
  const data = args.templateData ?? {};
  const links = readLinks(data, fallbackText);
  const title = readString(data, 'title') ?? args.subject ?? 'Divo update';
  const intro = readString(data, 'intro') ?? introFromText(fallbackText, links);
  const preheader = readString(data, 'preheader');
  const eyebrow = readString(data, 'eyebrow');
  const sections = readSections(data);
  const metadata = readMetadata(data) ?? financeMetadataFromText(fallbackText);
  const cta = readCta(data);
  const signatureName = readString(data, 'signatureName');
  const signatureTitle = readString(data, 'signatureTitle');
  const footerNote = readString(data, 'footerNote');
  return {
    variant: variantFor(args.templateId),
    title,
    ...(preheader ? { preheader } : {}),
    ...(eyebrow ? { eyebrow } : {}),
    ...(intro ? { intro } : {}),
    ...(metadata?.length ? { metadata } : {}),
    ...(links?.length ? { links } : {}),
    ...(sections?.length ? { sections } : {}),
    ...(cta ? { cta } : {}),
    ...(signatureName ? { signatureName } : {}),
    ...(signatureTitle ? { signatureTitle } : {}),
    ...(footerNote ? { footerNote } : {}),
  };
}

function buildDefaultTemplate(args: GmailArgs, fallbackText?: string): DivoEmailTemplateData | undefined {
  if (!fallbackText) return undefined;
  const links = linksFromText(fallbackText);
  const intro = introFromText(fallbackText, links);
  return {
    variant: 'standard',
    title: args.subject ?? 'Divo message',
    ...(intro ? { intro } : {}),
    ...(links?.length ? { links } : {}),
    footerNote: 'Sent with Divo.',
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

function readMetadata(data: Record<string, unknown>): DivoEmailTemplateData['metadata'] | undefined {
  const metadata = data['metadata'];
  if (!Array.isArray(metadata)) return undefined;
  const out: Array<NonNullable<DivoEmailTemplateData['metadata']>[number]> = [];
  for (const item of metadata) {
    const rec = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const label = readString(rec, 'label');
    const value = readString(rec, 'value');
    if (label && value) out.push({ label, value });
  }
  return out.length ? out : undefined;
}

function readLinks(data: Record<string, unknown>, fallbackText?: string): DivoEmailTemplateData['links'] | undefined {
  const links = data['links'];
  const out: Array<NonNullable<DivoEmailTemplateData['links']>[number]> = [];
  if (Array.isArray(links)) {
    for (const item of links) {
      const rec = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
      const url = readString(rec, 'url');
      if (!url || !isSafeCtaUrl(url)) continue;
      const label = readString(rec, 'label') ?? readString(rec, 'title') ?? labelForUrl(url, out.length + 1);
      out.push({ label, url });
    }
  }

  for (const link of linksFromText(fallbackText) ?? []) {
    if (!out.some(existing => existing.url === link.url)) out.push(link);
  }

  return out.length ? out : undefined;
}

function readCta(data: Record<string, unknown>): DivoEmailTemplateData['cta'] | undefined {
  const nested = data['cta'];
  const ctaData = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : data;
  const label = readString(ctaData, 'label') ?? readString(data, 'ctaLabel');
  const url = readString(ctaData, 'url') ?? readString(data, 'ctaUrl');
  if (!label || !url || !isSafeCtaUrl(url)) return undefined;
  return { label, url };
}

function isSafeCtaUrl(value: string): boolean {
  return /^https?:\/\/[^\s<>"']+$/i.test(value);
}

function linksFromText(value?: string): DivoEmailTemplateData['links'] | undefined {
  if (!value) return undefined;
  const links: Array<NonNullable<DivoEmailTemplateData['links']>[number]> = [];
  const seen = new Set<string>();
  const lines = value.split(/\n+/);
  for (const line of lines) {
    for (const url of extractUrls(line)) {
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ label: linkLabelFromLine(line, url, links.length + 1), url });
    }
  }
  return links.length ? links : undefined;
}

function extractUrls(value: string): string[] {
  return [...value.matchAll(/https?:\/\/[^\s<>"']+/gi)]
    .map(match => match[0].replace(/[),.;:!?]+$/g, ''))
    .filter(isSafeCtaUrl);
}

function linkLabelFromLine(line: string, url: string, index: number): string {
  const beforeUrl = line.slice(0, line.indexOf(url)).replace(/^\s*(?:[-*]|\d+[\).:-])\s*/, '').trim();
  if (beforeUrl && beforeUrl.length <= 80) return beforeUrl;
  return labelForUrl(url, index);
}

function labelForUrl(url: string, index: number): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host ? `${host} link` : `Link ${index}`;
  } catch {
    return `Link ${index}`;
  }
}

function introFromText(value: string | undefined, links?: DivoEmailTemplateData['links']): string | undefined {
  if (!value?.trim()) return undefined;
  if (!links?.length) return value.trim();
  const withoutUrlLines = value
    .split(/\n+/)
    .filter(line => extractUrls(line).length === 0)
    .join('\n')
    .trim();
  return withoutUrlLines || value.replace(/https?:\/\/[^\s<>"']+/gi, '').replace(/\s+/g, ' ').trim();
}

function financeMetadataFromText(value?: string): DivoEmailTemplateData['metadata'] | undefined {
  if (!value) return undefined;
  const metadata: Array<NonNullable<DivoEmailTemplateData['metadata']>[number]> = [];
  const amount = value.match(/₹\s?[\d,]+(?:\.\d+)?/)?.[0];
  if (amount) metadata.push({ label: 'Amount', value: amount.replace(/\s+/g, '') });
  const transactions = value.match(/\b[\d,]+\s+transactions?\b/i)?.[0];
  if (transactions) metadata.push({ label: 'Transactions', value: transactions });
  return metadata.length ? metadata : undefined;
}

function validateRenderableContent(
  body: string | undefined,
  presentation: { readonly bodyHtml?: string; readonly template?: DivoEmailTemplateData },
): Result<void, ToolError> {
  const template = presentation.template;
  const hasContent = Boolean(
    body?.trim() ||
    presentation.bodyHtml?.trim() ||
    template?.intro?.trim() ||
    template?.sections?.length ||
    template?.metadata?.length ||
    template?.links?.length ||
    template?.cta,
  );
  if (!hasContent) {
    return badArgs('Email body content required. Do not send a title-only template; include bodyText or templateData.intro/sections/metadata/links/cta.');
  }
  return validateLinkIntegrity(body, presentation);
}

function validateLinkIntegrity(
  body: string | undefined,
  presentation: { readonly bodyHtml?: string; readonly template?: DivoEmailTemplateData },
): Result<void, ToolError> {
  const text = [
    body,
    presentation.bodyHtml,
    presentation.template?.title,
    presentation.template?.intro,
    presentation.template?.cta?.label,
    presentation.template?.cta?.url,
    ...(presentation.template?.links?.flatMap(link => [link.label, link.url]) ?? []),
    ...(presentation.template?.sections ?? []).flatMap(section => [
      section.heading,
      section.body,
      ...(section.bullets ?? []),
    ]),
  ].filter(Boolean).join('\n');
  const urlCount = extractUrls(text).length + (presentation.template?.cta ? 1 : 0);
  const expectedCount = expectedLinkCount(text);

  if (mentionsLink(text) && urlCount === 0) {
    return badArgs('Email content mentions links/buttons but no URL is present. Include the exact URL(s) in bodyText, templateData.links, or templateData.cta before sending.');
  }
  if (expectedCount !== undefined && urlCount < expectedCount) {
    return badArgs(`Email content says it has ${expectedCount} link(s), but only ${urlCount} URL(s) are present. Include every URL before sending.`);
  }
  return ok(undefined);
}

function mentionsLink(value: string): boolean {
  return /\b(?:links?|urls?|buttons?|click|open)\b/i.test(value);
}

function expectedLinkCount(value: string): number | undefined {
  const numeric = value.match(/\b(\d+)\s+(?:links?|urls?|buttons?)\b/i)?.[1];
  if (numeric) return Number(numeric);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const word = value.match(/\b(one|two|three|four|five)\s+(?:links?|urls?|buttons?)\b/i)?.[1]?.toLowerCase();
  return word ? words[word] : undefined;
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
