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
  op: z.enum(['list_records', 'get_record', 'create_record', 'update_record', 'delete_record', 'search_records']),
  appToken: z.string().optional(),
  tableId: z.string().optional(),
  recordId: z.string().optional(),
  fields: z.record(z.unknown()).optional(),
  filter: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  /** Divo-managed Lark connection. Required when more than one is accessible. */
  connectionId: z.string().uuid().optional(),
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

export const createLarkBaseTool = (deps: {
  client: LarkBaseClientPort;
  userTokenResolver?: LarkUserTokenResolver;
  createUserClient?: (userToken: string) => LarkBaseClientPort;
}): Tool<Args, Res> => ({
  id: asToolId('larkBase'), family: 'lark',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'Read, create, update, or delete records in Lark Base (multi-dimensional tables).',
  parameterDocs: 'op: list_records|get_record|create_record|update_record|delete_record|search_records. appToken, tableId, recordId, fields, connectionId (a connected or shared Lark account; required when more than one is available).',
  permissionCheck(args, perm) {
    const op = args.op;
    const action: ToolActionGroup = op === 'list_records' || op === 'get_record' || op === 'search_records' ? 'read'
      : op === 'create_record' ? 'create' : op === 'update_record' ? 'update' : 'delete';
    const allowed = perm.allowedActionsByTool.get(asToolId('larkBase'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkBase', action, reason: 'not_allowed' }));
  },
  async execute(args, ctx): Promise<Result<Res, ToolError>> {
    const { appToken, tableId } = args;
    if (!appToken || !tableId) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'appToken and tableId required' }));
    try {
      const userConnection = await resolveLarkUserClient(deps, ctx, {
        ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        minimumAccess: args.op === 'list_records' || args.op === 'get_record' || args.op === 'search_records'
          ? 'read_only'
          : 'read_write',
      });
      if (userConnection.status === 'choose_connection') {
        return ok({ success: false, data: larkConnectionSelectionData(userConnection.connections), message: 'Choose a Lark connection before continuing.' });
      }
      if (deps.userTokenResolver && userConnection.status === 'unavailable') {
        return err(new ToolError({ toolId: 'larkBase', reason: 'unrecoverable', message: larkConnectionRequiredMessage }));
      }
      const client = userConnection.status === 'resolved' ? userConnection.client : deps.client;
      switch (args.op) {
        case 'list_records': {
          ctx.onProgress?.('Querying Lark Base…');
          return ok({ success: true, data: await client.listRecords(appToken, tableId, args.limit) });
        }
        case 'get_record': {
          if (!args.recordId) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'recordId required' }));
          ctx.onProgress?.('Fetching record…');
          return ok({ success: true, data: await client.getRecord(appToken, tableId, args.recordId) });
        }
        case 'create_record': {
          if (!args.fields) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'fields required' }));
          ctx.onProgress?.('Creating record…');
          const r = await client.createRecord(appToken, tableId, args.fields as Record<string, unknown>);
          return ok({ success: true, recordId: r.recordId, message: 'Record created' });
        }
        case 'update_record': {
          if (!args.recordId || !args.fields) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'recordId and fields required' }));
          await client.updateRecord(appToken, tableId, args.recordId, args.fields as Record<string, unknown>);
          return ok({ success: true, message: 'Record updated' });
        }
        case 'delete_record': {
          if (!args.recordId) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'recordId required' }));
          await client.deleteRecord(appToken, tableId, args.recordId);
          return ok({ success: true, message: 'Record deleted' });
        }
        case 'search_records': {
          if (!args.filter) return err(new ToolError({ toolId: 'larkBase', reason: 'bad_args', message: 'filter required' }));
          ctx.onProgress?.('Searching Lark Base…');
          return ok({ success: true, data: await client.searchRecords(appToken, tableId, args.filter, args.limit) });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkBase', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
