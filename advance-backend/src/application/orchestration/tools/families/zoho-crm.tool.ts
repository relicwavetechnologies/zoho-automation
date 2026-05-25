import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const Schema = z.object({
  op: z.enum(['search', 'get', 'create', 'update', 'delete']),
  module: z.string().optional(),
  recordId: z.string().optional(),
  query: z.string().optional(),
  fields: z.record(z.unknown()).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
type Args = z.infer<typeof Schema>;
const ResultSchema = z.object({ success: z.boolean(), data: z.unknown().optional(), recordId: z.string().optional(), message: z.string().optional() });
type Res = z.infer<typeof ResultSchema>;

export interface ZohoCrmClientPort {
  searchRecords(module: string, query: string, limit?: number): Promise<unknown[]>;
  getRecord(module: string, recordId: string): Promise<unknown>;
  createRecord(module: string, fields: Record<string, unknown>): Promise<{ recordId: string }>;
  updateRecord(module: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
  deleteRecord(module: string, recordId: string): Promise<void>;
}

export const createZohoCrmTool = (deps: { getClient: (companyId: string, userId: string) => Promise<ZohoCrmClientPort | null> }): Tool<Args, Res> => ({
  id: asToolId('zohoCrm'), family: 'zoho',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'Search, read, create, update, or delete Zoho CRM records (Leads, Contacts, Deals, etc.).',
  parameterDocs: 'op: search|get|create|update|delete. module (Leads/Contacts/Deals), recordId, query, fields.',
  permissionCheck(args, perm) {
    const op = args.op;
    const action: ToolActionGroup = op === 'search' || op === 'get' ? 'read'
      : op === 'create' ? 'create' : op === 'update' ? 'update' : 'delete';
    const allowed = perm.allowedActionsByTool.get(asToolId('zohoCrm'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'zohoCrm', action, reason: 'not_allowed' }));
  },
  async execute(args, ctx): Promise<Result<Res, ToolError>> {
    const client = await deps.getClient(ctx.runContext.companyId, ctx.runContext.userId);
    if (!client) return err(new ToolError({ toolId: 'zohoCrm', reason: 'unrecoverable', message: 'Zoho CRM not connected' }));
    try {
      switch (args.op) {
        case 'search': {
          ctx.onProgress?.('Querying Zoho CRM…');
          return ok({ success: true, data: await client.searchRecords(args.module ?? 'Leads', args.query ?? '', args.limit) });
        }
        case 'get': {
          if (!args.recordId) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'recordId required' }));
          ctx.onProgress?.('Fetching CRM record…');
          return ok({ success: true, data: await client.getRecord(args.module ?? 'Leads', args.recordId) });
        }
        case 'create': {
          if (!args.fields) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'fields required' }));
          ctx.onProgress?.('Creating CRM record…');
          const r = await client.createRecord(args.module ?? 'Leads', args.fields as Record<string, unknown>);
          return ok({ success: true, recordId: r.recordId, message: 'Record created' });
        }
        case 'update': {
          if (!args.recordId || !args.fields) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'recordId and fields required' }));
          await client.updateRecord(args.module ?? 'Leads', args.recordId, args.fields as Record<string, unknown>);
          return ok({ success: true, message: 'Record updated' });
        }
        case 'delete': {
          if (!args.recordId) return err(new ToolError({ toolId: 'zohoCrm', reason: 'bad_args', message: 'recordId required' }));
          await client.deleteRecord(args.module ?? 'Leads', args.recordId);
          return ok({ success: true, message: 'Record deleted' });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'zohoCrm', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
