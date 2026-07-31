import { z } from 'zod';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import { asToolId } from '../../../shared/ids';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import type { PermissionResult } from '../../permissions/permission.types';
import type { Mem0Service, MemoryScope } from '../../memory/mem0.service';
import { isSafePublishedMemoryFact } from '../../memory/memory-fact-safety';
import type { Tool, ToolExecutionContext } from '../tool.contract';

export const MEMORY_PUBLISHING_MAX_FACTS = 10;
export const MEMORY_PUBLISHING_MAX_FACT_CHARS = 500;

const factSchema = z.string()
  .min(1)
  .max(MEMORY_PUBLISHING_MAX_FACT_CHARS)
  .refine((fact) => fact.trim().length > 0, 'Fact must contain non-whitespace text.')
  .refine(
    isSafePublishedMemoryFact,
    'Fact contains credential-like secret material and cannot be published.',
  );

const Schema = z.union([
  z.object({
    operation: z.literal('check_authority'),
  }).strict(),
  z.object({
    operation: z.literal('publish'),
    scope: z.literal('personal'),
    facts: z.array(factSchema).min(1).max(MEMORY_PUBLISHING_MAX_FACTS),
  }).strict(),
  z.object({
    operation: z.literal('publish'),
    scope: z.literal('department'),
    departmentId: z.string().min(1),
    facts: z.array(factSchema).min(1).max(MEMORY_PUBLISHING_MAX_FACTS),
  }).strict(),
  z.object({
    operation: z.literal('publish'),
    scope: z.literal('company'),
    facts: z.array(factSchema).min(1).max(MEMORY_PUBLISHING_MAX_FACTS),
  }).strict(),
]);

type Args = z.infer<typeof Schema>;
type PublishArgs = Extract<Args, { operation: 'publish' }>;

const targetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('personal'), label: z.string().min(1).max(120) }),
  z.object({
    scope: z.literal('department'),
    label: z.string().min(1).max(120),
    departmentId: z.string().min(1),
  }),
  z.object({ scope: z.literal('company'), label: z.string().min(1).max(120) }),
]);

const scopeOutcomeSchema = z.object({
  scope: z.enum(['personal', 'department', 'company']),
  status: z.enum(['allowed', 'not_authorized', 'not_selected']),
});

const ResultSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('check_authority'),
    availability: z.enum(['available', 'storage_unavailable']),
    targets: z.array(targetSchema).max(3),
    scopeOutcomes: z.array(scopeOutcomeSchema).max(3),
  }),
  z.object({
    operation: z.literal('publish'),
    scope: z.enum(['personal', 'department', 'company']),
    departmentId: z.string().nullable(),
    factCount: z.number().int().min(1).max(MEMORY_PUBLISHING_MAX_FACTS),
  }),
]);

type Res = z.infer<typeof ResultSchema>;

