import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import type { LarkUserTokenResolver, PeopleResolverPort } from './lark-task.tool';

// ─── Client port ──────────────────────────────────────────────────────────────

export interface LarkContactsClientPort {
  searchUsers(params: {
    query?: string;
    userIds?: string[];
    limit?: number;
    hasChatted?: boolean;
    hasEnterpriseEmail?: boolean;
    excludeExternalUsers?: boolean;
  }): Promise<Array<{
    openId: string;
    displayName: string;
    email?: string;
    enterpriseEmail?: string;
    department?: string;
    p2pChatId?: string;
    isActivated?: boolean;
    isCrossTenant?: boolean;
    hasChatted?: boolean;
    matchedQuery?: string;
    chatRecencyHint?: string;
  }>>;
  searchDepartments(query: string): Promise<Array<{ departmentId: string; name: string }>>;
  listDepartmentMembers(departmentId: string, limit?: number): Promise<Array<{ openId: string; displayName: string; email?: string }>>;
}

// ─── Arg schema ───────────────────────────────────────────────────────────────

const LarkContactsArgsSchema = z.object({
  op: z.enum(['lookup', 'search', 'get', 'list_department']),
  query: z.string().optional(),          // single name/email for lookup
  queries: z.array(z.string()).optional(), // multiple names — batch lookup
  openIds: z.array(z.string()).optional(), // direct open_id profile lookup
  department: z.string().optional(),     // for list_department
  limit: z.number().int().min(1).max(100).optional(),
  hasChatted: z.boolean().optional(),
  hasEnterpriseEmail: z.boolean().optional(),
  excludeExternalUsers: z.boolean().optional(),
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
  userTokenResolver?: LarkUserTokenResolver;
  createUserClient?: (userToken: string) => LarkContactsClientPort;
}): Tool<LarkContactsArgs, LarkContactsResult> => ({
  id: asToolId('larkContacts'),
  family: 'lark',
  actionGroups: new Set(['read']),
  argsSchema: LarkContactsArgsSchema,
  resultSchema: LarkContactsResultSchema,
  description: 'Look up Lark users by name/email (single or batch) or list members of a department.',
  parameterDocs: `
- op: lookup | search | get | list_department
- lookup: Deterministic contact resolution for side-effect actions. Returns found/ambiguous/notFound and never guesses same-name users.
- search: Live Lark directory search by name/email/phone with optional filters.
- get: Fetch profiles for known Lark open_ids.
- query: Single person name/email/phone (for lookup/search)
- queries: Array of names to resolve in one call, e.g. ["Rahul", "Bhojraj", "Archit"] (preferred for multiple people)
- openIds: Array of Lark open_ids for get
- department: Department name (required for list_department)
- limit: Max members for list_department (default 50, max 100)
- hasChatted / hasEnterpriseEmail / excludeExternalUsers: Optional live-search filters.
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
    let contactsClient = deps.contactsClient;
    if (deps.userTokenResolver && deps.createUserClient) {
      try {
        const userToken = await deps.userTokenResolver.resolve(
          String(ctx.runContext.userId),
          String(ctx.runContext.companyId),
        );
        if (userToken) contactsClient = deps.createUserClient(userToken);
      } catch {
        contactsClient = deps.contactsClient;
      }
    }

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

        case 'search': {
          if (!args.query) {
            return err(new ToolError({ toolId: 'larkContacts', reason: 'bad_args', message: 'query is required for search' }));
          }
          ctx.onProgress?.('Searching Lark contacts…');
          const users = await contactsClient.searchUsers({
            query: args.query,
            limit: args.limit ?? 20,
            ...(args.hasChatted !== undefined ? { hasChatted: args.hasChatted } : {}),
            ...(args.hasEnterpriseEmail !== undefined ? { hasEnterpriseEmail: args.hasEnterpriseEmail } : {}),
            ...(args.excludeExternalUsers !== undefined ? { excludeExternalUsers: args.excludeExternalUsers } : {}),
          });
          return ok({ success: true, data: { users }, message: `Found ${users.length} contact(s)` });
        }

        case 'get': {
          if (!args.openIds?.length) {
            return err(new ToolError({ toolId: 'larkContacts', reason: 'bad_args', message: 'openIds is required for get' }));
          }
          ctx.onProgress?.('Fetching contact profiles…');
          const users = await contactsClient.searchUsers({
            userIds: args.openIds,
            limit: Math.min(args.openIds.length, args.limit ?? 100),
          });
          return ok({ success: true, data: { users }, message: `Fetched ${users.length} contact profile(s)` });
        }

        case 'list_department': {
          if (!args.department) {
            return err(new ToolError({ toolId: 'larkContacts', reason: 'bad_args', message: 'department is required for list_department' }));
          }
          ctx.onProgress?.('Listing department members…');
          const depts = await contactsClient.searchDepartments(args.department);
          if (depts.length === 0) {
            return ok({ success: true, data: [], message: `No department found matching "${args.department}"` });
          }
          const dept = depts[0]!;
          const members = await contactsClient.listDepartmentMembers(dept.departmentId, args.limit ?? 50);
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
