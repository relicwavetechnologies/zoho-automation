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
import type { PermissionService } from '../permissions/permission.service';
import { ManagerApprovalConfigSchema, type ManagerApprovalConfig } from '../approval/approval.types';
import { getDesktopToolPolicy } from '../../domain/tools/tool-policy';
import { TOOL_SUPPORTED_ACTIONS, type CanonicalToolId } from '../../domain/tools/tool-id';

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

export type DepartmentManagerApprovalPolicy = Pick<ManagerApprovalConfig, 'enabled' | 'requiredActions'>;

/**
 * The whole gate, expressed the one way the desktop can edit it.
 *
 * A policy may gate an action three ways: an exact `requiredActions` entry, a
 * broad `requiredActionGroups` verb, or a legacy `requiredToolIds` tool, which
 * the runtime reads as every non-read action on that tool. `setManagerApproval`
 * deliberately retires the two broad forms on write, so the visible policy
 * becomes the effective one — but the read returned `requiredActions` alone,
 * and the two disagreed until somebody saved.
 *
 * Live consequence, not a hypothetical: Finance runs with
 * `requiredToolIds: ['zohoCrm','zohoBooks']` and an empty `requiredActions`, so
 * its manager saw "Nothing is gated" while Divo was in fact stopping to ask
 * about every write to both. Worse, the screen sends the complete next state,
 * so their first toggle — of anything at all — would have written those two
 * gates away without naming them.
 *
 * Expanding here rather than at the enforcement point on purpose: the gate in
 * approval-policy.ts still reads all three forms from the raw JSON, so nothing
 * about what Divo actually stops for changes. This only makes the screen honest,
 * and turns the next save into a faithful migration of what was already true.
 */
type RequiredActionEntry = ManagerApprovalConfig['requiredActions'][number];

function expandLegacySelectors(
  config: Pick<ManagerApprovalConfig, 'requiredActions' | 'requiredActionGroups' | 'requiredToolIds'>,
): RequiredActionEntry[] {
  const byTool = new Map<string, Set<string>>();
  const add = (toolId: string, action: string) => {
    const actions = byTool.get(toolId) ?? new Set<string>();
    actions.add(action);
    byTool.set(toolId, actions);
  };

  for (const entry of config.requiredActions) for (const action of entry.actions) add(entry.toolId, action);

  // A legacy tool id gates every non-read action on that tool, which is exactly
  // how approval-policy.ts reads it.
  for (const toolId of config.requiredToolIds) {
    const supported = TOOL_SUPPORTED_ACTIONS[toolId as CanonicalToolId];
    if (!supported) continue;
    for (const action of supported) if (action !== 'read') add(toolId, action);
  }

  // A broad action group gates that verb on every tool that supports it.
  for (const action of config.requiredActionGroups) {
    if (action === 'read') continue;
    for (const [toolId, supported] of Object.entries(TOOL_SUPPORTED_ACTIONS)) {
      if (supported.includes(action)) add(toolId, action);
    }
  }

  return [...byTool].map(([toolId, actions]) => ({ toolId, actions: [...actions] }));
}