export const createMemoryPublishingTool = (deps: {
  mem0: Pick<Mem0Service, 'rememberExplicitBatch'> | null;
}): Tool<Args, Res> => ({
  id: asToolId('memoryPublishing'),
  family: 'memory',
  actionGroups: new Set(['read', 'create']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description: 'Check backend-authorized memory targets and publish an explicitly reviewed batch of durable facts.',
  parameterDocs: [
    'operation:',
    '- check_authority: reports storage readiness, exact allowed targets, and policy-safe scope outcomes before review.',
    '- publish: stores only the reviewed facts in the exact requested scope after authority is checked again.',
    'scope: personal, department, or company. Never retry a denied shared scope as personal.',
    'departmentId: required only for department scope and must match the selected gateway department.',
    `facts: 1-${MEMORY_PUBLISHING_MAX_FACTS} durable, user-confirmed facts; each at most ${MEMORY_PUBLISHING_MAX_FACT_CHARS} characters.`,
  ].join('\n'),

  permissionCheck(args: Args, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    if (args.operation === 'check_authority' || args.scope === 'personal') {
      return ok(args.operation === 'check_authority' ? 'read' : 'create');
    }

    if (args.scope === 'department' && canPublishDepartment(args.departmentId, perm)) {
      return ok('create');
    }
    if (args.scope === 'company' && hasCreateAction(perm)) {
      return ok('create');
    }

    return err(new PermissionError({
      toolId: 'memoryPublishing',
      action: 'create',
      reason: 'not_allowed',
      message: 'The requested memory target is not available for this user.',
    }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    if (args.operation === 'check_authority') {
      if (!deps.mem0) {
        return ok({
          operation: 'check_authority',
          availability: 'storage_unavailable',
          targets: [],
          scopeOutcomes: [],
        });
      }
      const targets: Array<z.infer<typeof targetSchema>> = [
        { scope: 'personal', label: 'Personal' },
      ];
      const scopeOutcomes: Array<z.infer<typeof scopeOutcomeSchema>> = [
        { scope: 'personal', status: 'allowed' },
      ];
      const departmentId = resolveDepartmentId(undefined, ctx);
      if (departmentId && canPublishDepartmentInContext(departmentId, ctx)) {
        targets.push({
          scope: 'department',
          label: ctx.perm.department?.name ?? 'Current department',
          departmentId,
        });
        scopeOutcomes.push({ scope: 'department', status: 'allowed' });
      } else {
        scopeOutcomes.push({
          scope: 'department',
          status: departmentId ? 'not_authorized' : 'not_selected',
        });
      }
      if (canPublishCompany(ctx)) {
        targets.push({ scope: 'company', label: 'Company' });
        scopeOutcomes.push({ scope: 'company', status: 'allowed' });
      } else {
        scopeOutcomes.push({ scope: 'company', status: 'not_authorized' });
      }
      return ok({
        operation: 'check_authority',
        availability: 'available',
        targets,
        scopeOutcomes,
      });
    }

    if (!deps.mem0) {
      return err(new ToolError({
        toolId: 'memoryPublishing',
        reason: 'upstream_failure',
        message: 'Backend memory storage is unavailable.',
      }));
    }

    if (args.facts.some((fact) => !isSafePublishedMemoryFact(fact))) {
      return err(new ToolError({
        toolId: 'memoryPublishing',
        reason: 'bad_args',
        message: 'One or more facts contain credential-like secret material and cannot be published.',
      }));
    }

    const authority = assertPublishAuthority(args, ctx);
    if (!authority.ok) return authority;
    const memoryScope = toMemoryScope(args.scope);
    const departmentId = args.scope === 'department'
      ? resolveDepartmentId(args.departmentId, ctx)
      : undefined;

    try {
      await deps.mem0.rememberExplicitBatch({
        facts: args.facts,
        scope: memoryScope,
        userId: String(ctx.runContext.userId),
        companyId: String(ctx.runContext.companyId),
        ...(departmentId ? { departmentId } : {}),
      });
      ctx.logger.info('memory_publishing.published', {
        scope: args.scope,
        departmentId: departmentId ?? null,
        factCount: args.facts.length,
      });
      return ok({
        operation: 'publish',
        scope: args.scope,
        departmentId: departmentId ?? null,
        factCount: args.facts.length,
      });
    } catch (cause) {
      return err(new ToolError({
        toolId: 'memoryPublishing',
        reason: 'upstream_failure',
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  },
});

function assertPublishAuthority(args: PublishArgs, ctx: ToolExecutionContext): Result<true, ToolError> {
  if (args.scope === 'personal') return ok(true);

  if (args.scope === 'department') {
    const departmentId = resolveDepartmentId(args.departmentId, ctx);
    if (departmentId && canPublishDepartmentInContext(departmentId, ctx)) return ok(true);
    return err(new ToolError({
      toolId: 'memoryPublishing',
      reason: 'permission_denied',
      message: 'Department memory requires manager authority or a department-scoped memoryPublishing:create grant.',
    }));
  }

  if (canPublishCompany(ctx)) return ok(true);
  return err(new ToolError({
    toolId: 'memoryPublishing',
    reason: 'permission_denied',
    message: 'Company memory requires company-level memoryPublishing:create and a company administrator role.',
  }));
}

function canPublishCompany(ctx: ToolExecutionContext): boolean {
  const role = String(ctx.runContext.companyRole);
  return hasCreateAction(ctx.perm) && (role === 'COMPANY_ADMIN' || role === 'SUPER_ADMIN');
}

function canPublishDepartmentInContext(departmentId: string, ctx: ToolExecutionContext): boolean {
  return String(ctx.runContext.departmentId ?? '') === departmentId
    && String(ctx.perm.department?.id ?? '') === departmentId
    && canPublishDepartment(departmentId, ctx.perm);
}

function canPublishDepartment(departmentId: string | undefined, perm: PermissionResult): boolean {
  if (!departmentId || String(perm.department?.id ?? '') !== departmentId) return false;
  return perm.department?.roleSlug === 'MANAGER' || hasDepartmentCreateGrant(perm);
}

function hasCreateAction(perm: PermissionResult): boolean {
  return perm.allowedActionsByTool.get(asToolId('memoryPublishing'))?.has('create') ?? false;
}

function hasDepartmentCreateGrant(perm: PermissionResult): boolean {
  return perm.decisions.some((decision) =>
    String(decision.toolId) === 'memoryPublishing'
    && decision.actionGroup === 'create'
    && (decision.source === 'department_role' || decision.source === 'department_user_override'));
}

function resolveDepartmentId(departmentId: string | undefined, ctx: ToolExecutionContext): string | undefined {
  return departmentId ?? (ctx.runContext.departmentId ? String(ctx.runContext.departmentId) : undefined);
}

function toMemoryScope(scope: PublishArgs['scope']): MemoryScope {
  return scope === 'personal' ? 'user' : scope;
}
