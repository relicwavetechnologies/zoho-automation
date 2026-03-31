import { TOOL_REGISTRY, TOOL_REGISTRY_MAP } from './tool-registry';
import { ToolPermissionRepository, toolPermissionRepository } from './tool-permission.repository';
import {
  ToolActionPermissionRepository,
  toolActionPermissionRepository,
} from './tool-action-permission.repository';
import { aiRoleService, type AiRoleDTO } from './ai-role.service';
import { toolAccessCache } from './tool-access.cache';
import {
  getSupportedToolActionGroups,
  type ToolActionGroup,
} from './tool-action-groups';

export interface ToolPermissionRow {
  toolId: string;
  name: string;
  description: string;
  category: string;
  engines: ('legacy' | 'vercel')[];
  /** Dynamic map: role slug → allowed boolean */
  permissions: Record<string, boolean>;
}

export interface ToolPermissionMatrix {
  roles: AiRoleDTO[];
  tools: ToolPermissionRow[];
}

export interface ToolActionPermissionRow {
  toolId: string;
  name: string;
  actionGroups: Record<string, Record<ToolActionGroup, boolean>>;
}

export interface ToolActionPermissionMatrix {
  roles: AiRoleDTO[];
  tools: ToolActionPermissionRow[];
}

/** Default MEMBER permission for a tool, used as fallback for custom roles. */
const memberDefault = (toolId: string): boolean =>
  TOOL_REGISTRY_MAP.get(toolId)?.defaultPermissions['MEMBER'] ?? false;

export class ToolPermissionService {
  constructor(
    private readonly repo: ToolPermissionRepository = toolPermissionRepository,
    private readonly actionRepo: ToolActionPermissionRepository = toolActionPermissionRepository,
  ) {}

  /**
   * Returns the full permission matrix for a company.
   * Columns = all roles (built-in + custom). Rows = all tools.
   * Custom roles fall back to MEMBER default when no explicit DB entry exists.
   */
  async getMatrix(companyId: string): Promise<ToolPermissionMatrix> {
    const [roles, stored] = await Promise.all([
      aiRoleService.listRoles(companyId),
      this.repo.getForCompany(companyId),
    ]);

    const overrideMap = new Map(stored.map((r) => [`${r.toolId}:${r.role}`, r.enabled]));

    const tools: ToolPermissionRow[] = TOOL_REGISTRY.map((tool) => {
      const permissions: Record<string, boolean> = {};
      for (const role of roles) {
        const key = `${tool.id}:${role.slug}`;
        if (overrideMap.has(key)) {
          permissions[role.slug] = overrideMap.get(key) as boolean;
        } else if (role.isBuiltIn) {
          permissions[role.slug] = tool.defaultPermissions[role.slug as keyof typeof tool.defaultPermissions] ?? false;
        } else {
          // Custom role: inherit MEMBER default
          permissions[role.slug] = memberDefault(tool.id);
        }
      }
      return {
        toolId: tool.id,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        engines: tool.engines,
        permissions,
      };
    });

    return { roles, tools };
  }

  /** Updates a single tool × role permission. */
  async updatePermission(
    companyId: string,
    toolId: string,
    role: string,
    enabled: boolean,
    actorId: string,
  ) {
    if (!TOOL_REGISTRY_MAP.has(toolId)) {
      throw new Error(`Unknown toolId: ${toolId}`);
    }
    const result = await this.repo.upsert(companyId, toolId, role, enabled, actorId);
    await toolAccessCache.invalidateCompany(companyId);
    return result;
  }

  async getAllowedActionsByTool(
    companyId: string,
    role: string,
    allowedToolIds: string[],
  ): Promise<Record<string, ToolActionGroup[]>> {
    const normalizedRole = role.trim().toUpperCase();
    const cached = await toolAccessCache.getAllowedActions(companyId, normalizedRole);
    if (cached) {
      return Object.fromEntries(
        Object.entries(cached)
          .filter(([toolId]) => allowedToolIds.includes(toolId))
          .map(([toolId, actionGroups]) => [toolId, actionGroups as ToolActionGroup[]]),
      );
    }

    const [stored, validRoleSlugs] = await Promise.all([
      this.actionRepo.getForCompany(companyId),
      aiRoleService.getRoleSlugs(companyId),
    ]);
    if (!validRoleSlugs.includes(normalizedRole)) {
      return {};
    }

    const overrideMap = new Map(
      stored
        .filter((row) => row.role === normalizedRole)
        .map((row) => [`${row.toolId}:${row.actionGroup}`, row.enabled] as const),
    );

    const allAllowedActions = Object.fromEntries(
      allowedToolIds.map((toolId) => {
        const supported = getSupportedToolActionGroups(toolId);
        const allowed = supported.filter((actionGroup) => {
          const key = `${toolId}:${actionGroup}`;
          if (overrideMap.has(key)) {
            return overrideMap.get(key) as boolean;
          }
          return true;
        });
        return [toolId, allowed];
      }),
    ) as Record<string, ToolActionGroup[]>;

    await toolAccessCache.setAllowedActions(companyId, normalizedRole, allAllowedActions);
    return allAllowedActions;
  }

