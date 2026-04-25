import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const Schema = z.object({
  op: z.enum(['list_records', 'get_record', 'create_record', 'update_record', 'delete_record', 'search_records']),
  appToken: z.string().optional(),
  tableId: z.string().optional(),
  recordId: z.string().optional(),
  fields: z.record(z.unknown()).optional(),
  filter: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
type Args = z.infer<typeof Schema>;
const ResultSchema = z.object({ success: z.boolean(), data: z.unknown().optional(), recordId: z.string().optional(), message: z.string().optional() });
type Res = z.infer<typeof ResultSchema>;

export interface LarkBaseClientPort {
  listRecords(appToken: string, tableId: string, limit?: number): Promise<unknown[]>;
  getRecord(appToken: string, tableId: string, recordId: string): Promise<unknown>;
  createRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<{ recordId: string }>;
  updateRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
  deleteRecord(appToken: string, tableId: string, recordId: string): Promise<void>;
  searchRecords(appToken: string, tableId: string, filter: string, limit?: number): Promise<unknown[]>;
}

export const createLarkBaseTool = (deps: { client: LarkBaseClientPort }): Tool<Args, Res> => ({
  id: asToolId('larkBase'), family: 'lark',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'Read, create, update, or delete records in Lark Base (multi-dimensional tables).',
  parameterDocs: 'op: list_records|get_record|create_record|update_record|delete_record|search_records. appToken, tableId, recordId, fields.',
  permissionCheck(args, perm) {
    const op = args.op;
    const action: ToolActionGroup = op === 'list_records' || op === 'get_record' || op === 'search_records' ? 'read'
      : op === 'create_record' ? 'create' : op === 'update_record' ? 'update' : 'delete';
    const allowed = perm.allowedActionsByTool.get(asToolId('larkBase'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkBase', action, reason: 'not_allowed' }));
  },
  async execute(args, _ctx): Promise<Result<Res, ToolError>> {
    const { appToken, tableId } = args;
    if (!appToken || !tableId) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'appToken and tableId required' }));
    try {
      switch (args.op) {
        case 'list_records': return ok({ success: true, data: await deps.client.listRecords(appToken, tableId, args.limit) });
        case 'get_record': {
          if (!args.recordId) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'recordId required' }));
          return ok({ success: true, data: await deps.client.getRecord(appToken, tableId, args.recordId) });
        }
        case 'create_record': {
          if (!args.fields) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'fields required' }));
          const r = await deps.client.createRecord(appToken, tableId, args.fields as Record<string, unknown>);
          return ok({ success: true, recordId: r.recordId, message: 'Record created' });
        }
        case 'update_record': {
          if (!args.recordId || !args.fields) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'recordId and fields required' }));
          await deps.client.updateRecord(appToken, tableId, args.recordId, args.fields as Record<string, unknown>);
          return ok({ success: true, message: 'Record updated' });
        }
        case 'delete_record': {
          if (!args.recordId) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'recordId required' }));
          await deps.client.deleteRecord(appToken, tableId, args.recordId);
          return ok({ success: true, message: 'Record deleted' });
        }
        case 'search_records': {
          if (!args.filter) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'filter required' }));
          return ok({ success: true, data: await deps.client.searchRecords(appToken, tableId, args.filter, args.limit) });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkBase', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
