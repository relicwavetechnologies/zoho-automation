import { aiRoleService, type AiRoleDTO } from './ai-role.service';
import { ZohoRoleAccessRepository, zohoRoleAccessRepository } from './zoho-role-access.repository';

export type ZohoScopeMode = 'email_scoped' | 'company_scoped';

export type ZohoRoleAccessMatrixRow = AiRoleDTO & {
  companyScopedRead: boolean;
};

export class ZohoRoleAccessService {
  constructor(private readonly repo: ZohoRoleAccessRepository = zohoRoleAccessRepository) {}

  async getMatrix(companyId: string): Promise<ZohoRoleAccessMatrixRow[]> {
    const [roles, stored] = await Promise.all([
      aiRoleService.listRoles(companyId),
      this.repo.getForCompany(companyId),
    ]);
    const storedMap = new Map(stored.map((row) => [row.role, row.companyScopedRead]));

    return roles.map((role) => ({
      ...role,
      companyScopedRead: storedMap.get(role.slug) ?? false,
    }));
  }

  async updateRoleAccess(
    companyId: string,
    role: string,
    companyScopedRead: boolean,
    actorId?: string,
  ) {
    const normalizedRole = role.trim().toUpperCase();
    const validRoleSlugs = await aiRoleService.getRoleSlugs(companyId);
    if (!validRoleSlugs.includes(normalizedRole)) {
      throw new Error(`Unknown AI role: ${normalizedRole}`);
    }

    return this.repo.upsert(companyId, normalizedRole, companyScopedRead, actorId);
  }

  async resolveScopeMode(companyId: string, requesterAiRole?: string): Promise<ZohoScopeMode> {
    const normalizedRole = requesterAiRole?.trim().toUpperCase();
    if (!normalizedRole) {
      return 'email_scoped';
    }

    const matrix = await this.getMatrix(companyId);
    const role = matrix.find((entry) => entry.slug === normalizedRole);
    return role?.companyScopedRead ? 'company_scoped' : 'email_scoped';
  }
}

export const zohoRoleAccessService = new ZohoRoleAccessService();
