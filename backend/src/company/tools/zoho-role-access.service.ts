import { aiRoleService, type AiRoleDTO } from './ai-role.service';
import { zohoUserAccessExceptionService } from './zoho-user-access-exception.service';

export type ZohoScopeMode = 'email_scoped' | 'company_scoped';

export type ZohoRoleAccessMatrixRow = AiRoleDTO & {
  companyScopedRead: boolean;
};

export class ZohoRoleAccessService {
  async getMatrix(companyId: string): Promise<ZohoRoleAccessMatrixRow[]> {
    const roles = await aiRoleService.listRoles(companyId);
    return roles.map((role) => ({
      ...role,
      companyScopedRead: false,
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
    return {
      companyId,
      role: normalizedRole,
      companyScopedRead,
      updatedBy: actorId ?? 'system',
    };
  }

  async resolveScopeMode(companyId: string, requesterUserId?: string): Promise<ZohoScopeMode> {
    if (!requesterUserId) {
      return 'email_scoped';
    }
    const activeException = await zohoUserAccessExceptionService.resolveActiveException(companyId, requesterUserId);
    return activeException?.bypassRelationScope ? 'company_scoped' : 'email_scoped';
  }
}

export const zohoRoleAccessService = new ZohoRoleAccessService();
