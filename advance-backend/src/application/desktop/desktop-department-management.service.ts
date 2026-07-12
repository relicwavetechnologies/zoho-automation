import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import {
  DepartmentAdminService,
  type CandidateSummary,
  type DeptDetail,
  type DeptMembershipView,
  type DeptRoleView,
} from '../departments/department-admin.service';
import type { AuditService } from '../observability/audit.service';

export type DesktopDepartmentActor = {
  userId: string;
  companyId: string;
};

export type DesktopDepartmentManagementErrorCode = 'forbidden' | 'invalid' | 'not_found' | 'conflict' | 'internal';

export class DesktopDepartmentManagementError extends Error {
  constructor(readonly code: DesktopDepartmentManagementErrorCode, message: string) {
    super(message);
  }
}

export type DepartmentManagementSnapshot = Pick<DeptDetail, 'department' | 'roles' | 'memberships'>;

type DepartmentManagerServiceDeps = {
  prisma: PrismaClient;
  departmentAdminService: DepartmentAdminService;
  auditService: AuditService;
  logger: Logger;
};

/**
 * Desktop-facing department team management.
 *
 * This facade deliberately accepts only an authenticated member actor and
 * re-checks that actor's live MANAGER membership for the exact department on
 * every read and immediately before every write. Company administrators keep
 * using the existing admin surface for department and Manager-role changes.
 */
export class DesktopDepartmentManagementService {
  private readonly log: Logger;

  constructor(private readonly deps: DepartmentManagerServiceDeps) {
    this.log = deps.logger.child({ service: 'desktop-department-management' });
  }

  private async isLiveManager(actor: DesktopDepartmentActor, departmentId: string): Promise<boolean> {
    const companyMembership = await this.deps.prisma.adminMembership.findFirst({
      where: { userId: actor.userId, companyId: actor.companyId, isActive: true },
      select: { id: true },
    });
    if (!companyMembership) return false;

    const managerMembership = await this.deps.prisma.departmentMembership.findFirst({
      where: {
        departmentId,
        userId: actor.userId,
        status: 'active',
        role: { slug: 'MANAGER' },
        department: { companyId: actor.companyId, status: 'active' },
      },
      select: { id: true },
    });
    return Boolean(managerMembership);
  }

  private async requireManager(actor: DesktopDepartmentActor, departmentId: string): Promise<void> {
    if (!await this.isLiveManager(actor, departmentId)) {
      throw new DesktopDepartmentManagementError('forbidden', 'Current membership is not authorised to manage this department');
    }
  }

  private async revalidateManager(actor: DesktopDepartmentActor, departmentId: string): Promise<void> {
    if (!await this.isLiveManager(actor, departmentId)) {
      throw new DesktopDepartmentManagementError('forbidden', 'Department manager access changed before this update could be saved');
    }
  }

  private throwResultError(result: { ok: false; error: { kind: string; message: string } }): never {
    const code = result.error.kind === 'not_found' || result.error.kind === 'conflict' || result.error.kind === 'validation'
      ? result.error.kind === 'validation' ? 'invalid' : result.error.kind
      : 'internal';
    throw new DesktopDepartmentManagementError(code, result.error.message);
  }

  private async customRole(actor: DesktopDepartmentActor, departmentId: string, roleId: string): Promise<DeptRoleView> {
    const detail = await this.deps.departmentAdminService.getDepartmentDetail(departmentId, actor.companyId, ['roles']);
    if (!detail.ok) this.throwResultError(detail);
    const role = detail.value.roles.find(entry => entry.id === roleId);
    if (!role) throw new DesktopDepartmentManagementError('not_found', 'Department role not found');
    if (role.isSystem || role.slug === 'MANAGER') {
      throw new DesktopDepartmentManagementError('forbidden', 'Built-in department roles cannot be managed here');
    }
    return role;
  }

  private async ordinaryMember(actor: DesktopDepartmentActor, departmentId: string, userId: string): Promise<void> {
    // Do not use the desktop detail view here: that deliberately lists only
    // active memberships, while an inactive MANAGER row must remain protected
    // from reassignment or reactivation by a department manager.
    const membership = await this.deps.prisma.departmentMembership.findFirst({
      where: {
        departmentId,
        userId,
        department: { companyId: actor.companyId },
      },
      select: { role: { select: { slug: true } } },
    });
    if (membership?.role.slug === 'MANAGER') {
      throw new DesktopDepartmentManagementError('forbidden', 'Only a company administrator can change a department manager');
    }
  }

