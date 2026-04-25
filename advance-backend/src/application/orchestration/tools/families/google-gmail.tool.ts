import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const GmailArgsSchema = z.object({
  op: z.enum(['list', 'get', 'send', 'reply', 'search']),
  messageId: z.string().optional(),
  threadId: z.string().optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type GmailArgs = z.infer<typeof GmailArgsSchema>;

const GmailResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  message: z.string().optional(),
  messageId: z.string().optional(),
});
type GmailResult = z.infer<typeof GmailResultSchema>;

export interface GmailClientPort {
  listMessages(limit?: number, query?: string): Promise<Array<{
    messageId: string;
    threadId: string;
    subject: string;
    from: string;
    snippet: string;
    timestamp: string;
    isUnread: boolean;
  }>>;
  getMessage(messageId: string): Promise<{
    messageId: string;
    threadId: string;
    subject: string;
    from: string;
    to: string[];
    body: string;
    timestamp: string;
  }>;
  sendMessage(params: {
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    threadId?: string;
  }): Promise<{ messageId: string }>;
  searchMessages(query: string, limit?: number): Promise<Array<{
    messageId: string;
    subject: string;
    from: string;
    snippet: string;
    timestamp: string;
  }>>;
}

const inferAction = (op: GmailArgs['op']): ToolActionGroup => {
  if (op === 'send' || op === 'reply') return 'send';
  return 'read';
};

export const createGoogleGmailTool = (deps: {
  getClient: (companyId: string, userId: string) => Promise<GmailClientPort | null>;
}): Tool<GmailArgs, GmailResult> => ({
  id: asToolId('googleGmail'),
  family: 'google',
  actionGroups: new Set(['read', 'send']),
  argsSchema: GmailArgsSchema,
  resultSchema: GmailResultSchema,
  description: 'List, read, send, reply to, or search Gmail messages.',
  parameterDocs: `
- op: list | get | send | reply | search
- messageId: Gmail message ID (required for get/reply)
- threadId: Thread ID for reply
- to: Recipient email addresses (required for send)
- subject: Email subject (required for send)
- body: Email body (required for send/reply)
- query: Search query string (for search)
- limit: Max messages (default 10)
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
          if (!args.messageId) return err(new ToolError({ toolId: 'googleGmail', reason: 'bad_args', message: 'messageId required for get' }));
          const msg = await client.getMessage(args.messageId);
          return ok({ success: true, data: msg });
        }
        case 'search': {
          if (!args.query) return err(new ToolError({ toolId: 'googleGmail', reason: 'bad_args', message: 'query required for search' }));
          const msgs = await client.searchMessages(args.query, args.limit ?? 10);
          return ok({ success: true, data: msgs, message: `Found ${msgs.length} emails` });
        }
        case 'send': {
          if (!args.to?.length || !args.subject || !args.body) {
            return err(new ToolError({ toolId: 'googleGmail', reason: 'bad_args', message: 'to, subject, body required for send' }));
          }
          const r = await client.sendMessage({ to: args.to, subject: args.subject, body: args.body, ...(args.cc !== undefined ? { cc: args.cc } : {}) });
          return ok({ success: true, messageId: r.messageId, message: 'Email sent' });
        }
        case 'reply': {
          if (!args.threadId || !args.body) return err(new ToolError({ toolId: 'googleGmail', reason: 'bad_args', message: 'threadId and body required for reply' }));
          const r = await client.sendMessage({ to: args.to ?? [], subject: args.subject ?? 'Re:', body: args.body, threadId: args.threadId });
          return ok({ success: true, messageId: r.messageId, message: 'Reply sent' });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'googleGmail', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
