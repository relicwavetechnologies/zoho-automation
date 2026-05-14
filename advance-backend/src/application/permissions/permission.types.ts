import type { CompanyId, DepartmentId, ToolId, UserId } from '../../shared/ids';
import type { CompanyRoleSlug } from '../../domain/permissions/company-role';
import type { DepartmentRoleSlug } from '../../domain/permissions/department-role';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { PermissionDecision, PermissionSource } from '../../domain/permissions/permission-decision';
import type { ChannelKey } from '../../domain/channel/incoming-message';

export interface PermissionQuery {
  readonly companyId: CompanyId;
  readonly userId: UserId;
  /** Company-level AI role from ChannelIdentity.aiRole — the CEILING. */
  readonly companyRole: CompanyRoleSlug;
  /** Optional dept scope. If absent, only the company axis applies. */
  readonly departmentId?: DepartmentId;
  readonly channel: ChannelKey;
}

export interface ToolPermissionEntry {
  readonly toolId: ToolId;
  readonly allowedActions: ReadonlySet<ToolActionGroup>;
}

export interface DepartmentMeta {
  readonly id: DepartmentId;
  readonly name: string;
  readonly roleSlug: DepartmentRoleSlug;
  readonly systemPrompt?: string;
  readonly skillsMarkdown?: string;
  readonly managerApprovalJson?: unknown;
  readonly zohoRateLimitJson?: unknown;
}

export interface PermissionResult {
  /** Flat set of toolIds this user may invoke (all non-empty action sets). */
  readonly allowedToolIds: ReadonlySet<ToolId>;
  /** Per-tool allowed action groups. Only contains tools with ≥1 allowed action. */
  readonly allowedActionsByTool: ReadonlyMap<ToolId, ReadonlySet<ToolActionGroup>>;
  /** Audit trail: one entry per (toolId × actionGroup) that was positively allowed. */
  readonly decisions: readonly PermissionDecision[];
  readonly department?: DepartmentMeta;
}

/** Compact serializable form used for caching. */
export interface CachedPermissionResult {
  allowedToolIds: string[];
  allowedActionsByTool: Record<string, string[]>;
  decisions: Array<{ toolId: string; actionGroup: string; allowed: boolean; source: PermissionSource }>;
  department?: {
    id: string;
    name: string;
    roleSlug: string;
    systemPrompt?: string;
    skillsMarkdown?: string;
    managerApprovalJson?: unknown;
    zohoRateLimitJson?: unknown;
  };
}
