import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const LarkMsgArgsSchema = z.object({
  op: z.enum(['send', 'list', 'get', 'reply']),
  chatId: z.string().optional(),
  messageId: z.string().optional(),
  text: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type LarkMsgArgs = z.infer<typeof LarkMsgArgsSchema>;

const LarkMsgResultSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  data: z.unknown().optional(),
  message: z.string().optional(),
});
type LarkMsgResult = z.infer<typeof LarkMsgResultSchema>;

export interface LarkMessagingClientPort {
  sendMessage(chatId: string, text: string): Promise<{ messageId: string }>;
  replyMessage(messageId: string, text: string): Promise<{ messageId: string }>;
  listMessages(chatId: string, limit?: number): Promise<Array<{ messageId: string; text: string; senderId: string; timestamp: string }>>;
  getMessage(messageId: string): Promise<{ messageId: string; text: string; senderId: string; timestamp: string }>;
}

const inferAction = (op: LarkMsgArgs['op']): ToolActionGroup => {
  if (op === 'send' || op === 'reply') return 'send';
  return 'read';
};

export const createLarkMessagingTool = (deps: {
  client: LarkMessagingClientPort;
}): Tool<LarkMsgArgs, LarkMsgResult> => ({
  id: asToolId('larkMessaging'),
  family: 'lark',
  actionGroups: new Set(['read', 'send']),
  argsSchema: LarkMsgArgsSchema,
  resultSchema: LarkMsgResultSchema,
  description: 'Send messages, list chat history, or reply to messages in Lark.',
  parameterDocs: `
- op: send | reply | list | get
- chatId: Target chat ID (required for send and list)
- messageId: Message ID (required for reply and get)
- text: Message text (required for send/reply)
- limit: Max messages for list (default 20)
  `.trim(),

  permissionCheck(args: LarkMsgArgs, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action = inferAction(args.op);
    const allowed = perm.allowedActionsByTool.get(asToolId('larkMessaging'))?.has(action) ?? false;
    if (!allowed) {
      return err(new PermissionError({ toolId: 'larkMessaging', action, reason: 'not_allowed' }));
    }
    return ok(action);
  },

  async execute(args: LarkMsgArgs, ctx: ToolExecutionContext): Promise<Result<LarkMsgResult, ToolError>> {
    try {
      switch (args.op) {
        case 'send': {
          if (!args.chatId || !args.text) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'chatId and text required for send' }));
          const r = await deps.client.sendMessage(args.chatId, args.text);
          return ok({ success: true, messageId: r.messageId, message: 'Message sent' });
        }
        case 'reply': {
          if (!args.messageId || !args.text) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'messageId and text required for reply' }));
          const r = await deps.client.replyMessage(args.messageId, args.text);
          return ok({ success: true, messageId: r.messageId, message: 'Reply sent' });
        }
        case 'list': {
          if (!args.chatId) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'chatId required for list' }));
          const msgs = await deps.client.listMessages(args.chatId, args.limit ?? 20);
          return ok({ success: true, data: msgs, message: `Found ${msgs.length} messages` });
        }
        case 'get': {
          if (!args.messageId) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'messageId required for get' }));
          const msg = await deps.client.getMessage(args.messageId);
          return ok({ success: true, data: msg });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkMessaging', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
