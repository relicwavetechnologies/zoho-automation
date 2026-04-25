import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';

export interface ToolPermissionRow {
  companyId: string;
  toolId: string;
  role: string;
  enabled: boolean;
}

export interface ToolPermissionRepoPort {
  getForCompany(companyId: string): Promise<Result<ToolPermissionRow[], InfraError>>;
  upsert(companyId: string, toolId: string, role: string, enabled: boolean, updatedBy?: string): Promise<Result<ToolPermissionRow, InfraError>>;
}

export class ToolPermissionRepository implements ToolPermissionRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async getForCompany(companyId: string): Promise<Result<ToolPermissionRow[], InfraError>> {
    try {
      const rows = await this.db.toolPermission.findMany({ where: { companyId } });
      return ok(rows);
    } catch (e) {
      return err(wrapInfra('prisma', 'getToolPermissions', e));
    }
  }

  async upsert(
    companyId: string,
    toolId: string,
    role: string,
    enabled: boolean,
    updatedBy?: string,
  ): Promise<Result<ToolPermissionRow, InfraError>> {
    try {
      const row = await this.db.toolPermission.upsert({
        where: { companyId_toolId_role: { companyId, toolId, role } },
        create: { companyId, toolId, role, enabled, updatedBy: updatedBy ?? null },
        update: { enabled, updatedBy: updatedBy ?? null },
      });
      return ok(row);
    } catch (e) {
      return err(wrapInfra('prisma', 'upsertToolPermission', e));
    }
  }
}
