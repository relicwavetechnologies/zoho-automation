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
  upsert(departmentId: string, userId: string, toolId: string, actionGroup: string, allowed: boolean, updatedBy: string): Promise<Result<DeptUserOverrideRow, InfraError>>;
  remove(departmentId: string, userId: string, toolId: string, actionGroup: string): Promise<Result<null, InfraError>>;
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

  async upsert(
    departmentId: string,
    userId: string,
    toolId: string,
    actionGroup: string,
    allowed: boolean,
    updatedBy: string,
  ): Promise<Result<DeptUserOverrideRow, InfraError>> {
    try {
      const row = await this.db.departmentUserToolOverride.upsert({
        where: { departmentId_userId_toolId_actionGroup: { departmentId, userId, toolId, actionGroup } },
        create: { departmentId, userId, toolId, actionGroup, allowed, updatedBy },
        update: { allowed, updatedBy },
      });
      return ok({ departmentId: row.departmentId, userId: row.userId, toolId: row.toolId, actionGroup: row.actionGroup, allowed: row.allowed });
    } catch (e) {
      return err(wrapInfra('prisma', 'upsertDeptUserToolOverride', e));
    }
  }

  /**
   * Drops the exception so the person inherits their role again.
   *
   * `allowed: false` is an explicit deny that outranks the role, so this is the
   * only way back to inheriting — without it an exception can be flipped but
   * never lifted. `deleteMany` rather than `delete` because removing an
   * exception that is already gone is the state the caller asked for, not an
   * error.
   */
  async remove(
    departmentId: string,
    userId: string,
    toolId: string,
    actionGroup: string,
  ): Promise<Result<null, InfraError>> {
    try {
      await this.db.departmentUserToolOverride.deleteMany({
        where: { departmentId, userId, toolId, actionGroup },
      });
      return ok(null);
    } catch (e) {
      return err(wrapInfra('prisma', 'removeDeptUserToolOverride', e));
    }
  }
}