  private async assignableRole(actor: DesktopDepartmentActor, departmentId: string, roleId: string): Promise<DeptRoleView> {
    const detail = await this.deps.departmentAdminService.getDepartmentDetail(departmentId, actor.companyId, ['roles']);
    if (!detail.ok) this.throwResultError(detail);
    const role = detail.value.roles.find(entry => entry.id === roleId);
    if (!role) throw new DesktopDepartmentManagementError('not_found', 'Department role not found');
    if (role.slug === 'MANAGER') {
      throw new DesktopDepartmentManagementError('forbidden', 'Only a company administrator can grant the Manager role');
    }
    return role;
  }

  private audit(
    actor: DesktopDepartmentActor,
    departmentId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): void {
    this.deps.auditService.record({ actorId: actor.userId, companyId: actor.companyId, action, outcome: 'success', metadata: { departmentId, ...metadata } });
  }

  async snapshot(actor: DesktopDepartmentActor, departmentId: string): Promise<DepartmentManagementSnapshot> {
    await this.requireManager(actor, departmentId);
    const result = await this.deps.departmentAdminService.getDepartmentDetail(departmentId, actor.companyId, ['overview', 'roles', 'members']);
    if (!result.ok) this.throwResultError(result);
    return { department: result.value.department, roles: result.value.roles, memberships: result.value.memberships };
  }

  async searchCandidates(actor: DesktopDepartmentActor, departmentId: string, query: string): Promise<CandidateSummary[]> {
    await this.requireManager(actor, departmentId);
    const result = await this.deps.departmentAdminService.searchCandidates(departmentId, actor.companyId, query);
    if (!result.ok) this.throwResultError(result);
    // Preserve eligibility context so the desktop can show non-members as
    // unavailable; the shared mutation service remains the final enforcement.
    return result.value;
  }

  async createRole(actor: DesktopDepartmentActor, departmentId: string, input: { name: string; slug: string }): Promise<{ id: string; name: string; slug: string; zohoReadScope: string }> {
    await this.requireManager(actor, departmentId);
    await this.revalidateManager(actor, departmentId);
    // Department managers cannot create broad Zoho visibility roles.
    const result = await this.deps.departmentAdminService.createRole(departmentId, actor.companyId, { ...input, zohoReadScope: 'personalized' });
    if (!result.ok) this.throwResultError(result);
    this.audit(actor, departmentId, 'department_manager.role.created', { roleId: result.value.id, slug: result.value.slug });
    return result.value;
  }

  async updateRole(actor: DesktopDepartmentActor, departmentId: string, roleId: string, input: { name: string }): Promise<{ id: string; name: string; slug: string; isDefault: boolean; zohoReadScope: string }> {
    await this.requireManager(actor, departmentId);
    await this.customRole(actor, departmentId, roleId);
    await this.revalidateManager(actor, departmentId);
    const result = await this.deps.departmentAdminService.updateRole(departmentId, actor.companyId, roleId, input);
    if (!result.ok) this.throwResultError(result);
    this.audit(actor, departmentId, 'department_manager.role.updated', { roleId });
    return result.value;
  }

  async deleteRole(actor: DesktopDepartmentActor, departmentId: string, roleId: string): Promise<{ deleted: boolean }> {
    await this.requireManager(actor, departmentId);
    await this.customRole(actor, departmentId, roleId);
    await this.revalidateManager(actor, departmentId);
    const result = await this.deps.departmentAdminService.deleteRole(departmentId, actor.companyId, roleId);
    if (!result.ok) this.throwResultError(result);
    this.audit(actor, departmentId, 'department_manager.role.deleted', { roleId });
    return result.value;
  }

  async upsertMembership(actor: DesktopDepartmentActor, departmentId: string, input: { userId: string; roleId: string }): Promise<DeptMembershipView> {
    await this.requireManager(actor, departmentId);
    await this.assignableRole(actor, departmentId, input.roleId);
    await this.ordinaryMember(actor, departmentId, input.userId);
    await this.revalidateManager(actor, departmentId);
    const result = await this.deps.departmentAdminService.upsertMembership(departmentId, actor.companyId, { userId: input.userId, roleId: input.roleId, status: 'active' });
    if (!result.ok) this.throwResultError(result);
    this.audit(actor, departmentId, 'department_manager.membership.saved', { userId: input.userId, roleId: input.roleId });
    return result.value;
  }

  async removeMembership(actor: DesktopDepartmentActor, departmentId: string, userId: string): Promise<{ deleted: boolean }> {
    await this.requireManager(actor, departmentId);
    await this.ordinaryMember(actor, departmentId, userId);
    await this.revalidateManager(actor, departmentId);
    const result = await this.deps.departmentAdminService.removeMembership(departmentId, actor.companyId, userId);
    if (!result.ok) this.throwResultError(result);
    this.audit(actor, departmentId, 'department_manager.membership.removed', { userId });
    return result.value;
  }
}
