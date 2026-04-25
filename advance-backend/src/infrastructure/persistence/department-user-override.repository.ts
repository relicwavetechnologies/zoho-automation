import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';

export interface DeptUserOverrideRow {
  departmentId: string;
  userId: string;
  toolId: string;
  actionGroup: string;
  allowed: boolean;
}

export interface DeptUserOverrideRepoPort {
  getForUser(departmentId: string, userId: string): Promise<Result<DeptUserOverrideRow[], InfraError>>;
}

export class DeptUserOverrideRepository implements DeptUserOverrideRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async getForUser(
    departmentId: string,
    userId: string,
  ): Promise<Result<DeptUserOverrideRow[], InfraError>> {
    try {
      const rows = await this.db.departmentUserToolOverride.findMany({
        where: { departmentId, userId },
      });
      return ok(rows.map(r => ({
        departmentId: r.departmentId,
        userId: r.userId,
        toolId: r.toolId,
        actionGroup: r.actionGroup,
        allowed: r.allowed,
      })));
    } catch (e) {
      return err(wrapInfra('prisma', 'getDeptUserOverrides', e));
    }
  }
}
