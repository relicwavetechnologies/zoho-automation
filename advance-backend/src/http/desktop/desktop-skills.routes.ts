import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';
import type { SkillCatalogService, CatalogSkill } from '../../application/skills/skill-catalog.service';
import type { SkillAccessEnforcementPort } from '../../application/skills/skill-access.port';
import type { PermissionService } from '../../application/permissions/permission.service';
import { asCompanyId, asUserId, asDepartmentId, asToolId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';

export interface DesktopSkillRoutesDeps {
  prisma: PrismaClient;
  memberJwtSecret: string;
  logger: Logger;
  skillCatalog: SkillCatalogService;
  skillAccessEnforcement: SkillAccessEnforcementPort;
  permissions: PermissionService;
}

/** One skill as a member sees it: what it is, and whether they can run it. */
interface MemberSkill {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly toolIds: readonly string[];
  readonly tags: readonly string[];
  /** The team it came through, or null for a company-wide skill. */
  readonly departmentName: string | null;
  /**
   * Tools this skill needs that this person may not use.
   *
   * Empty means runnable. A skill is enforced against every tool it lists —
   * somebody missing one cannot run it however it was shared — so this is the
   * difference between a skill that is theirs and a skill that is merely
   * visible to them.
   */
  readonly missingTools: readonly string[];
  readonly revision: number;
}

/**
 * The skills a signed-in member can actually run.
 *
 * Everything here already existed for the Pi runtime, behind a check that
 * refuses anyone who is not it: `listGrantedSkillIds` and `listVisible` are
 * exactly what decides which skills reach a run. What was missing was a way
 * for the person those skills belong to to see the same answer, so the web
 * app rendered an invented list instead — names, scopes and run counts that
 * matched nothing.
 *
 * This asks the same two services the runtime asks, per department the member
 * is in, and unions the result. A member in two teams sees both; a skill
 * shared with both appears once.
 */
export function createDesktopSkillRoutes(deps: DesktopSkillRoutesDeps): Router {
  const router = Router();
  const memberAuth = createMemberAuthMiddleware({
    prisma: deps.prisma, jwtSecret: deps.memberJwtSecret, logger: deps.logger,
  });

  router.get('/skills', memberAuth, async (_req: Request, res: Response) => {
    const companyId = res.locals['companyId'] as string;
    const userId = res.locals['userId'] as string;
    const companyRole = String(res.locals['aiRole'] ?? 'MEMBER');

    try {
      const memberships = await deps.prisma.departmentMembership.findMany({
        where: {
          userId,
          status: 'active',
          department: { companyId, status: 'active' },
        },
        select: { department: { select: { id: true, name: true } } },
      });

      const grantedSkillIds = await deps.skillAccessEnforcement.listGrantedSkillIds(companyId, userId);

      /*
       * One pass per department, because permission is resolved per department
       * and a skill's tools may be allowed in one team and not another. The
       * union is deduped by skill id, keeping the first department that could
       * run it — a skill you can use somewhere is not blocked just because a
       * second team of yours cannot.
       */
      const byId = new Map<string, MemberSkill>();

      const scopes: { departmentId: string | undefined; departmentName: string | null }[] =
        memberships.length > 0
          ? memberships.map(m => ({ departmentId: m.department.id, departmentName: m.department.name }))
          // No department is a real state: company-wide skills still apply.
          : [{ departmentId: undefined, departmentName: null }];

      for (const scope of scopes) {
        const permission = await deps.permissions.resolve({
          companyId: asCompanyId(companyId),
          userId: asUserId(userId),
          companyRole: asCompanyRoleSlug(companyRole),
          ...(scope.departmentId ? { departmentId: asDepartmentId(scope.departmentId) } : {}),
          channel: 'desktop',
        });
        if (!permission.ok) continue;

        const visible: CatalogSkill[] = await deps.skillCatalog.listVisible({
          companyId,
          ...(scope.departmentId ? { departmentId: scope.departmentId } : {}),
          permission: permission.value,
          grantedSkillIds,
          complete: true,
        });

        for (const skill of visible) {
          const missingTools = skill.toolIds.filter(
            toolId => !(permission.value.allowedActionsByTool.get(asToolId(toolId))?.size ?? 0),
          );
          const existing = byId.get(skill.id);
          // Prefer the department where it actually runs.
          if (existing && existing.missingTools.length <= missingTools.length) continue;
          byId.set(skill.id, {
            id: skill.id,
            slug: skill.slug,
            name: skill.name,
            description: skill.description,
            toolIds: skill.toolIds,
            tags: skill.tags,
            departmentName: skill.departmentId ? scope.departmentName : null,
            missingTools,
            revision: skill.revision,
          });
        }
      }

      const skills = [...byId.values()].sort((a, b) =>
        // Runnable first — a list of things you cannot use is not a list of
        // your skills. Then by name, so it is stable between loads.
        a.missingTools.length - b.missingTools.length || a.name.localeCompare(b.name));

      res.json({ success: true, data: { skills } });
    } catch (error) {
      deps.logger.error('desktop.skills.list_failed', { companyId, userId, error: String(error) });
      res.status(500).json({ success: false, message: 'Could not load your skills.' });
    }
  });

  return router;
}