type DepartmentManagerServiceDeps = {
  prisma: PrismaClient;
  departmentAdminService: DepartmentAdminService;
  permissions: PermissionService;
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

  async managerApprovalPolicy(actor: DesktopDepartmentActor, departmentId: string): Promise<DepartmentManagerApprovalPolicy> {
    await this.requireManager(actor, departmentId);
    const config = await this.deps.prisma.departmentAgentConfig.findFirst({
      where: { departmentId, department: { companyId: actor.companyId, status: 'active' } },
      select: { managerApprovalJson: true },
    });
    if (!config) throw new DesktopDepartmentManagementError('not_found', 'Department approval configuration is not available');
    const parsed = ManagerApprovalConfigSchema.safeParse(config.managerApprovalJson ?? {});
    if (!parsed.success) throw new DesktopDepartmentManagementError('invalid', 'Department approval configuration is invalid');
    return {
      enabled: parsed.data.enabled,
      requiredActions: expandLegacySelectors(parsed.data),
    };
  }

  async setManagerApprovalPolicy(
    actor: DesktopDepartmentActor,
    departmentId: string,
    input: DepartmentManagerApprovalPolicy,
  ): Promise<DepartmentManagerApprovalPolicy> {
    await this.requireManager(actor, departmentId);
    const normalized = this.normalizeManagerApprovalPolicy(input);
    await this.revalidateManager(actor, departmentId);

    const config = await this.deps.prisma.departmentAgentConfig.findFirst({
      where: { departmentId, department: { companyId: actor.companyId, status: 'active' } },
      select: { id: true, managerApprovalJson: true },
    });
    if (!config) throw new DesktopDepartmentManagementError('not_found', 'Department approval configuration is not available');
    const current = ManagerApprovalConfigSchema.safeParse(config.managerApprovalJson ?? {});
    if (!current.success) throw new DesktopDepartmentManagementError('invalid', 'Department approval configuration is invalid');

    await this.deps.prisma.departmentAgentConfig.update({
      where: { id: config.id },
      data: {
        managerApprovalJson: {
          ...current.data,
          enabled: normalized.enabled,
          requiredActions: normalized.requiredActions,
          // The desktop manages exact tool/action gates. Retire broad legacy
          // selectors here so the visible policy is the effective policy.
          requiredActionGroups: [],
          requiredToolIds: [],
        },
        updatedBy: actor.userId,
      },
    });
    await this.deps.permissions.invalidateDept(actor.companyId, departmentId);
    this.audit(actor, departmentId, 'department_manager.approval_policy.updated', { requiredActionCount: normalized.requiredActions.reduce((count, entry) => count + entry.actions.length, 0) });
    return normalized;
  }

  async setZohoPersonalizedScope(
    actor: DesktopDepartmentActor,
    departmentId: string,
    roleId: string,
    personalized: boolean,
  ): Promise<{ roleId: string; zohoReadScope: 'personalized' | 'show_all' }> {
    await this.requireManager(actor, departmentId);
    const role = await this.deps.prisma.departmentRole.findFirst({
      where: { id: roleId, departmentId, department: { companyId: actor.companyId, status: 'active' } },
      select: { id: true },
    });
    if (!role) throw new DesktopDepartmentManagementError('not_found', 'Department role not found');
    await this.revalidateManager(actor, departmentId);
    const zohoReadScope = personalized ? 'personalized' as const : 'show_all' as const;
    await this.deps.prisma.departmentRole.update({ where: { id: role.id }, data: { zohoReadScope } });
    await this.deps.permissions.invalidateDept(actor.companyId, departmentId);
    this.audit(actor, departmentId, 'department_manager.zoho_scope.updated', { roleId, zohoReadScope });
    return { roleId, zohoReadScope };
  }

  private normalizeManagerApprovalPolicy(input: DepartmentManagerApprovalPolicy): DepartmentManagerApprovalPolicy {
    const byTool = new Map<string, Set<string>>();
    for (const entry of input.requiredActions) {
      const policy = getDesktopToolPolicy(entry.toolId);
      if (policy?.kind !== 'configurable') throw new DesktopDepartmentManagementError('invalid', `Unsupported approval tool: ${entry.toolId}`);
      for (const action of entry.actions) {
        if (action === 'read' || !policy.supportedActions.includes(action)) {
          throw new DesktopDepartmentManagementError('invalid', `Unsupported approval action: ${entry.toolId}.${action}`);
        }
        const actions = byTool.get(entry.toolId) ?? new Set<string>();
        actions.add(action);
        byTool.set(entry.toolId, actions);
      }
    }
    const requiredActions = [...byTool.entries()].map(([toolId, actions]) => ({ toolId, actions: [...actions].sort() }));
    return { enabled: input.enabled && requiredActions.length > 0, requiredActions };
  }
}
