import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';

export interface ToolActionPermissionRow {
  companyId: string;
  toolId: string;
  role: string;
  actionGroup: string;
  enabled: boolean;
}

export interface ToolActionPermissionRepoPort {
  getForCompany(companyId: string): Promise<Result<ToolActionPermissionRow[], InfraError>>;
  upsert(companyId: string, toolId: string, role: string, actionGroup: string, enabled: boolean, updatedBy?: string): Promise<Result<ToolActionPermissionRow, InfraError>>;
}

export class ToolActionPermissionRepository implements ToolActionPermissionRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async getForCompany(companyId: string): Promise<Result<ToolActionPermissionRow[], InfraError>> {
    try {
      const rows = await this.db.toolActionPermission.findMany({ where: { companyId } });
      return ok(rows);
    } catch (e) {
      return err(wrapInfra('prisma', 'getToolActionPermissions', e));
    }
  }

  async upsert(
    companyId: string,
    toolId: string,
    role: string,
    actionGroup: string,
    enabled: boolean,
    updatedBy?: string,
  ): Promise<Result<ToolActionPermissionRow, InfraError>> {
    try {
      const row = await this.db.toolActionPermission.upsert({
        where: { companyId_toolId_role_actionGroup: { companyId, toolId, role, actionGroup } },
        create: { companyId, toolId, role, actionGroup, enabled, updatedBy: updatedBy ?? null },
        update: { enabled, updatedBy: updatedBy ?? null },
      });
      return ok(row);
    } catch (e) {
      return err(wrapInfra('prisma', 'upsertToolActionPermission', e));
    }
  }
}
