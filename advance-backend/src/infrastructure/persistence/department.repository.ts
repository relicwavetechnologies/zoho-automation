import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';

export interface DepartmentMembershipRow {
  userId: string;
  departmentId: string;
  roleId: string;
  roleSlug: string;
  roleName: string;
  departmentName: string;
  departmentCompanyId: string;
  systemPrompt?: string | null;
  skillsMarkdown?: string | null;
  managerApprovalJson?: unknown;
  zohoRateLimitJson?: unknown;
}

export interface DepartmentRepoPort {
  getMembership(
    userId: string,
    companyId: string,
    departmentId: string,
  ): Promise<Result<DepartmentMembershipRow | null, InfraError>>;
}

export class DepartmentRepository implements DepartmentRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async getMembership(
    userId: string,
    companyId: string,
    departmentId: string,
  ): Promise<Result<DepartmentMembershipRow | null, InfraError>> {
    try {
      const m = await this.db.departmentMembership.findFirst({
        where: {
          userId,
          departmentId,
          status: 'active',
          department: { companyId, status: 'active' },
        },
        include: {
          role: true,
          department: { include: { agentConfig: true } },
        },
      });

      if (!m) return ok(null);

      return ok({
        userId: m.userId,
        departmentId: m.departmentId,
        roleId: m.roleId,
        roleSlug: m.role.slug,
        roleName: m.role.name,
        departmentName: m.department.name,
        departmentCompanyId: m.department.companyId,
        systemPrompt: m.department.agentConfig?.systemPrompt ?? null,
        skillsMarkdown: m.department.agentConfig?.skillsMarkdown ?? null,
        managerApprovalJson: m.department.agentConfig?.managerApprovalJson ?? null,
        zohoRateLimitJson: m.department.agentConfig?.zohoRateLimitJson ?? null,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'getDepartmentMembership', e));
    }
  }
}
