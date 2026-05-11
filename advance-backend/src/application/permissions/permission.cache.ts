import type { CachePort } from '../../shared/cache';
import type { Result } from '../../shared/result';
import { ok } from '../../shared/result';
import { andThen } from '../../shared/result';
import type { InfraError } from '../../shared/errors';
import type { CachedPermissionResult } from './permission.types';
import type { ToolId, CompanyId, UserId, DepartmentId } from '../../shared/ids';
import { asToolId } from '../../shared/ids';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { PermissionResult, DepartmentMeta } from './permission.types';
import { asDepartmentId } from '../../shared/ids';
import { asDepartmentRoleSlug } from '../../domain/permissions/department-role';

const COMPANY_TTL    = 900;   // 15 min — admin routes invalidate proactively on changes
const DEPT_TTL       = 900;   // 15 min
const MEMBERSHIP_TTL = 900;   // 15 min

const companyKey = (companyId: string, roleSlug: string) =>
  `perm:co:${companyId}:role:${roleSlug}`;

const deptKey = (companyId: string, deptId: string, userId: string, companyRoleSlug: string) =>
  `perm:dep:${companyId}:${deptId}:${userId}:${companyRoleSlug}`;

const membershipKey = (companyId: string, deptId: string, userId: string) =>
  `dept:member:v1:${companyId}:${deptId}:${userId}`;

// Mirrors DepartmentMembershipRow fields that are JSON-serializable.
// Declared locally to avoid importing Prisma types into the cache layer.
export interface CachedMembershipRow {
  userId:               string;
  departmentId:         string;
  departmentName:       string;
  departmentCompanyId:  string;
  roleId:               string;
  roleSlug:             string;
  roleName:             string;
  systemPrompt?:        string | null;
  skillsMarkdown?:      string | null;
  managerApprovalJson?: unknown;
  zohoRateLimitJson?:   unknown;
}

export class PermissionCache {
  constructor(private readonly cache: CachePort) {}

  // ─── Company-level cache ──────────────────────────────────────────────

  async getCompany(
    companyId: string,
    roleSlug: string,
  ): Promise<Result<CachedPermissionResult | null, InfraError>> {
    return this.cache.get<CachedPermissionResult>(companyKey(companyId, roleSlug));
  }

  async setCompany(
    companyId: string,
    roleSlug: string,
    value: CachedPermissionResult,
  ): Promise<Result<void, InfraError>> {
    return this.cache.set(companyKey(companyId, roleSlug), value, COMPANY_TTL);
  }

  async invalidateCompany(companyId: string): Promise<Result<number, InfraError>> {
    return this.cache.scanDel(`perm:co:${companyId}:*`);
  }

  // ─── Department-level cache ───────────────────────────────────────────

  async getDept(
    companyId: string,
    deptId: string,
    userId: string,
    companyRoleSlug: string,
  ): Promise<Result<CachedPermissionResult | null, InfraError>> {
    return this.cache.get<CachedPermissionResult>(deptKey(companyId, deptId, userId, companyRoleSlug));
  }

  async setDept(
    companyId: string,
    deptId: string,
    userId: string,
    companyRoleSlug: string,
    value: CachedPermissionResult,
  ): Promise<Result<void, InfraError>> {
    return this.cache.set(deptKey(companyId, deptId, userId, companyRoleSlug), value, DEPT_TTL);
  }

  /** Invalidate all dept caches for a company (called on company-level perm change). */
  async invalidateDeptByCompany(companyId: string): Promise<Result<number, InfraError>> {
    return this.cache.scanDel(`perm:dep:${companyId}:*`);
  }

  /** Invalidate all caches for a specific department. */
  async invalidateDept(companyId: string, deptId: string): Promise<Result<number, InfraError>> {
    return this.cache.scanDel(`perm:dep:${companyId}:${deptId}:*`);
  }

  // ─── Dept membership cache ────────────────────────────────────────────

  async getMembership(
    companyId: string,
    deptId: string,
    userId: string,
  ): Promise<Result<CachedMembershipRow | null, InfraError>> {
    return this.cache.get<CachedMembershipRow>(membershipKey(companyId, deptId, userId));
  }

  async setMembership(
    companyId: string,
    deptId: string,
    userId: string,
    row: CachedMembershipRow,
  ): Promise<Result<void, InfraError>> {
    return this.cache.set(membershipKey(companyId, deptId, userId), row, MEMBERSHIP_TTL);
  }

  async invalidateMembership(
    companyId: string,
    deptId: string,
    userId: string,
  ): Promise<Result<void, InfraError>> {
    return this.cache.del(membershipKey(companyId, deptId, userId));
  }

  async invalidateMembershipByDept(
    companyId: string,
    deptId: string,
  ): Promise<Result<number, InfraError>> {
    return this.cache.scanDel(`dept:member:v1:${companyId}:${deptId}:*`);
  }

  async invalidateMembershipByCompany(companyId: string): Promise<Result<number, InfraError>> {
    return this.cache.scanDel(`dept:member:v1:${companyId}:*`);
  }
}

// ─── Serialization helpers ─────────────────────────────────────────────────

export const serializePermissionResult = (r: PermissionResult): CachedPermissionResult => ({
  allowedToolIds: [...r.allowedToolIds],
  allowedActionsByTool: Object.fromEntries(
    [...r.allowedActionsByTool.entries()].map(([k, v]) => [k, [...v]]),
  ),
  decisions: r.decisions.map(d => ({
    toolId: d.toolId,
    actionGroup: d.actionGroup,
    allowed: d.allowed,
    source: d.source,
  })),
  ...(r.department ? {
    department: {
      id: r.department.id,
      name: r.department.name,
      roleSlug: r.department.roleSlug,
      ...(r.department.systemPrompt !== undefined ? { systemPrompt: r.department.systemPrompt } : {}),
      ...(r.department.skillsMarkdown !== undefined ? { skillsMarkdown: r.department.skillsMarkdown } : {}),
    },
  } : {}),
});

export const deserializePermissionResult = (c: CachedPermissionResult): PermissionResult => {
  const allowedToolIds = new Set(c.allowedToolIds.map(id => asToolId(id)));
  const allowedActionsByTool = new Map(
    Object.entries(c.allowedActionsByTool).map(([toolId, actions]) => [
      asToolId(toolId),
      new Set(actions as ToolActionGroup[]),
    ]),
  );
  const department: DepartmentMeta | undefined = c.department
    ? {
        id: asDepartmentId(c.department.id) as DepartmentId,
        name: c.department.name,
        roleSlug: asDepartmentRoleSlug(c.department.roleSlug),
        ...(c.department.systemPrompt !== undefined ? { systemPrompt: c.department.systemPrompt } : {}),
        ...(c.department.skillsMarkdown !== undefined ? { skillsMarkdown: c.department.skillsMarkdown } : {}),
      }
    : undefined;
  return {
    allowedToolIds,
    allowedActionsByTool,
    decisions: c.decisions.map(d => ({
      toolId: asToolId(d.toolId),
      actionGroup: d.actionGroup as ToolActionGroup,
      allowed: d.allowed,
      source: d.source,
    })),
    ...(department !== undefined ? { department } : {}),
  };
};
