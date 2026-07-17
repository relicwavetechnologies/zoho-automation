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

export interface LarkDirectoryPerson {
  openId: string;
  displayName: string;
  email?: string;
  jobTitle?: string;
  departmentNames?: string[];
  organization?: string;
}

export interface LarkContactsClientPort {
  /**
   * Lark's organisation-directory endpoints require the installed app's
   * tenant token; they cannot be executed with an arbitrary member's user
   * token. Divo still applies its own RBAC before this client is called.
   */
  searchDepartments(query: string): Promise<Array<{ departmentId: string; name: string }>>;
  getUsers(openIds: string[]): Promise<LarkDirectoryPerson[]>;
  listDepartmentMembers(departmentId: string, limit?: number): Promise<LarkDirectoryPerson[]>;
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
- Results expose names and governed directory fields for presentation. Lark IDs appear only under internalRouting for downstream tool calls; never show internalRouting to the user.
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

          const uniqueOpenIds = uniqueStrings([
            ...resolved.resolved.map(person => person.openId),
            ...resolved.ambiguous.flatMap(candidate => candidate.matches.map(person => person.openId)),
          ]);
          let enrichedByOpenId = new Map<string, LarkDirectoryPerson>();
          let directoryEnrichment: 'complete' | 'partial' | 'unavailable' = 'complete';
          if (uniqueOpenIds.length > 0) {
            try {
              const enriched = await deps.contactsClient.getUsers(uniqueOpenIds);
              enrichedByOpenId = new Map(enriched.map(person => [person.openId, person]));
              directoryEnrichment = enrichedByOpenId.size === uniqueOpenIds.length ? 'complete' : 'partial';
            } catch {
              directoryEnrichment = 'unavailable';
            }
          }

          const data = {
            found:     dedupePeople(resolved.resolved).map(person =>
              toPresentedPerson(mergePerson(person, enrichedByOpenId.get(person.openId)))),
            ambiguous: resolved.ambiguous.map(a => ({
              query:   a.query,
              matches: dedupePeople(a.matches).map(person =>
                toPresentedPerson(mergePerson(person, enrichedByOpenId.get(person.openId)))),
            })),
            notFound:  resolved.notFound,
            directoryEnrichment,
          };
          const total   = data.found.length;
          const ambiguous = data.ambiguous.length;
          const missing = data.notFound.length;
          const message = [
            `Returned ${total} resolved contact(s)`,
            `${ambiguous} ambiguous quer${ambiguous === 1 ? 'y' : 'ies'}`,
            `${missing} not found`,
            ...(missing > 0 ? [`Not found: ${data.notFound.join(', ')}`] : []),
          ].join('. ');
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
            data: {
              department: dept.name,
              memberCount: members.length,
              members: dedupePeople(members).map(toPresentedPerson),
            },
          });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkContacts', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});

type BaseResolvedPerson = Awaited<ReturnType<PeopleResolverPort['resolve']>>['resolved'][number];

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function dedupePeople<T extends { openId: string }>(people: readonly T[]): T[] {
  const seen = new Set<string>();
  return people.filter(person => {
    if (!person.openId || seen.has(person.openId)) return false;
    seen.add(person.openId);
    return true;
  });
}

function mergePerson(
  base: BaseResolvedPerson,
  enriched?: LarkDirectoryPerson,
): LarkDirectoryPerson {
  return {
    openId: base.openId,
    displayName: enriched?.displayName || base.displayName,
    ...(enriched?.email || base.email ? { email: enriched?.email ?? base.email } : {}),
    ...(enriched?.jobTitle ? { jobTitle: enriched.jobTitle } : {}),
    ...(enriched?.departmentNames?.length ? { departmentNames: [...enriched.departmentNames] } : {}),
    ...(enriched?.organization ? { organization: enriched.organization } : {}),
  };
}

function toPresentedPerson(person: LarkDirectoryPerson) {
  return {
    displayName: person.displayName,
    ...(person.email ? { email: person.email } : {}),
    ...(person.jobTitle ? { jobTitle: person.jobTitle } : {}),
    ...(person.departmentNames?.length ? { departmentNames: [...person.departmentNames] } : {}),
    ...(person.organization ? { organization: person.organization } : {}),
    internalRouting: {
      provider: 'lark' as const,
      openId: person.openId,
    },
  };
}
