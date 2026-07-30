import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { ok, err } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { PermissionResult } from '../../permissions/permission.types';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../shared/ids';
import type { PeopleResolverPort } from './lark-task.tool';
import {
  larkConnectionSelectionData,
  larkConnectionRequiredMessage,
  resolveLarkUserClient,
  type LarkUserTokenResolver,
} from './lark-user-connection';

const LarkMsgArgsSchema = z.object({
  op: z.enum(['send', 'list', 'reply', 'send_dm', 'list_chats', 'search', 'mention']),
  chatId: z.string().optional(),
  messageId: z.string().optional(),
  text: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  recipientName: z.string().optional(),
  recipientOpenId: z.string().optional(),
  query: z.string().optional(),
  mentionNames: z.array(z.string()).optional(),
  mentionOpenIds: z.array(z.string()).optional(),
  /** Card 2.0 is the default so Markdown is rendered consistently in outbound Divo messages. */
  rendering: z.enum(['card', 'text']).optional(),
  /** Exact Divo-managed Lark connection when more than one is accessible. */
  connectionId: z.string().uuid().optional(),
});
type LarkMsgArgs = z.infer<typeof LarkMsgArgsSchema>;

export type LarkMessageRendering = 'card' | 'text';

const LarkMsgResultSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  data: z.unknown().optional(),
  message: z.string().optional(),
});
type LarkMsgResult = z.infer<typeof LarkMsgResultSchema>;

export interface LarkMessagingClientPort {
  sendMessage(chatId: string, text: string, options?: { rendering?: LarkMessageRendering }): Promise<{ messageId: string }>;
  replyMessage(messageId: string, text: string, options?: { rendering?: LarkMessageRendering }): Promise<{ messageId: string }>;
  listMessages(chatId: string, limit?: number): Promise<Array<{ messageId: string; text: string; senderId: string; timestamp: string }>>;
  sendDm(openId: string, text: string, options?: { rendering?: LarkMessageRendering }): Promise<{ messageId: string }>;
  listChats(limit?: number): Promise<Array<{ chatId: string; name: string; type: string; memberCount?: number }>>;
  searchMessages(chatId: string, query: string, limit?: number): Promise<Array<{ messageId: string; text: string; senderId: string; timestamp: string }>>;
  mentionMessage(chatId: string, text: string, mentionOpenIds: string[], options?: { rendering?: LarkMessageRendering }): Promise<{ messageId: string }>;
}

const inferAction = (op: LarkMsgArgs['op']): ToolActionGroup => {
  if (op === 'send' || op === 'reply' || op === 'send_dm' || op === 'mention') return 'send';
  return 'read';
};

function runtimeOwnedCurrentChatId(ctx: ToolExecutionContext): string | null {
  if (ctx.runContext.channel !== 'lark') return null;
  return ctx.runContext.chatId ?? null;
}

function runtimeOwnedOpenIds(ctx: ToolExecutionContext): Set<string> {
  if (ctx.runContext.channel !== 'lark') return new Set();
  return new Set([
    ctx.runContext.userExternalId,
    ctx.runContext.deliveryMode === 'scheduled_runtime_delivery'
      ? ctx.runContext.chatId
      : undefined,
  ].filter((value): value is string => Boolean(value)));
}

function runtimeDeliveryError(): ToolError {
  return new ToolError({
    toolId: 'larkMessaging',
    reason: 'bad_args',
    message: 'The runtime owns final delivery to this Lark conversation. Return the content as the final reply instead of sending it with larkMessaging.',
  });
}

function explicitlyMentionedOpenIds(ctx: ToolExecutionContext): Set<string> {
  return new Set(ctx.runContext.mentionedLarkOpenIds ?? []);
}

function validateExplicitOpenIds(
  requested: readonly string[],
  ctx: ToolExecutionContext,
): Result<string[], ToolError> {
  const allowed = explicitlyMentionedOpenIds(ctx);
  const unique = Array.from(new Set(requested));
  if (unique.some(openId => !allowed.has(openId))) {
    return err(new ToolError({
      toolId: 'larkMessaging',
      reason: 'bad_args',
      message: 'An exact Lark recipient ID was not explicitly mentioned in this message. Use a recipient name instead.',
    }));
  }
  return ok(unique);
}

