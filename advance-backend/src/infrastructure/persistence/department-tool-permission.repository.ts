import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';

export interface DeptToolPermissionRow {
  departmentId: string;
  roleId: string;
  toolId: string;
  actionGroup: string;
  allowed: boolean;
}

export interface DeptToolPermissionRepoPort {
  getForDeptRole(departmentId: string, roleId: string): Promise<Result<DeptToolPermissionRow[], InfraError>>;
  upsert(departmentId: string, roleId: string, toolId: string, actionGroup: string, allowed: boolean, updatedBy: string): Promise<Result<DeptToolPermissionRow, InfraError>>;
}

export class DeptToolPermissionRepository implements DeptToolPermissionRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async getForDeptRole(
    departmentId: string,
    roleId: string,
  ): Promise<Result<DeptToolPermissionRow[], InfraError>> {
    try {
      const rows = await this.db.departmentToolPermission.findMany({
        where: { departmentId, roleId },
      });
      return ok(rows.map(r => ({
        departmentId: r.departmentId,
        roleId: r.roleId,
        toolId: r.toolId,
        actionGroup: r.actionGroup,
        allowed: r.allowed,
      })));
    } catch (e) {
      return err(wrapInfra('prisma', 'getDeptToolPermissions', e));
    }
  }

  async upsert(
    departmentId: string,
    roleId: string,
    toolId: string,
    actionGroup: string,
    allowed: boolean,
    updatedBy: string,
  ): Promise<Result<DeptToolPermissionRow, InfraError>> {
    try {
      const row = await this.db.departmentToolPermission.upsert({
        where: { departmentId_roleId_toolId_actionGroup: { departmentId, roleId, toolId, actionGroup } },
        create: { departmentId, roleId, toolId, actionGroup, allowed, updatedBy },
        update: { allowed, updatedBy },
      });
      return ok({ departmentId: row.departmentId, roleId: row.roleId, toolId: row.toolId, actionGroup: row.actionGroup, allowed: row.allowed });
    } catch (e) {
      return err(wrapInfra('prisma', 'upsertDeptToolPermission', e));
    }
  }
}
