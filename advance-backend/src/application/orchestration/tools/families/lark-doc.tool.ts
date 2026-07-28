import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import {
  larkConnectionSelectionData,
  larkConnectionRequiredMessage,
  resolveLarkUserClient,
  type LarkUserTokenResolver,
} from './lark-user-connection';

const Schema = z.object({
  op: z.enum(['get', 'create', 'list_blocks', 'append_block', 'append_blocks', 'update_block', 'delete_block', 'insert_table', 'share']),
  docToken: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  blockType: z.enum(['text', 'heading1', 'heading2', 'heading3', 'bullet', 'code', 'todo']).optional(),
  blocks: z.array(z.object({
    content: z.string().min(1),
    blockType: z.enum(['text', 'heading1', 'heading2', 'heading3', 'bullet', 'code', 'todo']).optional(),
  })).min(1).max(100).optional(),
  blockId: z.string().optional(),
  rows: z.number().int().min(1).max(50).optional(),
  cols: z.number().int().min(1).max(20).optional(),
  headers: z.array(z.string()).optional(),
  data: z.array(z.array(z.string())).max(50).optional(),
  visibility: z.enum(['anyone', 'tenant', 'specified']).optional(),
  /** Exact Divo-managed Lark connection when more than one is accessible. */
  connectionId: z.string().uuid().optional(),
});
type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  docToken: z.string().optional(),
  url: z.string().url().optional(),
  message: z.string().optional(),
});
type Res = z.infer<typeof ResultSchema>;

export interface LarkDocClientPort {
  getDoc(docToken: string): Promise<unknown>;
  createDoc(title: string): Promise<{ docToken: string; url?: string }>;
  appendBlock(docToken: string, content: string, blockType?: string): Promise<void>;
  appendBlocks(docToken: string, blocks: Array<{ content: string; blockType?: string }>): Promise<void>;
  listBlocks(docToken: string): Promise<unknown[]>;
  updateBlock(docToken: string, blockId: string, content: string): Promise<void>;
  deleteBlock(docToken: string, blockId: string): Promise<void>;
  insertTable(docToken: string, params: { afterBlockId?: string; rows: number; cols: number; headers?: string[]; data?: string[][] }): Promise<void>;
  shareDoc(docToken: string, visibility: string): Promise<{ shareUrl?: string }>;
}

const inferAction = (op: Args['op']): ToolActionGroup => {
  if (op === 'get' || op === 'list_blocks') return 'read';
  if (op === 'create') return 'create';
  return 'update';
};

