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
  zohoReadScope: string;
  systemPrompt?: string | null;
  managerApprovalJson?: unknown;
}

export interface ActiveDepartmentMembershipRow {
  readonly departmentId: string;
  readonly departmentName: string;
}

export interface DepartmentRepoPort {
  getMembership(
    userId: string,
    companyId: string,
    departmentId: string,
  ): Promise<Result<DepartmentMembershipRow | null, InfraError>>;
  listActiveMemberships(
    userId: string,
    companyId: string,
  ): Promise<Result<ActiveDepartmentMembershipRow[], InfraError>>;
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
        zohoReadScope: m.role.zohoReadScope,
        systemPrompt: m.department.agentConfig?.systemPrompt ?? null,
        managerApprovalJson: m.department.agentConfig?.managerApprovalJson ?? null,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'getDepartmentMembership', e));
    }
  }

  async listActiveMemberships(
    userId: string,
    companyId: string,
  ): Promise<Result<ActiveDepartmentMembershipRow[], InfraError>> {
    try {
      const memberships = await this.db.departmentMembership.findMany({
        where: {
          userId,
          status: 'active',
          department: { companyId, status: 'active' },
        },
        select: {
          departmentId: true,
          department: { select: { name: true } },
        },
        orderBy: { department: { name: 'asc' } },
      });
      return ok(memberships.map(membership => ({
        departmentId: membership.departmentId,
        departmentName: membership.department.name,
      })));
    } catch (e) {
      return err(wrapInfra('prisma', 'listActiveDepartmentMemberships', e));
    }
  }
}