export const createLarkMessagingTool = (deps: {
  client: LarkMessagingClientPort;
  peopleResolver: PeopleResolverPort;
  userTokenResolver?: LarkUserTokenResolver;
  createUserClient?: (userToken: string) => LarkMessagingClientPort;
}): Tool<LarkMsgArgs, LarkMsgResult> => ({
  id: asToolId('larkMessaging'),
  family: 'lark',
  actionGroups: new Set(['read', 'send']),
  argsSchema: LarkMsgArgsSchema,
  resultSchema: LarkMsgResultSchema,
  description: 'Send messages, reply, send DMs, @mention people in group chats, list chats, or find text in a bounded recent Lark history window.',
  parameterDocs: `
- op: send|reply|list|send_dm|list_chats|search|mention
- chatId: Target chat ID (required for send, list, search, mention)
- messageId: Message ID (required for reply)
- text: Message text (required for send/reply/send_dm/mention)
- limit: Max messages/chats to return (default 20)
- recipientName: Human-readable name to resolve for send_dm
- recipientOpenId: Exact open_id supplied by the current message's <lark_mentioned_people> block. Never invent or reuse one from another turn.
- query: Text to find in the newest 500 messages of a chat (required for search; Lark does not offer server-side full-text history search)
- mentionNames: Array of names to resolve and @-tag in a group message, e.g. ["Anish", "Rahul"]
- mentionOpenIds: Exact open_ids supplied by the current message's <lark_mentioned_people> block. Never invent or reuse IDs from another turn.
- rendering: card|text. Defaults to card, which renders Markdown in a Divo Card 2.0 message. Use text only when plain text is explicitly required.
- connectionId: Exact UUID when supplied. Omit it to auto-select one accessible account or receive safe choices when several are available.
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
      const userConnection = await resolveLarkUserClient(deps, ctx, {
        ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        minimumAccess: inferAction(args.op) === 'read' ? 'read_only' : 'read_write',
      });
      if (userConnection.status === 'choose_connection') {
        return ok({ success: false, data: larkConnectionSelectionData(userConnection.connections), message: 'Choose a Lark connection before continuing.' });
      }
      if (deps.userTokenResolver && userConnection.status === 'unavailable') {
        return err(new ToolError({ toolId: 'larkMessaging', reason: 'unrecoverable', message: larkConnectionRequiredMessage }));
      }
      // Reads use the selected member connection. Lark's documented interactive
      // message APIs are app/bot operations, so writes deliberately use the
      // backend-owned client after this connection check authorizes the member.
      const readClient = userConnection.status === 'resolved' ? userConnection.client : deps.client;
      const rendering = args.rendering ?? 'card';
      const runtimeChatId = runtimeOwnedCurrentChatId(ctx);
      switch (args.op) {
        case 'send': {
          if (!args.text) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'text required for send' }));
          if (ctx.runContext.deliveryMode === 'scheduled_runtime_delivery') {
            return err(runtimeDeliveryError());
          }
          if (runtimeChatId && (!args.chatId || args.chatId === runtimeChatId)) {
            return err(runtimeDeliveryError());
          }
          if (!args.chatId) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'chatId and text required for send' }));
          ctx.onProgress?.('Sending message…');
          const r = await deps.client.sendMessage(args.chatId, args.text, { rendering });
          return ok({ success: true, messageId: r.messageId, message: 'Message sent' });
        }
        case 'reply': {
          if (
            ctx.runContext.deliveryMode === 'current_chat_only'
            || ctx.runContext.deliveryMode === 'scheduled_runtime_delivery'
            || (
              ctx.runContext.channel === 'lark'
              && args.messageId === ctx.runContext.replyToMessageId
            )
          ) {
            return err(runtimeDeliveryError());
          }
          if (!args.messageId || !args.text) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'messageId and text required for reply' }));
          ctx.onProgress?.('Sending reply…');
          const r = await deps.client.replyMessage(args.messageId, args.text, { rendering });
          return ok({ success: true, messageId: r.messageId, message: 'Reply sent' });
        }
        case 'list': {
          if (!args.chatId) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'chatId required for list' }));
          ctx.onProgress?.('Fetching messages…');
          const msgs = await readClient.listMessages(args.chatId, args.limit ?? 20);
          return ok({ success: true, data: msgs, message: `Found ${msgs.length} messages` });
        }
        case 'send_dm': {
          if (!args.text) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'text required for send_dm' }));
          if (args.recipientOpenId && args.recipientName) {
            return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'Use recipientOpenId or recipientName, not both.' }));
          }
          ctx.onProgress?.('Sending direct message…');
          let openId: string;
          if (args.recipientOpenId) {
            const validated = validateExplicitOpenIds([args.recipientOpenId], ctx);
            if (!validated.ok) return validated;
            openId = validated.value[0]!;
          } else if (args.recipientName) {
            const companyId       = String(ctx.runContext.companyId);
            const requesterOpenId = ctx.runContext.userExternalId ?? '';
            const resolved = await deps.peopleResolver.resolve(companyId, [args.recipientName], requesterOpenId);
            if (resolved.ambiguous.length > 0) {
              const detail = resolved.ambiguous
                .map(a => `"${a.query}" → ${a.matches.map(m => m.displayName).join(' / ')}`)
                .join('; ');
              return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: `Ambiguous recipient — please clarify: ${detail}` }));
            }
            if (resolved.notFound.length > 0 || resolved.resolved.length === 0) {
              return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: `Could not find Lark user: ${args.recipientName}` }));
            }
            openId = resolved.resolved[0]!.openId;
          } else {
            return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'recipientOpenId or recipientName required for send_dm' }));
          }
          if (runtimeOwnedOpenIds(ctx).has(openId)) {
            return err(runtimeDeliveryError());
          }
          const r = await deps.client.sendDm(openId, args.text, { rendering });
          return ok({ success: true, messageId: r.messageId, message: 'DM sent' });
        }
        case 'list_chats': {
          const chats = await readClient.listChats(args.limit);
          return ok({ success: true, data: chats, message: `Found ${chats.length} chats` });
        }
        case 'search': {
          if (!args.chatId) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'chatId required for search' }));
          if (!args.query?.trim()) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'query required for search' }));
          ctx.onProgress?.('Searching messages…');
          const msgs = await readClient.searchMessages(args.chatId, args.query, args.limit);
          return ok({ success: true, data: msgs, message: `Found ${msgs.length} matching message(s) in the newest 500 messages` });
        }
        case 'mention': {
          if (!args.text) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'chatId and text required for mention' }));
          if (args.mentionOpenIds?.length && args.mentionNames?.length) {
            return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'Use mentionOpenIds or mentionNames, not both.' }));
          }
          if (!args.mentionOpenIds?.length && !args.mentionNames?.length) {
            return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'mentionOpenIds or mentionNames required for mention' }));
          }
          // Blocked for the same reason as `send`. A scheduled run's chat id is
          // the creator's own DM, so the guard below only stops it addressing
          // itself — any other chat id would pass, and a schedule written before
          // results became DM-only still carries intent text naming a room.
          if (ctx.runContext.deliveryMode === 'scheduled_runtime_delivery') {
            return err(runtimeDeliveryError());
          }
          if (runtimeChatId && (!args.chatId || args.chatId === runtimeChatId)) {
            return err(runtimeDeliveryError());
          }
          if (!args.chatId) return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: 'chatId and text required for mention' }));
          ctx.onProgress?.('Sending mention…');
          let mentionOpenIds: string[];
          if (args.mentionOpenIds?.length) {
            const validated = validateExplicitOpenIds(args.mentionOpenIds, ctx);
            if (!validated.ok) return validated;
            mentionOpenIds = validated.value;
          } else {
            const companyId = String(ctx.runContext.companyId);
            const requesterOpenId = ctx.runContext.userExternalId ?? '';
            const resolved = await deps.peopleResolver.resolve(companyId, args.mentionNames!, requesterOpenId);
            if (resolved.ambiguous.length > 0) {
              const detail = resolved.ambiguous.map(a => `"${a.query}" → ${a.matches.map(m => m.displayName).join(' / ')}`).join('; ');
              return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: `Ambiguous names: ${detail}` }));
            }
            mentionOpenIds = resolved.resolved.map(p => p.openId);
            if (resolved.notFound.length > 0) {
              return err(new ToolError({ toolId: 'larkMessaging', reason: 'bad_args', message: `Could not find: ${resolved.notFound.join(', ')}` }));
            }
          }
          const r = await deps.client.mentionMessage(args.chatId, args.text, mentionOpenIds, { rendering });
          return ok({ success: true, messageId: r.messageId, message: `Message sent with ${mentionOpenIds.length} mention(s)` });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkMessaging', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
