import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import { SKILL_SUMMARY_MAX_CHARS } from '../../../skills/skill-limits';
import { unknownSkillToolIds } from '../../../skills/skill-tool-validation';
import { recordSkillRegistryMutation } from '../../../skills/skill-registry-versioning';
import { larkSkillEnglishOnlyError } from '../../../skills/lark-skill-language-policy';

const toolIdsSchema = z.array(z.string().min(1).max(120)).min(1).max(50);

const Schema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('check_authority'),
    departmentId: z.string().min(1).optional(),
  }),
  z.object({
    operation: z.literal('publish'),
    scope: z.enum(['company', 'department']),
    departmentId: z.string().min(1).optional(),
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(120).optional(),
    summary: z.string().max(SKILL_SUMMARY_MAX_CHARS).optional(),
    markdown: z.string().min(1).max(40000),
    toolIds: toolIdsSchema,
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  }),
]);

type Args = z.infer<typeof Schema>;

const ResultSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('check_authority'),
    canPublishCompany: z.boolean(),
    canPublishDepartment: z.boolean(),
    departmentId: z.string().nullable(),
    reason: z.string().optional(),
  }),
  z.object({
    operation: z.literal('publish'),
    skill: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      scope: z.string(),
      departmentId: z.string().nullable(),
      toolIds: z.array(z.string()),
      status: z.string(),
    }),
  }),
]);

type Res = z.infer<typeof ResultSchema>;

