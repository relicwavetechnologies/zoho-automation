import { TOOL_REGISTRY, TOOL_REGISTRY_MAP } from './tool-registry';
import { ToolPermissionRepository, toolPermissionRepository } from './tool-permission.repository';
import { aiRoleService, type AiRoleDTO } from './ai-role.service';

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

/** Default MEMBER permission for a tool, used as fallback for custom roles. */
const memberDefault = (toolId: string): boolean =>
  TOOL_REGISTRY_MAP.get(toolId)?.defaultPermissions['MEMBER'] ?? false;

export class ToolPermissionService {
  constructor(private readonly repo: ToolPermissionRepository = toolPermissionRepository) {}

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
    return this.repo.upsert(companyId, toolId, role, enabled, actorId);
  }

  /** Returns the set of toolIds allowed for the given role slug in this company. */
  async getAllowedTools(companyId: string, role: string): Promise<string[]> {
    const normalizedRole = role.trim().toUpperCase();
    const [stored, validRoleSlugs] = await Promise.all([
      this.repo.getForCompany(companyId),
      aiRoleService.getRoleSlugs(companyId),
    ]);
    if (!validRoleSlugs.includes(normalizedRole)) {
      return [];
    }
    const overrideMap = new Map(stored.map((r) => [`${r.toolId}:${r.role}`, r.enabled]));

    return TOOL_REGISTRY.filter((tool) => {
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
