import type { PrismaClient } from '../../generated/prisma';
import type { SkillAccessEnforcementPort } from '../../application/skills/skill-access.port';
import {
  assertMemberGrantScope,
  type MemberGrantScope,
} from '../../domain/permissions/member-grant-scope';

/** Prisma-backed resolver for company, department, role, and direct grants. */
export class SkillAccessRepository implements SkillAccessEnforcementPort {
  constructor(private readonly prisma: PrismaClient) {}

  async listGrantedSkillIds(
    companyId: string,
    userId: string,
    abortSignal?: AbortSignal,
    memberGrantScope?: MemberGrantScope,
  ): Promise<ReadonlySet<string>> {
    abortSignal?.throwIfAborted();
    if (memberGrantScope) {
      assertMemberGrantScope(memberGrantScope, { companyId, userId });
    }
    const memberships = memberGrantScope
      ? undefined
      : await this.prisma.departmentMembership.findMany({
          where: {
            userId,
            status: 'active',
            department: { companyId, status: 'active' },
          },
          select: { departmentId: true, roleId: true },
        });
    abortSignal?.throwIfAborted();

    const departmentIds = memberGrantScope?.departmentIds
      ?? memberships?.map((membership) => membership.departmentId)
      ?? [];
    const roleIds = memberGrantScope?.departmentRoleIds
      ?? memberships?.map((membership) => membership.roleId)
      ?? [];
    const grants = await this.prisma.skillAccessGrant.findMany({
      where: {
        companyId,
        OR: [
          { granteeType: 'company', granteeId: companyId },
          { granteeType: 'user', granteeId: userId },
          ...(departmentIds.length > 0
            ? [{ granteeType: 'department', granteeId: { in: [...departmentIds] } }]
            : []),
          ...(roleIds.length > 0
            ? [{ granteeType: 'role', granteeId: { in: [...roleIds] } }]
            : []),
        ],
      },
      select: { skillId: true },
    });
    abortSignal?.throwIfAborted();

    return new Set(grants.map((grant) => grant.skillId));
  }
}
