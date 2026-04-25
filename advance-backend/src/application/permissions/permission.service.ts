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
      return this.resolveCompanyOnly(companyId, companyRole);
    }

    // ── With department: check dept cache first ────────────────────────
    const cached = await this.permCache.getDept(companyId, departmentId, userId, companyRole);
    if (cached.ok && cached.value !== null) {
      this.deps.logger.debug('perm.cache.hit.dept', { companyId, departmentId, userId });
      return ok(deserializePermissionResult(cached.value));
    }

    // ── Company axis (the ceiling) ─────────────────────────────────────
    const companyResult = await this.resolveCompanyOnly(companyId, companyRole);
    if (!companyResult.ok) return companyResult;
    const companyCeiling = companyResult.value;

    // ── Department membership ──────────────────────────────────────────
    const membershipResult = await this.deps.deptRepo.getMembership(userId, companyId, departmentId);
    if (!membershipResult.ok) {
      return err(new PermissionError({
        reason: 'department_access_denied',
        message: `Failed to read department membership: ${membershipResult.error.message}`,
      }));
    }
    const membership = membershipResult.value;
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

    const deptRolePerms = deptRolePermsResult.ok ? deptRolePermsResult.value : [];
    const userOverrides = userOverridesResult.ok ? userOverridesResult.value : [];

    // Build fast lookup maps
    const deptRoleMap = new Map<string, boolean>();
    for (const p of deptRolePerms) {
      deptRoleMap.set(`${p.toolId}:${p.actionGroup}`, p.allowed);
    }
    const overrideMap = new Map<string, boolean>();
    for (const o of userOverrides) {
      overrideMap.set(`${o.toolId}:${o.actionGroup}`, o.allowed);
    }

    // ── Compose: user-override → dept-role → company ceiling ──────────
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
          // LAYER 3: fall through to company ceiling
          // CRITICAL FIX: use companyCeiling (resolved from companyRole) — not dept role slug
          const ceilingActions = companyCeiling.allowedActionsByTool.get(toolId);
          allowed = ceilingActions?.has(action) ?? false;
          source = allowed ? 'company_default' : 'company_default';
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
      ...(membership.systemPrompt ? { systemPrompt: membership.systemPrompt } : {}),
      ...(membership.skillsMarkdown ? { skillsMarkdown: membership.skillsMarkdown } : {}),
      ...(membership.managerApprovalJson !== null ? { managerApprovalJson: membership.managerApprovalJson } : {}),
      ...(membership.zohoRateLimitJson !== null ? { zohoRateLimitJson: membership.zohoRateLimitJson } : {}),
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

    return ok(result);
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
    ]);
  }

  async invalidateDept(companyId: string, deptId: string): Promise<void> {
    await this.permCache.invalidateDept(companyId, deptId);
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

    // Build override maps (explicit admin toggles)
    const toolEnabledMap = new Map<string, boolean>();
    if (toolPermResult.ok) {
      for (const row of toolPermResult.value) {
        if (row.role === companyRole) {
          toolEnabledMap.set(row.toolId, row.enabled);
        }
      }
    }

    const actionEnabledMap = new Map<string, boolean>();
    if (actionPermResult.ok) {
      for (const row of actionPermResult.value) {
        if (row.role === companyRole) {
          actionEnabledMap.set(`${row.toolId}:${row.actionGroup}`, row.enabled);
        }
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

    // Cache before returning
    await this.permCache.setCompany(companyId, companyRole, serializePermissionResult(result));

    return ok(result);
  }
}
