import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const Schema = z.object({
  op: z.enum(['get', 'create', 'list_blocks', 'append_block', 'update_block', 'delete_block', 'insert_table', 'share']),
  docToken: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  blockType: z.enum(['text', 'heading1', 'heading2', 'heading3', 'bullet', 'code']).optional(),
  blockId: z.string().optional(),
  rows: z.number().int().min(1).max(50).optional(),
  cols: z.number().int().min(1).max(20).optional(),
  headers: z.array(z.string()).optional(),
  visibility: z.enum(['anyone', 'tenant', 'specified']).optional(),
});
type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  docToken: z.string().optional(),
  message: z.string().optional(),
});
type Res = z.infer<typeof ResultSchema>;

export interface LarkDocClientPort {
  getDoc(docToken: string): Promise<unknown>;
  createDoc(title: string): Promise<{ docToken: string }>;
  appendBlock(docToken: string, content: string, blockType?: string): Promise<void>;
  listBlocks(docToken: string): Promise<unknown[]>;
  updateBlock(docToken: string, blockId: string, content: string, blockType?: string): Promise<void>;
  deleteBlock(docToken: string, blockId: string): Promise<void>;
  insertTable(docToken: string, params: { afterBlockId?: string; rows: number; cols: number; headers?: string[] }): Promise<void>;
  shareDoc(docToken: string, visibility: string): Promise<{ shareUrl?: string }>;
}

const inferAction = (op: Args['op']): ToolActionGroup => {
  if (op === 'get' || op === 'list_blocks') return 'read';
  if (op === 'create') return 'create';
  return 'update';
};

export const createLarkDocTool = (deps: { client: LarkDocClientPort }): Tool<Args, Res> => ({
  id: asToolId('larkDoc'),
  family: 'lark',
  actionGroups: new Set(['read', 'create', 'update']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description: 'Read, create, and edit Lark Docs — append/update/delete blocks, insert tables, share docs.',
  parameterDocs: `
- op: get|create|list_blocks|append_block|update_block|delete_block|insert_table|share
- docToken: Lark doc token (required for all except create)
- title: Doc title (required for create)
- content: Block text content (for append_block, update_block)
- blockType: text|heading1|heading2|heading3|bullet|code (default: text)
- blockId: Block ID (required for update_block, delete_block; optional afterBlockId for insert_table)
- rows, cols: Table dimensions in cells (required for insert_table)
- headers: Column header strings (optional, for insert_table)
- visibility: anyone|tenant|specified (required for share)
  `.trim(),

  permissionCheck(args: Args, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action = inferAction(args.op);
    const allowed = perm.allowedActionsByTool.get(asToolId('larkDoc'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkDoc', action, reason: 'not_allowed' }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    try {
      switch (args.op) {
        case 'get': {
          if (!args.docToken) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken required' }));
          ctx.onProgress?.('Reading document…');
          return ok({ success: true, data: await deps.client.getDoc(args.docToken) });
        }
        case 'create': {
          if (!args.title) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'title required' }));
          ctx.onProgress?.('Creating document…');
          const r = await deps.client.createDoc(args.title);
          return ok({ success: true, docToken: r.docToken, message: 'Doc created' });
        }
        case 'append_block': {
          if (!args.docToken || !args.content)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and content required' }));
          ctx.onProgress?.('Updating document…');
          await deps.client.appendBlock(args.docToken, args.content, args.blockType);
          return ok({ success: true, message: 'Block appended' });
        }
        case 'list_blocks': {
          if (!args.docToken) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken required' }));
          return ok({ success: true, data: await deps.client.listBlocks(args.docToken) });
        }
        case 'update_block': {
          if (!args.docToken || !args.blockId || !args.content)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken, blockId, and content required' }));
          await deps.client.updateBlock(args.docToken, args.blockId, args.content, args.blockType);
          return ok({ success: true, message: 'Block updated' });
        }
        case 'delete_block': {
          if (!args.docToken || !args.blockId)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and blockId required' }));
          await deps.client.deleteBlock(args.docToken, args.blockId);
          return ok({ success: true, message: 'Block deleted' });
        }
        case 'insert_table': {
          if (!args.docToken || !args.rows || !args.cols)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken, rows, and cols required' }));
          await deps.client.insertTable(args.docToken, {
            rows: args.rows,
            cols: args.cols,
            ...(args.blockId ? { afterBlockId: args.blockId } : {}),
            ...(args.headers ? { headers: args.headers } : {}),
          });
          return ok({ success: true, message: `Table (${args.rows}×${args.cols}) inserted` });
        }
        case 'share': {
          if (!args.docToken || !args.visibility)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and visibility required' }));
          const r = await deps.client.shareDoc(args.docToken, args.visibility);
          return ok({ success: true, docToken: args.docToken, data: r, message: 'Doc sharing updated' });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkDoc', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