  async getActionMatrix(companyId: string): Promise<ToolActionPermissionMatrix> {
    const [roles, rows] = await Promise.all([
      aiRoleService.listRoles(companyId),
      this.actionRepo.getForCompany(companyId),
    ]);
    const overrideMap = new Map(
      rows.map((row) => [`${row.toolId}:${row.role}:${row.actionGroup}`, row.enabled] as const),
    );

    const tools: ToolActionPermissionRow[] = TOOL_REGISTRY.map((tool) => {
      const supported = getSupportedToolActionGroups(tool.id);
      const actionGroups = Object.fromEntries(
        roles.map((role) => {
          const enabledByAction = Object.fromEntries(
            supported.map((actionGroup) => {
              const key = `${tool.id}:${role.slug}:${actionGroup}`;
              return [
                actionGroup,
                overrideMap.has(key) ? (overrideMap.get(key) as boolean) : true,
              ];
            }),
          ) as Record<ToolActionGroup, boolean>;
          return [role.slug, enabledByAction];
        }),
      );
      return {
        toolId: tool.id,
        name: tool.name,
        actionGroups,
      };
    });

    return { roles, tools };
  }

  async updateActionPermission(
    companyId: string,
    toolId: string,
    role: string,
    actionGroup: ToolActionGroup,
    enabled: boolean,
    actorId?: string,
  ) {
    if (!TOOL_REGISTRY_MAP.has(toolId)) {
      throw new Error(`Unknown toolId: ${toolId}`);
    }
    if (!getSupportedToolActionGroups(toolId).includes(actionGroup)) {
      throw new Error(`Unsupported actionGroup "${actionGroup}" for tool ${toolId}`);
    }
    const result = await this.actionRepo.upsert(
      companyId,
      toolId,
      role.trim().toUpperCase(),
      actionGroup,
      enabled,
      actorId,
    );
    await toolAccessCache.invalidateCompany(companyId);
    return result;
  }

  /** Returns the set of toolIds allowed for the given role slug in this company. */
  async getAllowedTools(companyId: string, role: string): Promise<string[]> {
    const normalizedRole = role.trim().toUpperCase();
    const cached = await toolAccessCache.getAllowedTools(companyId, normalizedRole);
    if (cached) {
      return cached;
    }
    const [stored, validRoleSlugs] = await Promise.all([
      this.repo.getForCompany(companyId),
      aiRoleService.getRoleSlugs(companyId),
    ]);
    if (!validRoleSlugs.includes(normalizedRole)) {
      return [];
    }
    const overrideMap = new Map(stored.map((r) => [`${r.toolId}:${r.role}`, r.enabled]));

    const allowedToolIds = TOOL_REGISTRY.filter((tool) => {
      const key = `${tool.id}:${normalizedRole}`;
      if (overrideMap.has(key)) {
        return overrideMap.get(key) as boolean;
      }
      // Built-in roles use their defined default; custom roles inherit MEMBER
      if (['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'].includes(normalizedRole)) {
        return tool.defaultPermissions[normalizedRole as keyof typeof tool.defaultPermissions] ?? false;
      }
      return memberDefault(tool.id);
    }).map((t) => t.id);

    await toolAccessCache.set(companyId, normalizedRole, allowedToolIds);
    return allowedToolIds;
  }

  /** Quick single-tool permission check. */
  async isAllowed(companyId: string, toolId: string, role: string): Promise<boolean> {
    const tool = TOOL_REGISTRY_MAP.get(toolId);
    if (!tool) return false;
    const normalizedRole = role.trim().toUpperCase();
    const validRoleSlugs = await aiRoleService.getRoleSlugs(companyId);
    if (!validRoleSlugs.includes(normalizedRole)) {
      return false;
    }

    const stored = await this.repo.getForCompany(companyId);
    const row = stored.find((r) => r.toolId === toolId && r.role === normalizedRole);
    if (row !== undefined) return row.enabled;

    if (['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'].includes(normalizedRole)) {
      return tool.defaultPermissions[normalizedRole as keyof typeof tool.defaultPermissions] ?? false;
    }
    // Custom role: inherit MEMBER default
    return memberDefault(toolId);
  }
}

export const toolPermissionService = new ToolPermissionService();
