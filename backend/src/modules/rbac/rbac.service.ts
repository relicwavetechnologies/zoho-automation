import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { RbacRepository, rbacRepository } from './rbac.repository';
import { ADMIN_ROLES, RBAC_ACTIONS, RbacAction } from './rbac.constants';
import { CreateAssignmentDto } from './dto/assignment.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';

const DEFAULT_PERMISSION_MATRIX: Record<string, Record<string, boolean>> = {
  SUPER_ADMIN: Object.fromEntries(RBAC_ACTIONS.map((action) => [action, true])),
  COMPANY_ADMIN: {
    'rbac.permissions.read': true,
    'rbac.permissions.write': false,
    'rbac.assignments.write': false,
    'onboarding.manage': true,
    'audit.read': true,
    'system.controls.write': true,
  },
};

export class RbacService extends BaseService {
  constructor(private readonly repository: RbacRepository = rbacRepository) {
    super();
  }

  async resolvePermissionMatrix() {
    const persisted = await this.repository.listPermissions();
    const rows: Array<{
      roleId: (typeof ADMIN_ROLES)[number];
      actionId: RbacAction;
      allowed: boolean;
      updatedAt: string;
      updatedBy: string;
    }> = [];

    const persistedMap = new Map(persisted.map((item) => [`${item.role}:${item.action}`, item]));

    for (const roleId of ADMIN_ROLES) {
      for (const actionId of RBAC_ACTIONS) {
        const key = `${roleId}:${actionId}`;
        const item = persistedMap.get(key);
        rows.push({
          roleId,
          actionId,
          allowed: item?.allowed ?? DEFAULT_PERMISSION_MATRIX[roleId][actionId],
          updatedAt: item?.updatedAt.toISOString() ?? new Date(0).toISOString(),
          updatedBy: item?.updatedBy ?? 'system-default',
        });
      }
    }

    return rows;
  }

  async updatePermission(input: UpdatePermissionDto, updatedBy: string) {
    const record = await this.repository.upsertPermission({
      role: input.roleId,
      action: input.actionId,
      allowed: input.allowed,
      updatedBy,
    });

    return {
      roleId: record.role,
      actionId: record.action,
      allowed: record.allowed,
      updatedAt: record.updatedAt.toISOString(),
      updatedBy: record.updatedBy,
    };
  }

  async canRolePerformAction(roleId: string, actionId: RbacAction): Promise<boolean> {
    const explicit = await this.repository.findPermission(roleId, actionId);
    if (explicit) {
      return explicit.allowed;
    }

    return DEFAULT_PERMISSION_MATRIX[roleId]?.[actionId] ?? false;
  }

  async listAssignments(companyId?: string) {
    const rows = await this.repository.listAssignments(companyId);
    return rows.map((row) => ({
      assignmentId: row.id,
      userId: row.userId,
      companyId: row.companyId,
      roleId: row.role,
      assignedBy: 'system',
      email: row.user.email,
      name: row.user.name,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createAssignment(input: CreateAssignmentDto) {
    if (input.roleId === 'SUPER_ADMIN') {
      throw new HttpException(400, 'SUPER_ADMIN assignment cannot be company-scoped');
    }

    const [user, company] = await Promise.all([
      this.repository.findUser(input.userId),
      this.repository.findCompany(input.companyId),
    ]);

    if (!user) {
      throw new HttpException(404, 'User not found');
    }

    if (!company) {
      throw new HttpException(404, 'Company not found');
    }

    const assignment = await this.repository.createAssignment({
      userId: input.userId,
      companyId: input.companyId,
      role: input.roleId,
    });

    return {
      assignmentId: assignment.id,
      userId: assignment.userId,
      companyId: assignment.companyId,
      roleId: assignment.role,
      assignedBy: 'system',
    };
  }

  async revokeAssignment(assignmentId: string) {
    const existing = await this.repository.findAssignmentById(assignmentId);
    if (!existing || !existing.isActive) {
      throw new HttpException(404, 'Active assignment not found');
    }

    const assignment = await this.repository.revokeAssignment(assignmentId);
    return {
      assignmentId: assignment.id,
      revoked: true,
    };
  }
}

export const rbacService = new RbacService();