export const createSkillPublishingTool = (deps: {
  prisma: PrismaClient;
}): Tool<Args, Res> => ({
  id: asToolId('skillPublishing'),
  family: 'skills',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description:
    'Check whether the current user can share a local skill, and publish explicitly shared skill markdown into the backend skill catalog.',
  parameterDocs: [
    'operation:',
    '- check_authority: returns the company/department scopes this user can publish to.',
    '- publish: writes a skill only after the user explicitly asks to share it.',
    'scope: company or department. Department publishing uses departmentId or the active gateway department.',
    'markdown: complete SKILL.md content. The backend stores shared skills as markdown.',
    'toolIds: backend gateway tools the skill requires, e.g. webSearch, zohoBooks, larkTask.',
    'Lark skills must be written in English. Translate all Lark skill content to English before publishing.',
  ].join('\n'),

  permissionCheck(args: Args, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action: ToolActionGroup = args.operation === 'check_authority' ? 'read' : 'create';
    const allowedByRbac = perm.allowedActionsByTool.get(asToolId('skillPublishing'))?.has(action) ?? false;
    const allowedByManagerScope = action === 'create' && args.operation === 'publish'
      && args.scope === 'department'
      && perm.department?.roleSlug === 'MANAGER';
    const allowedByManagerRead = action === 'read' && perm.department?.roleSlug === 'MANAGER';

    if (allowedByRbac || allowedByManagerScope || allowedByManagerRead) {
      return ok(action);
    }

    return err(new PermissionError({
      toolId: 'skillPublishing',
      action,
      reason: 'not_allowed',
      message: 'You are not allowed to publish shared skills in this scope.',
    }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    try {
      if (args.operation === 'check_authority') {
        const company = canPublishCompany(ctx);
        const department = canPublishDepartment(args.departmentId, ctx);
        return ok({
          operation: 'check_authority',
          canPublishCompany: company,
          canPublishDepartment: department,
          departmentId: resolveDepartmentId(args.departmentId, ctx) ?? null,
          ...(!company && !department ? { reason: 'No company or department sharing scope is available for this user.' } : {}),
        });
      }

      const authority = assertPublishAuthority(args, ctx);
      if (!authority.ok) return err(authority.error);

      const unknownToolIds = unknownSkillToolIds(args.toolIds);
      if (unknownToolIds.length > 0) {
        return err(new ToolError({
          toolId: 'skillPublishing',
          reason: 'bad_args',
          message: `Unknown skill toolIds: ${unknownToolIds.join(', ')}`,
        }));
      }

      const slug = normalizeSlug(args.slug ?? args.name);
      if (!slug) {
        return err(new ToolError({ toolId: 'skillPublishing', reason: 'bad_args', message: 'Skill slug could not be derived.' }));
      }

      const languageError = larkSkillEnglishOnlyError({
        slug,
        name: args.name,
        summary: args.summary ?? '',
        markdown: args.markdown,
        toolIds: args.toolIds,
        tags: args.tags ?? [],
      });
      if (languageError) {
        return err(new ToolError({
          toolId: 'skillPublishing',
          reason: 'bad_args',
          message: languageError,
        }));
      }

      const scope = args.scope === 'company' ? 'global' : 'department';
      let departmentId: string | null = null;
      if (args.scope === 'department') {
        const resolvedDepartmentId = resolveDepartmentId(args.departmentId, ctx);
        if (!resolvedDepartmentId) {
          return err(new ToolError({
            toolId: 'skillPublishing',
            reason: 'bad_args',
            message: 'departmentId is required for department-scope skill publishing.',
          }));
        }
        departmentId = resolvedDepartmentId;
      }

      const existing = await deps.prisma.skill.findFirst({
        where: {
          companyId: ctx.runContext.companyId,
          slug,
          status: { not: 'archived' },
          scope,
          departmentId,
        },
        select: { id: true },
      });
      if (existing) {
        return err(new ToolError({
          toolId: 'skillPublishing',
          reason: 'bad_args',
          message: `A shared skill with slug "${slug}" already exists in this scope.`,
        }));
      }

      const skill = await deps.prisma.skill.create({
        data: {
          companyId: ctx.runContext.companyId,
          departmentId,
          scope,
          name: args.name.trim(),
          slug,
          summary: args.summary?.trim() ?? '',
          markdown: args.markdown,
          toolIds: args.toolIds,
          tags: args.tags ?? [],
          status: 'active',
          createdBy: ctx.runContext.userId,
          updatedBy: ctx.runContext.userId,
        },
      });

      await recordSkillRegistryMutation(deps.prisma, skill);

      return ok({
        operation: 'publish',
        skill: {
          id: skill.id,
          slug: skill.slug,
          name: skill.name,
          scope: skill.scope,
          departmentId: skill.departmentId,
          toolIds: skill.toolIds,
          status: skill.status,
        },
      });
    } catch (e) {
      return err(new ToolError({
        toolId: 'skillPublishing',
        reason: 'upstream_failure',
        cause: e,
        message: e instanceof Error ? e.message : String(e),
      }));
    }
  },
});

function canPublishCompany(ctx: ToolExecutionContext): boolean {
  const role = String(ctx.runContext.companyRole);
  const hasRbac = ctx.perm.allowedActionsByTool.get(asToolId('skillPublishing'))?.has('create') ?? false;
  return hasRbac && (role === 'COMPANY_ADMIN' || role === 'SUPER_ADMIN');
}

function canPublishDepartment(departmentId: string | undefined, ctx: ToolExecutionContext): boolean {
  const targetDepartmentId = resolveDepartmentId(departmentId, ctx);
  if (!targetDepartmentId) return false;
  return hasDepartmentCreateGrant(ctx.perm) || ctx.perm.department?.roleSlug === 'MANAGER';
}

function hasDepartmentCreateGrant(perm: PermissionResult): boolean {
  return perm.decisions.some((decision) =>
    String(decision.toolId) === 'skillPublishing'
    && decision.actionGroup === 'create'
    && (decision.source === 'department_role' || decision.source === 'department_user_override'));
}

function assertPublishAuthority(args: Extract<Args, { operation: 'publish' }>, ctx: ToolExecutionContext): Result<true, ToolError> {
  if (args.scope === 'company') {
    if (canPublishCompany(ctx)) return ok(true);
    return err(new ToolError({
      toolId: 'skillPublishing',
      reason: 'permission_denied',
      message: 'Only company admins can publish company-scope skills.',
    }));
  }

  if (canPublishDepartment(args.departmentId, ctx)) return ok(true);
  return err(new ToolError({
    toolId: 'skillPublishing',
    reason: 'permission_denied',
    message: 'Only department managers or users granted skillPublishing:create can publish department-scope skills.',
  }));
}

function resolveDepartmentId(departmentId: string | undefined, ctx: ToolExecutionContext): string | undefined {
  return departmentId ?? ctx.runContext.departmentId;
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
