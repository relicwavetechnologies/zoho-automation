import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const Schema = z.object({
  op: z.enum(['get', 'create', 'update', 'list_blocks', 'append_block']),
  docToken: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  blockType: z.string().optional(),
});
type Args = z.infer<typeof Schema>;
const ResultSchema = z.object({ success: z.boolean(), data: z.unknown().optional(), docToken: z.string().optional(), message: z.string().optional() });
type Res = z.infer<typeof ResultSchema>;

export interface LarkDocClientPort {
  getDoc(docToken: string): Promise<unknown>;
  createDoc(title: string): Promise<{ docToken: string }>;
  appendBlock(docToken: string, content: string, blockType?: string): Promise<void>;
  listBlocks(docToken: string): Promise<unknown[]>;
}

export const createLarkDocTool = (deps: { client: LarkDocClientPort }): Tool<Args, Res> => ({
  id: asToolId('larkDoc'), family: 'lark',
  actionGroups: new Set(['read', 'create', 'update']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'Read, create, or update Lark Docs.',
  parameterDocs: 'op: get|create|update|list_blocks|append_block. docToken, title, content.',
  permissionCheck(args, perm) {
    const action: ToolActionGroup = args.op === 'get' || args.op === 'list_blocks' ? 'read' : args.op === 'create' ? 'create' : 'update';
    const allowed = perm.allowedActionsByTool.get(asToolId('larkDoc'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkDoc', action, reason: 'not_allowed' }));
  },
  async execute(args, _ctx): Promise<Result<Res, ToolError>> {
    try {
      switch (args.op) {
        case 'get': {
          if (!args.docToken) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken required' }));
          return ok({ success: true, data: await deps.client.getDoc(args.docToken) });
        }
        case 'create': {
          if (!args.title) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'title required' }));
          const r = await deps.client.createDoc(args.title);
          return ok({ success: true, docToken: r.docToken, message: 'Doc created' });
        }
        case 'append_block': {
          if (!args.docToken || !args.content) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and content required' }));
          await deps.client.appendBlock(args.docToken, args.content, args.blockType);
          return ok({ success: true, message: 'Block appended' });
        }
        case 'list_blocks': {
          if (!args.docToken) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken required' }));
          return ok({ success: true, data: await deps.client.listBlocks(args.docToken) });
        }
        default: return ok({ success: false, message: 'Not implemented' });
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkDoc', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
