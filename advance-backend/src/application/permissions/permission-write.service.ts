import type { PermissionService } from './permission.service';
import type { ToolActionPermissionRepoPort } from '../../infrastructure/persistence/tool-action-permission.repository';
import type { DeptToolPermissionRepoPort } from '../../infrastructure/persistence/department-tool-permission.repository';
import type { DeptUserOverrideRepoPort } from '../../infrastructure/persistence/department-user-override.repository';
import type { AuditService } from '../observability/audit.service';
import { CANONICAL_TOOL_IDS, TOOL_SUPPORTED_ACTIONS, type CanonicalToolId } from '../../domain/tools/tool-id';
import type { ToolRegistry } from '../tools/tool-registry';
import { isFixedToolPolicy } from '../../domain/tools/tool-policy';

export type PermissionWriteResult = { ok: true } | { ok: false; reason: 'invalid' | 'failed' };
type BeforePersist = () => Promise<boolean>;

/** Shared persistence, cache invalidation, and audit path for action-level RBAC writes. */
export class PermissionWriteService {
  constructor(private readonly deps: {
    toolActionRepo: ToolActionPermissionRepoPort;
    deptToolPermRepo: DeptToolPermissionRepoPort;
    deptUserOverrideRepo: DeptUserOverrideRepoPort;
    permissions: PermissionService;
    auditService: AuditService;
    toolRegistry: ToolRegistry;
  }) {}

  private valid(toolId: string, actionGroup: string): boolean {
    if (!CANONICAL_TOOL_IDS.includes(toolId as CanonicalToolId)) return false;
    return !isFixedToolPolicy(toolId)
      && TOOL_SUPPORTED_ACTIONS[toolId as CanonicalToolId].includes(actionGroup)
      && Boolean(this.deps.toolRegistry.byId(toolId as any));
  }

  private async canPersist(revalidate?: BeforePersist): Promise<boolean> {
    return !revalidate || await revalidate();
  }

  async setCompanyAction(input: {
    companyId: string; actorId: string; updatedBy?: string; toolId: string; role: string; actionGroup: string; enabled: boolean; revalidate?: BeforePersist;
  }): Promise<PermissionWriteResult> {
    if (!this.valid(input.toolId, input.actionGroup)) return { ok: false, reason: 'invalid' };
    if (!await this.canPersist(input.revalidate)) return { ok: false, reason: 'invalid' };
    const result = await this.deps.toolActionRepo.upsert(
      input.companyId, input.toolId, input.role, input.actionGroup, input.enabled, input.updatedBy ?? input.actorId,
    );
    if (!result.ok) return { ok: false, reason: 'failed' };
    await this.deps.permissions.invalidateCompany(input.companyId);
    this.deps.auditService.record({
      actorId: input.actorId, companyId: input.companyId, action: 'permission.set_company_action', outcome: 'success',
      metadata: { toolId: input.toolId, role: input.role, actionGroup: input.actionGroup, enabled: input.enabled },
    });
    return { ok: true };
  }

  async setDepartmentRoleAction(input: {
    companyId: string; departmentId: string; actorId: string; updatedBy?: string; toolId: string; roleId: string; actionGroup: string; allowed: boolean; revalidate?: BeforePersist;
  }): Promise<PermissionWriteResult> {
    if (!this.valid(input.toolId, input.actionGroup)) return { ok: false, reason: 'invalid' };
    if (!await this.canPersist(input.revalidate)) return { ok: false, reason: 'invalid' };
    const result = await this.deps.deptToolPermRepo.upsert(
      input.departmentId, input.roleId, input.toolId, input.actionGroup, input.allowed, input.updatedBy ?? input.actorId,
    );
    if (!result.ok) return { ok: false, reason: 'failed' };
    await this.deps.permissions.invalidateDept(input.companyId, input.departmentId);
    this.deps.auditService.record({
      actorId: input.actorId, companyId: input.companyId, action: 'permission.set_dept_action', outcome: 'success',
      metadata: { departmentId: input.departmentId, roleId: input.roleId, toolId: input.toolId, actionGroup: input.actionGroup, allowed: input.allowed },
    });
    return { ok: true };
  }

  async setDepartmentMemberAction(input: {
    companyId: string; departmentId: string; actorId: string; updatedBy?: string; userId: string; toolId: string; actionGroup: string; allowed: boolean; revalidate?: BeforePersist;
  }): Promise<PermissionWriteResult> {
    if (!this.valid(input.toolId, input.actionGroup)) return { ok: false, reason: 'invalid' };
    if (!await this.canPersist(input.revalidate)) return { ok: false, reason: 'invalid' };
    const result = await this.deps.deptUserOverrideRepo.upsert(
      input.departmentId, input.userId, input.toolId, input.actionGroup, input.allowed, input.updatedBy ?? input.actorId,
    );
    if (!result.ok) return { ok: false, reason: 'failed' };
    await this.deps.permissions.invalidateDept(input.companyId, input.departmentId);
    this.deps.auditService.record({
      actorId: input.actorId, companyId: input.companyId, action: 'permission.set_dept_member_action', outcome: 'success',
      metadata: { departmentId: input.departmentId, userId: input.userId, toolId: input.toolId, actionGroup: input.actionGroup, allowed: input.allowed },
    });
    return { ok: true };
  }
}
