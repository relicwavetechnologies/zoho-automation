import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { PermissionError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import type { ToolId } from '../../shared/ids';
import { asToolId } from '../../shared/ids';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import { isBuiltIn } from '../../domain/permissions/company-role';
import type { CompanyRoleSlug } from '../../domain/permissions/company-role';
import { asDepartmentRoleSlug } from '../../domain/permissions/department-role';
import {
  CANONICAL_TOOL_IDS,
  TOOL_DEFAULT_PERMISSIONS,
  TOOL_SUPPORTED_ACTIONS,
  type CanonicalToolId,
} from '../../domain/tools/tool-id';
import type { PermissionDecision, PermissionSource } from '../../domain/permissions/permission-decision';
import type { PermissionQuery, PermissionResult, DepartmentMeta } from './permission.types';
import {
  PermissionCache,
  serializePermissionResult,
  deserializePermissionResult,
  type CachedMembershipRow,
} from './permission.cache';
import type { CompanyRoleRepoPort } from '../../infrastructure/persistence/company-role.repository';
import type { ToolPermissionRepoPort } from '../../infrastructure/persistence/tool-permission.repository';
import type { ToolActionPermissionRepoPort } from '../../infrastructure/persistence/tool-action-permission.repository';
import type { DepartmentRepoPort } from '../../infrastructure/persistence/department.repository';
import type { DeptToolPermissionRepoPort } from '../../infrastructure/persistence/department-tool-permission.repository';
import type { DeptUserOverrideRepoPort } from '../../infrastructure/persistence/department-user-override.repository';
import type { CachePort } from '../../shared/cache';
import type { DepartmentId } from '../../shared/ids';
import { asDepartmentId } from '../../shared/ids';

// ─── Deps ─────────────────────────────────────────────────────────────────

export interface PermissionServiceDeps {
  companyRoleRepo: CompanyRoleRepoPort;
  toolPermRepo: ToolPermissionRepoPort;
  toolActionRepo: ToolActionPermissionRepoPort;
  deptRepo: DepartmentRepoPort;
  deptToolPermRepo: DeptToolPermissionRepoPort;
  deptUserOverrideRepo: DeptUserOverrideRepoPort;
  cache: CachePort;
  logger: Logger;
}

// ─── Service interface ─────────────────────────────────────────────────────

export interface PermissionService {
  resolve(query: PermissionQuery): Promise<Result<PermissionResult, PermissionError>>;
  canInvoke(
    query: PermissionQuery,
    call: { toolId: ToolId; action: ToolActionGroup },
  ): Promise<Result<true, PermissionError>>;
  /** Admin: invalidate all caches for a company. */
  invalidateCompany(companyId: string): Promise<void>;
  /** Admin: invalidate dept caches when dept permissions change. */
  invalidateDept(companyId: string, deptId: string): Promise<void>;
}

// ─── Implementation ────────────────────────────────────────────────────────

export class PermissionServiceImpl implements PermissionService {
  private readonly permCache: PermissionCache;

  constructor(private readonly deps: PermissionServiceDeps) {
    this.permCache = new PermissionCache(deps.cache);
  }

  // ── Public: resolve ──────────────────────────────────────────────────

  async resolve(query: PermissionQuery): Promise<Result<PermissionResult, PermissionError>> {
    const { companyId, userId, companyRole, departmentId } = query;

    // ── No department: pure company-axis ──────────────────────────────
    if (!departmentId) {
      return this.applyCompanyAdminFixedAccess(companyRole, await this.resolveCompanyOnly(companyId, companyRole));
    }

    // ── With department: check dept cache first ────────────────────────
    const cached = await this.permCache.getDept(companyId, departmentId, userId, companyRole);
    if (cached.ok && cached.value !== null) {
      this.deps.logger.debug('perm.cache.hit.dept', { companyId, departmentId, userId });
      return this.applyCompanyAdminFixedAccess(companyRole, ok(deserializePermissionResult(cached.value)));
    }

    // ── Company axis (the ceiling) ─────────────────────────────────────
    const companyResult = await this.resolveCompanyOnly(companyId, companyRole);
    if (!companyResult.ok) return companyResult;
    const companyCeiling = companyResult.value;

    // ── Department membership (cached) ────────────────────────────────────
    let membership: CachedMembershipRow | null = null;
    const cachedMembership = await this.permCache.getMembership(companyId, departmentId, userId);
    if (cachedMembership.ok && cachedMembership.value !== null) {
      this.deps.logger.debug('perm.cache.hit.membership', { companyId, departmentId, userId });
      membership = cachedMembership.value;
    } else {
      const membershipResult = await this.deps.deptRepo.getMembership(userId, companyId, departmentId);
      if (!membershipResult.ok) {
        return err(new PermissionError({
          reason: 'department_access_denied',
          message: `Failed to read department membership: ${membershipResult.error.message}`,
        }));
      }
      membership = membershipResult.value as CachedMembershipRow | null;
      if (membership) {
        void this.permCache.setMembership(companyId, departmentId, userId, membership);
      }
    }
    if (!membership) {
      return err(new PermissionError({
        reason: 'department_access_denied',
        message: `User ${userId} is not an active member of department ${departmentId}`,
      }));
    }

    // ── Dept-role permissions + user overrides ─────────────────────────
    const [deptRolePermsResult, userOverridesResult] = await Promise.all([
      this.deps.deptToolPermRepo.getForDeptRole(departmentId, membership.roleId),
      this.deps.deptUserOverrideRepo.getForUser(departmentId, userId),
    ]);

    if (!deptRolePermsResult.ok || !userOverridesResult.ok) {
      return err(new PermissionError({
        reason: 'department_access_denied',
        message: 'Failed to load department permission rules',
      }));
    }
    const deptRolePerms = deptRolePermsResult.value;
    const userOverrides = userOverridesResult.value;

    // Build fast lookup maps
    const deptRoleMap = new Map<string, boolean>();
    for (const p of deptRolePerms) {
      deptRoleMap.set(`${p.toolId}:${p.actionGroup}`, p.allowed);
    }
    const overrideMap = new Map<string, boolean>();
    for (const o of userOverrides) {
      overrideMap.set(`${o.toolId}:${o.actionGroup}`, o.allowed);
    }

    // ── Compose: user-override → dept-role grant → default deny ───────
    // Company ceiling still clamps any allow; it is not an inherit source.
    const decisions: PermissionDecision[] = [];
    const allowedActionsByTool = new Map<ToolId, Set<ToolActionGroup>>();

    for (const toolIdStr of CANONICAL_TOOL_IDS) {
      const toolId = asToolId(toolIdStr);
      const supported = (TOOL_SUPPORTED_ACTIONS[toolIdStr] ?? []) as ToolActionGroup[];
      const toolActions = new Set<ToolActionGroup>();

      for (const action of supported) {
        const key = `${toolIdStr}:${action}`;
        let allowed: boolean;
        let source: PermissionSource;

        if (overrideMap.has(key)) {
          // LAYER 1: per-user override (highest priority)
          allowed = overrideMap.get(key)!;
          source = 'department_user_override';
        } else if (deptRoleMap.has(key)) {
          // LAYER 2: dept-role explicit permission
          allowed = deptRoleMap.get(key)!;
          source = 'department_role';
        } else {
          // LAYER 3: default deny — no explicit dept-role grant means not allowed.
          // Company ceiling is a clamp on allows, not an inherit source for missing rows.
          allowed = false;
          source = 'department_role';
        }

        // Department CANNOT exceed company ceiling
        if (allowed) {
          const ceilingActions = companyCeiling.allowedActionsByTool.get(toolId);
          if (!ceilingActions?.has(action)) {
            allowed = false; // ceiling blocks it
            this.deps.logger.warn('perm.dept.ceiling.blocked', {
              userId, toolId: toolIdStr, action, source,
            });
          }
        }

        if (allowed) {
          toolActions.add(action);
          decisions.push({ toolId, actionGroup: action, allowed: true, source });
        }
      }

      if (toolActions.size > 0) {
        allowedActionsByTool.set(toolId, toolActions);
      }
    }

    const allowedToolIds = new Set(allowedActionsByTool.keys());

    const deptMeta: DepartmentMeta = {
      id: asDepartmentId(membership.departmentId) as DepartmentId,
      name: membership.departmentName,
      roleSlug: asDepartmentRoleSlug(membership.roleSlug),
      zohoReadScope: membership.zohoReadScope === 'show_all' ? 'show_all' : 'personalized',
      ...(membership.systemPrompt ? { systemPrompt: membership.systemPrompt } : {}),
      ...(membership.managerApprovalJson !== null ? { managerApprovalJson: membership.managerApprovalJson } : {}),
    };

    const result: PermissionResult = {
      allowedToolIds,
      allowedActionsByTool,
      decisions,
      department: deptMeta,
    };

    this.deps.logger.info('perm.resolved.dept', {
      userId,
      companyId,
      departmentId,
      companyRole,
      deptRoleSlug: membership.roleSlug,
      allowedToolCount: allowedToolIds.size,
      allowedTools: [...allowedToolIds],
    });

    // Cache the result
    await this.permCache.setDept(companyId, departmentId, userId, companyRole, serializePermissionResult(result));

    return this.applyCompanyAdminFixedAccess(companyRole, ok(result));
  }

  // ── Public: canInvoke ────────────────────────────────────────────────

  async canInvoke(
    query: PermissionQuery,
    call: { toolId: ToolId; action: ToolActionGroup },
  ): Promise<Result<true, PermissionError>> {
    const resolved = await this.resolve(query);
    if (!resolved.ok) return resolved;

    const actions = resolved.value.allowedActionsByTool.get(call.toolId);
    if (!actions?.has(call.action)) {
      return err(new PermissionError({
        toolId: call.toolId,
        action: call.action,
        reason: 'not_allowed',
        message: `Tool ${call.toolId}:${call.action} not permitted for this context`,
      }));
    }
    return ok(true);
  }

  // ── Public: cache invalidation ────────────────────────────────────────

  async invalidateCompany(companyId: string): Promise<void> {
    await Promise.all([
      this.permCache.invalidateCompany(companyId),
      this.permCache.invalidateDeptByCompany(companyId),
      this.permCache.invalidateMembershipByCompany(companyId),
    ]);
  }

  async invalidateDept(companyId: string, deptId: string): Promise<void> {
    await Promise.all([
      this.permCache.invalidateDept(companyId, deptId),
      this.permCache.invalidateMembershipByDept(companyId, deptId),
    ]);
  }

  // ── Private: company-only resolution ─────────────────────────────────

  private async resolveCompanyOnly(
    companyId: string,
    companyRole: CompanyRoleSlug,
  ): Promise<Result<PermissionResult, PermissionError>> {
    // Check cache first
    const cached = await this.permCache.getCompany(companyId, companyRole);
    if (cached.ok && cached.value !== null) {
      this.deps.logger.debug('perm.cache.hit.company', { companyId, companyRole });
      return ok(deserializePermissionResult(cached.value));
    }

    // Validate that this role exists in the company
    const slugsResult = await this.deps.companyRoleRepo.getValidSlugs(companyId);
    if (!slugsResult.ok) {
      return err(new PermissionError({
        reason: 'unknown_role',
        message: `Failed to load valid roles: ${slugsResult.error.message}`,
      }));
    }
    const validSlugs = slugsResult.value;

    // Built-in roles are always valid; custom roles must exist in AiRoleDefinition
    if (!isBuiltIn(companyRole) && !validSlugs.includes(companyRole)) {
      return err(new PermissionError({
        reason: 'unknown_role',
        message: `Role '${companyRole}' is not registered for company ${companyId}`,
      }));
    }

    // Load company-level overrides
    const [toolPermResult, actionPermResult] = await Promise.all([
      this.deps.toolPermRepo.getForCompany(companyId),
      this.deps.toolActionRepo.getForCompany(companyId),
    ]);

    if (!toolPermResult.ok || !actionPermResult.ok) {
      return err(new PermissionError({
        reason: 'not_allowed',
        message: 'Failed to load company permission rules',
      }));
    }

    // Build override maps (explicit admin toggles)
    const toolEnabledMap = new Map<string, boolean>();
    for (const row of toolPermResult.value) {
      if (row.role === companyRole) {
        toolEnabledMap.set(row.toolId, row.enabled);
      }
    }

    const actionEnabledMap = new Map<string, boolean>();
    for (const row of actionPermResult.value) {
      if (row.role === companyRole) {
        actionEnabledMap.set(`${row.toolId}:${row.actionGroup}`, row.enabled);
      }
    }

    // Resolve allowed tools and actions
    const decisions: PermissionDecision[] = [];
    const allowedActionsByTool = new Map<ToolId, Set<ToolActionGroup>>();

    for (const toolIdStr of CANONICAL_TOOL_IDS) {
      const toolId = asToolId(toolIdStr);

      // Determine if tool itself is enabled for this role
      let toolEnabled: boolean;
      if (toolEnabledMap.has(toolIdStr)) {
        toolEnabled = toolEnabledMap.get(toolIdStr)!;
      } else {
        // Use registry default
        const def = TOOL_DEFAULT_PERMISSIONS[toolIdStr];
        if (isBuiltIn(companyRole)) {
          toolEnabled = def[companyRole as keyof typeof def] ?? false;
        } else {
          // Custom roles inherit MEMBER defaults
          toolEnabled = def['MEMBER'];
        }
      }

      if (!toolEnabled) continue;

      const supported = (TOOL_SUPPORTED_ACTIONS[toolIdStr] ?? []) as ToolActionGroup[];
      const toolActions = new Set<ToolActionGroup>();

      for (const action of supported) {
        const key = `${toolIdStr}:${action}`;
        let allowed: boolean;
        let source: PermissionSource;

        if (actionEnabledMap.has(key)) {
          allowed = actionEnabledMap.get(key)!;
          source = 'company_override';
        } else {
          // Default: all actions allowed when tool is enabled
          allowed = true;
          source = 'company_default';
        }

        if (allowed) {
          toolActions.add(action);
          decisions.push({ toolId, actionGroup: action, allowed: true, source });
        }
      }

      if (toolActions.size > 0) {
        allowedActionsByTool.set(toolId, toolActions);
      }
    }

    const result: PermissionResult = {
      allowedToolIds: new Set(allowedActionsByTool.keys()),
      allowedActionsByTool,
      decisions,
    };

    const safeResult = stripCompanyAdminFixedAccess(result);

    // Cache before returning
    await this.permCache.setCompany(companyId, companyRole, serializePermissionResult(safeResult));

    return ok(safeResult);
  }

  /**
   * Tools fixed to live company administrators, whatever department is
   * selected and whatever the department overlay says. The overlay is
   * default-deny per department role, so a company-wide integration that is
   * still being piloted by its admin would otherwise be denied everywhere
   * until each role is granted one by one.
   */
  private applyCompanyAdminFixedAccess(
    companyRole: CompanyRoleSlug,
    result: Result<PermissionResult, PermissionError>,
  ): Result<PermissionResult, PermissionError> {
    if (!result.ok) return result;
    const base = stripCompanyAdminFixedAccess(result.value);
    if (!['COMPANY_ADMIN', 'SUPER_ADMIN'].includes(companyRole)) return ok(base);

    const allowedActionsByTool = new Map(base.allowedActionsByTool);
    const allowedToolIds = new Set(base.allowedToolIds);
    const decisions = [...base.decisions];
    for (const [toolId, actions] of COMPANY_ADMIN_FIXED_TOOLS) {
      // A floor, not a replacement: a department grant that already allows
      // more keeps it, so opening one of these to a role later still works.
      const granted = new Set<ToolActionGroup>(allowedActionsByTool.get(asToolId(toolId)) ?? []);
      for (const actionGroup of actions) {
        if (granted.has(actionGroup)) continue;
        granted.add(actionGroup);
        decisions.push({ toolId, actionGroup, allowed: true, source: 'company_default' });
      }
      allowedActionsByTool.set(asToolId(toolId), granted);
      allowedToolIds.add(asToolId(toolId));
    }
    return ok({ ...base, allowedToolIds, allowedActionsByTool, decisions });
  }
}

/**
 * Tool → actions a company administrator holds outright. Airtable is here for
 * the same reason OMS is: a company-wide connection its admin is piloting,
 * which the default-deny department overlay refuses until every role is
 * granted by hand.
 */
const COMPANY_ADMIN_FIXED_TOOLS: ReadonlyArray<readonly [CanonicalToolId, readonly ToolActionGroup[]]> = [
  ['omsSiteData', ['read']],
  ['airtableRecords', ['read', 'create', 'update']],
  ['airtableSchema', ['read', 'create', 'update']],
  ['airtableAutomation', ['read', 'create', 'update']],
];

/**
 * Tools whose access is the company-admin grant and nothing else, stripped
 * before the admin floor is applied so no department row can widen them.
 * Airtable is deliberately absent: its department grants are real, and the
 * team is meant to get it once the pilot ends.
 */
const COMPANY_ADMIN_EXCLUSIVE_TOOLS: readonly CanonicalToolId[] = ['omsSiteData'];

function stripCompanyAdminFixedAccess(result: PermissionResult): PermissionResult {
  if (!COMPANY_ADMIN_EXCLUSIVE_TOOLS.some(toolId => result.allowedToolIds.has(asToolId(toolId)))) return result;
  const allowedToolIds = new Set(result.allowedToolIds);
  const allowedActionsByTool = new Map(result.allowedActionsByTool);
  for (const toolId of COMPANY_ADMIN_EXCLUSIVE_TOOLS) {
    allowedToolIds.delete(asToolId(toolId));
    allowedActionsByTool.delete(asToolId(toolId));
  }
  return {
    ...result,
    allowedToolIds,
    allowedActionsByTool,
    decisions: result.decisions.filter(decision => !COMPANY_ADMIN_EXCLUSIVE_TOOLS.includes(decision.toolId as CanonicalToolId)),
  };
}
