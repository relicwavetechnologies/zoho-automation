import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const Schema = z.object({
  op: z.enum(['list', 'get', 'create']),
  approvalCode: z.string().optional(),
  instanceCode: z.string().optional(),
  formValues: z.record(z.unknown()).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type Args = z.infer<typeof Schema>;
const ResultSchema = z.object({ success: z.boolean(), data: z.unknown().optional(), instanceCode: z.string().optional(), message: z.string().optional() });
type Res = z.infer<typeof ResultSchema>;

export interface LarkApprovalClientPort {
  listInstances(approvalCode: string, limit?: number): Promise<unknown[]>;
  getInstance(approvalCode: string, instanceCode: string): Promise<unknown>;
  createInstance(approvalCode: string, formValues: Record<string, unknown>): Promise<{ instanceCode: string }>;
}

export const createLarkApprovalTool = (deps: { client: LarkApprovalClientPort }): Tool<Args, Res> => ({
  id: asToolId('larkApproval'), family: 'lark',
  actionGroups: new Set(['read', 'create']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'List, get, or create Lark approval requests.',
  parameterDocs: 'op: list|get|create. approvalCode, instanceCode, formValues.',
  permissionCheck(args, perm) {
    const action: ToolActionGroup = args.op === 'create' ? 'create' : 'read';
    const allowed = perm.allowedActionsByTool.get(asToolId('larkApproval'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkApproval', action, reason: 'not_allowed' }));
  },
  async execute(args, _ctx): Promise<Result<Res, ToolError>> {
    if (!args.approvalCode) return err(new ToolError({ toolId: 'larkApproval', reason: 'bad_args', message: 'approvalCode required' }));
    try {
      switch (args.op) {
        case 'list': return ok({ success: true, data: await deps.client.listInstances(args.approvalCode, args.limit) });
        case 'get': {
          if (!args.instanceCode) return err(new ToolError({ toolId: 'larkApproval', reason: 'bad_args', message: 'instanceCode required' }));
          return ok({ success: true, data: await deps.client.getInstance(args.approvalCode, args.instanceCode) });
        }
        case 'create': {
          if (!args.formValues) return err(new ToolError({ toolId: 'larkApproval', reason: 'bad_args', message: 'formValues required' }));
          const r = await deps.client.createInstance(args.approvalCode, args.formValues as Record<string, unknown>);
          return ok({ success: true, instanceCode: r.instanceCode, message: 'Approval created' });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkApproval', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
