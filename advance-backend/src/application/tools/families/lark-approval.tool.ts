import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { ok, err } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { PermissionResult } from '../../permissions/permission.types';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../shared/ids';

const Schema = z.object({
  op: z.enum(['list', 'get', 'get_definition', 'create']),
  approvalCode: z.string().optional(),
  instanceCode: z.string().optional(),
  formValues: z.record(z.unknown()).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  /** ISO 8601 or millisecond Unix timestamp. Defaults to the last 30 days for list. */
  startTime: z.string().optional(),
  /** ISO 8601 or millisecond Unix timestamp. Defaults to now for list. */
  endTime: z.string().optional(),
});
type Args = z.infer<typeof Schema>;
const ResultSchema = z.object({ success: z.boolean(), data: z.unknown().optional(), instanceCode: z.string().optional(), message: z.string().optional() });
type Res = z.infer<typeof ResultSchema>;

export interface LarkApprovalClientPort {
  /**
   * The native approval-instance endpoints used here are tenant-token APIs.
   * Divo uses the installed Lark app identity after backend RBAC/HITL checks;
   * it must not pretend a user access token can authorize them.
   */
  listInstances(
    approvalCode: string,
    limit?: number,
    window?: { startTime?: string; endTime?: string },
  ): Promise<unknown[]>;
  getInstance(approvalCode: string, instanceCode: string): Promise<unknown>;
  getDefinition(approvalCode: string): Promise<unknown>;
  createInstance(approvalCode: string, formValues: Record<string, unknown>): Promise<{ instanceCode: string }>;
}

export const createLarkApprovalTool = (deps: { client: LarkApprovalClientPort }): Tool<Args, Res> => ({
  id: asToolId('larkApproval'), family: 'lark',
  actionGroups: new Set(['read', 'create']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'List, inspect, or create native Lark approvals through the installed Lark app after Divo policy checks.',
  parameterDocs: 'op: list|get|get_definition|create. approvalCode, instanceCode, formValues. list accepts optional startTime/endTime (ISO 8601 or millisecond timestamp; defaults to the last 30 days). For create, first use get_definition when form control types are unknown; form values may be raw values or { type, value, required? }.',
  permissionCheck(args, perm) {
    const action: ToolActionGroup = args.op === 'create' ? 'create' : 'read';
    const allowed = perm.allowedActionsByTool.get(asToolId('larkApproval'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkApproval', action, reason: 'not_allowed' }));
  },
  async execute(args, ctx): Promise<Result<Res, ToolError>> {
    if (!args.approvalCode) return err(new ToolError({ toolId: 'larkApproval', reason: 'bad_args', message: 'approvalCode required' }));
    try {
      switch (args.op) {
        case 'list': {
          ctx.onProgress?.('Checking approvals…');
          return ok({
            success: true,
            data: await deps.client.listInstances(args.approvalCode, args.limit, {
              ...(args.startTime ? { startTime: toApprovalTimestamp(args.startTime) } : {}),
              ...(args.endTime ? { endTime: toApprovalTimestamp(args.endTime) } : {}),
            }),
          });
        }
        case 'get': {
          if (!args.instanceCode) return err(new ToolError({ toolId: 'larkApproval', reason: 'bad_args', message: 'instanceCode required' }));
          ctx.onProgress?.('Fetching approval…');
          return ok({ success: true, data: await deps.client.getInstance(args.approvalCode, args.instanceCode) });
        }
        case 'get_definition': {
          ctx.onProgress?.('Fetching approval definition…');
          return ok({ success: true, data: await deps.client.getDefinition(args.approvalCode) });
        }
        case 'create': {
          if (!args.formValues) return err(new ToolError({ toolId: 'larkApproval', reason: 'bad_args', message: 'formValues required' }));
          ctx.onProgress?.('Creating approval…');
          const r = await deps.client.createInstance(args.approvalCode, args.formValues as Record<string, unknown>);
          return ok({ success: true, instanceCode: r.instanceCode, message: 'Approval created' });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkApproval', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});

function toApprovalTimestamp(value: string): string {
  if (/^\d+$/.test(value)) return value;
  const milliseconds = new Date(value).getTime();
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid approval time: ${value}`);
  }
  return String(milliseconds);
}
