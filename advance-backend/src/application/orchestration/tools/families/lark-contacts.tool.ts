import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import type { PeopleResolverPort } from './lark-task.tool';

// ─── Client port ──────────────────────────────────────────────────────────────

export interface LarkContactsClientPort {
  /**
   * Lark's organisation-directory endpoints require the installed app's
   * tenant token; they cannot be executed with an arbitrary member's user
   * token. Divo still applies its own RBAC before this client is called.
   */
  searchDepartments(query: string): Promise<Array<{ departmentId: string; name: string }>>;
  listDepartmentMembers(departmentId: string, limit?: number): Promise<Array<{ openId: string; displayName: string; email?: string }>>;
}

// ─── Arg schema ───────────────────────────────────────────────────────────────

const LarkContactsArgsSchema = z.object({
  op: z.enum(['lookup', 'list_department']),
  query: z.string().optional(),          // single name/email for lookup
  queries: z.array(z.string()).optional(), // multiple names — batch lookup
  department: z.string().optional(),     // for list_department
  limit: z.number().int().min(1).max(100).optional(),
});
type LarkContactsArgs = z.infer<typeof LarkContactsArgsSchema>;

const LarkContactsResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  message: z.string().optional(),
});
type LarkContactsResult = z.infer<typeof LarkContactsResultSchema>;

// ─── Factory ─────────────────────────────────────────────────────────────────

export const createLarkContactsTool = (deps: {
  peopleResolver:  PeopleResolverPort;
  contactsClient:  LarkContactsClientPort;
}): Tool<LarkContactsArgs, LarkContactsResult> => ({
  id: asToolId('larkContacts'),
  family: 'lark',
  actionGroups: new Set(['read']),
  argsSchema: LarkContactsArgsSchema,
  resultSchema: LarkContactsResultSchema,
  description: 'Look up company-directory users by name/email or list department members through the installed Lark app.',
  parameterDocs: `
- op: lookup | list_department
- query: Single person name or email (for lookup of one person)
- queries: Array of names to resolve in one call, e.g. ["Rahul", "Bhojraj", "Archit"] (preferred for multiple people)
- department: Department name (required for list_department)
- limit: Max members for list_department (default 50, max 100)
  `.trim(),

  permissionCheck(args: LarkContactsArgs, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action: ToolActionGroup = 'read';
    const allowed = perm.allowedActionsByTool.get(asToolId('larkContacts'))?.has(action) ?? false;
    if (!allowed) {
      return err(new PermissionError({ toolId: 'larkContacts', action, reason: 'not_allowed' }));
    }
    return ok(action);
  },

  async execute(args: LarkContactsArgs, ctx: ToolExecutionContext): Promise<Result<LarkContactsResult, ToolError>> {
    try {
      switch (args.op) {
        case 'lookup': {
          const nameList = args.queries?.length
            ? args.queries
            : args.query
              ? [args.query]
              : [];
          if (nameList.length === 0) {
            return err(new ToolError({ toolId: 'larkContacts', reason: 'bad_args', message: 'query or queries is required for lookup' }));
          }
          ctx.onProgress?.('Looking up contacts…');
          const companyId       = String(ctx.runContext.companyId);
          const requesterOpenId = ctx.runContext.userExternalId ?? '';
          const resolved = await deps.peopleResolver.resolve(companyId, nameList, requesterOpenId);

          const data = {
            found:     resolved.resolved.map(m => ({ openId: m.openId, displayName: m.displayName, ...(m.email ? { email: m.email } : {}) })),
            ambiguous: resolved.ambiguous.map(a => ({
              query:   a.query,
              matches: a.matches.map(m => ({ openId: m.openId, displayName: m.displayName, ...(m.email ? { email: m.email } : {}) })),
            })),
            notFound:  resolved.notFound,
          };
          const total   = data.found.length;
          const missing = data.notFound.length;
          const message = missing > 0
            ? `Found ${total}/${nameList.length}. Not found: ${data.notFound.join(', ')}`
            : `Found all ${total} contact(s)`;
          return ok({ success: true, data, message });
        }

        case 'list_department': {
          if (!args.department) {
            return err(new ToolError({ toolId: 'larkContacts', reason: 'bad_args', message: 'department is required for list_department' }));
          }
          ctx.onProgress?.('Listing department members…');
          const depts = await deps.contactsClient.searchDepartments(args.department);
          if (depts.length === 0) {
            return ok({ success: true, data: [], message: `No department found matching "${args.department}"` });
          }
          const dept = depts[0]!;
          const members = await deps.contactsClient.listDepartmentMembers(dept.departmentId, args.limit ?? 50);
          return ok({
            success: true,
            data: { department: dept.name, memberCount: members.length, members },
          });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkContacts', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