export const createLarkDocTool = (deps: {
  client: LarkDocClientPort;
  userTokenResolver?: LarkUserTokenResolver;
  createUserClient?: (userToken: string) => LarkDocClientPort;
}): Tool<Args, Res> => ({
  id: asToolId('larkDoc'),
  family: 'lark',
  actionGroups: new Set(['read', 'create', 'update']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description: 'Read, create, and edit Lark Docs — batch append structured blocks, insert populated tables, update/delete blocks, and share docs.',
  parameterDocs: `
- op: get|create|list_blocks|append_block|append_blocks|update_block|delete_block|insert_table|share
- docToken: Lark doc token (required for all except create)
- title: Doc title (required for create)
- create always returns docToken and resolves the canonical Lark document URL when Drive metadata provides it
- content: Block text content (for append_block, update_block)
- blockType: text|heading1|heading2|heading3|bullet|code|todo (default: text). Use todo for an interactive document checklist; do not imitate one with bullet characters or emoji.
- blocks: Ordered content blocks for append_blocks. Prefer this over many append_block calls when writing a section or document.
- For bullet blocks, provide plain text without a leading bullet character.
- blockId: Block ID (required for update_block, delete_block; optional afterBlockId for insert_table)
- rows, cols: Table dimensions in cells (required for insert_table; rows includes the header row when headers are present)
- headers: Column header strings (optional, for insert_table)
- data: Table body rows (optional, for insert_table). Put row/column data here instead of appending it as bullets after an empty table.
- visibility: anyone|tenant|specified (required for share)
- connectionId: Exact accessible Lark UUID. In backend-hosted channels, omit it when no account was supplied; the backend selects only one accessible account or returns exact choices.
  `.trim(),

  permissionCheck(args: Args, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action = inferAction(args.op);
    const allowed = perm.allowedActionsByTool.get(asToolId('larkDoc'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkDoc', action, reason: 'not_allowed' }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    try {
      const userConnection = await resolveLarkUserClient(deps, ctx, {
        ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        minimumAccess: inferAction(args.op) === 'read' ? 'read_only' : 'read_write',
      });
      if (userConnection.status === 'choose_connection') {
        return ok({ success: false, data: larkConnectionSelectionData(userConnection.connections), message: 'Choose a Lark connection before continuing.' });
      }
      if (deps.userTokenResolver && userConnection.status === 'unavailable') {
        return err(new ToolError({ toolId: 'larkDoc', reason: 'unrecoverable', message: larkConnectionRequiredMessage }));
      }
      const client = userConnection.status === 'resolved' ? userConnection.client : deps.client;
      switch (args.op) {
        case 'get': {
          if (!args.docToken) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken required' }));
          ctx.onProgress?.('Reading document…');
          return ok({ success: true, data: await client.getDoc(args.docToken) });
        }
        case 'create': {
          if (!args.title) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'title required' }));
          ctx.onProgress?.('Creating document…');
          const r = await client.createDoc(args.title);
          return ok({
            success: true,
            docToken: r.docToken,
            ...(r.url ? { url: r.url } : {}),
            data: {
              title: args.title,
              docToken: r.docToken,
              ...(r.url ? { url: r.url } : {}),
            },
            message: r.url
              ? 'Doc created'
              : 'Doc created, but Lark Drive metadata did not return a canonical URL',
          });
        }
        case 'append_block': {
          if (!args.docToken || !args.content)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and content required' }));
          ctx.onProgress?.('Updating document…');
          await client.appendBlock(args.docToken, args.content, args.blockType);
          return ok({ success: true, message: 'Block appended' });
        }
        case 'append_blocks': {
          if (!args.docToken || !args.blocks)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and blocks required' }));
          ctx.onProgress?.('Updating document…');
          await client.appendBlocks(args.docToken, args.blocks.map(block => ({
            content: block.content,
            ...(block.blockType ? { blockType: block.blockType } : {}),
          })));
          return ok({ success: true, message: `${args.blocks.length} blocks appended` });
        }
        case 'list_blocks': {
          if (!args.docToken) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken required' }));
          return ok({ success: true, data: await client.listBlocks(args.docToken) });
        }
        case 'update_block': {
          if (!args.docToken || !args.blockId || !args.content)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken, blockId, and content required' }));
          await client.updateBlock(args.docToken, args.blockId, args.content);
          return ok({ success: true, message: 'Block updated' });
        }
        case 'delete_block': {
          if (!args.docToken || !args.blockId)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and blockId required' }));
          await client.deleteBlock(args.docToken, args.blockId);
          return ok({ success: true, message: 'Block deleted' });
        }
        case 'insert_table': {
          if (!args.docToken || !args.rows || !args.cols)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken, rows, and cols required' }));
          const { rows, cols } = args;
          const bodyCapacity = args.rows - (args.headers?.length ? 1 : 0);
          if ((args.headers?.length ?? 0) > cols
            || (args.data?.length ?? 0) > bodyCapacity
            || args.data?.some(row => row.length > cols)) {
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'headers and data must fit the declared table dimensions' }));
          }
          await client.insertTable(args.docToken, {
            rows,
            cols,
            ...(args.blockId ? { afterBlockId: args.blockId } : {}),
            ...(args.headers ? { headers: args.headers } : {}),
            ...(args.data ? { data: args.data } : {}),
          });
          return ok({ success: true, message: `Table (${args.rows}×${args.cols}) inserted` });
        }
        case 'share': {
          if (!args.docToken || !args.visibility)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and visibility required' }));
          const r = await client.shareDoc(args.docToken, args.visibility);
          return ok({ success: true, docToken: args.docToken, data: r, message: 'Doc sharing updated' });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkDoc', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
