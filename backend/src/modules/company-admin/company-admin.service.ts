import { randomUUID } from 'crypto';

import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import config from '../../config';
import { channelIdentityRepository } from '../../company/channels/channel-identity.repository';
import { larkDirectorySyncService } from '../../company/channels/lark/lark-directory-sync.service';
import { larkTenantBindingRepository } from '../../company/channels/lark/lark-tenant-binding.repository';
import { larkWorkspaceConfigRepository } from '../../company/channels/lark/lark-workspace-config.repository';
import { auditService } from '../audit/audit.service';
import { companyOnboardingService } from '../company-onboarding/company-onboarding.service';
import { CompanyAdminRepository, companyAdminRepository } from './company-admin.repository';
import {
  ConnectOnboardingDto,
  DisconnectOnboardingDto,
  TriggerHistoricalSyncDto,
  UpsertLarkBindingDto,
  UpsertLarkWorkspaceConfigDto,
  UpsertZohoOAuthConfigDto,
} from './dto/connect-onboarding.dto';
import { zohoOAuthConfigRepository } from '../../company/integrations/zoho/zoho-oauth-config.repository';
import { CreateInviteDto } from './dto/create-invite.dto';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { aiRoleService } from '../../company/tools/ai-role.service';

export type SessionScope = {
  userId: string;
  role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
  companyId?: string;
};

const resolveCompanyScope = (session: SessionScope, requestedCompanyId?: string): string => {
  if (session.role === 'SUPER_ADMIN') {
    if (!requestedCompanyId) {
      throw new HttpException(400, 'companyId is required for super-admin company operations');
    }
    return requestedCompanyId;
  }

  if (!session.companyId) {
    throw new HttpException(403, 'Company-admin session missing company scope');
  }

  if (requestedCompanyId && requestedCompanyId !== session.companyId) {
    throw new HttpException(403, 'Company scope mismatch');
  }

  return session.companyId;
};

export class CompanyAdminService extends BaseService {
  constructor(private readonly repository: CompanyAdminRepository = companyAdminRepository) {
    super();
  }

  async listMembers(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const rows = await this.repository.listMembers(scopedCompanyId);

    return rows.map((row) => ({
      userId: row.userId,
      companyId: row.companyId,
      roleId: row.role,
      email: row.user.email,
      name: row.user.name,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createInvite(session: SessionScope, payload: CreateInviteDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    if (session.role === 'COMPANY_ADMIN' && payload.roleId !== 'MEMBER') {
      throw new HttpException(403, 'Company-admin can invite only MEMBER role');
    }

    const company = await this.repository.findCompany(scopedCompanyId);
    if (!company) {
      throw new HttpException(404, 'Company not found');
    }

    const invite = await this.repository.createInvite({
      companyId: scopedCompanyId,
      email: payload.email,
      role: payload.roleId,
      token: randomUUID(),
      invitedBy: session.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'admin.invite.create',
      outcome: 'success',
      metadata: {
        inviteId: invite.id,
        email: invite.email,
      },
    });

    return {
      inviteId: invite.id,
      companyId: invite.companyId,
      email: invite.email,
      roleId: invite.role,
      status: invite.status,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  async listInvites(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const rows = await this.repository.listInvites(scopedCompanyId);

    return rows.map((row) => ({
      inviteId: row.id,
      companyId: row.companyId,
      email: row.email,
      roleId: row.role,
      status: row.status,
      invitedBy: row.invitedBy,
      expiresAt: row.expiresAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async cancelInvite(session: SessionScope, inviteId: string) {
    const invite = await this.repository.findInvite(inviteId);
    if (!invite) {
      throw new HttpException(404, 'Invite not found');
    }

    resolveCompanyScope(session, invite.companyId);

    if (invite.status !== 'pending') {
      throw new HttpException(409, 'Only pending invites can be cancelled');
    }

    const cancelled = await this.repository.cancelInvite(inviteId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: cancelled.companyId,
      action: 'admin.invite.cancel',
      outcome: 'success',
      metadata: {
        inviteId,
      },
    });

    return {
      inviteId: cancelled.id,
      status: cancelled.status,
    };
  }

  async getOnboardingStatus(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    return companyOnboardingService.getCompanyOnboardingStatus(scopedCompanyId);
  }

  async connectOnboarding(session: SessionScope, payload: ConnectOnboardingDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    try {
      const result =
        payload.mode === 'mcp'
          ? await companyOnboardingService.connectZoho({
              companyId: scopedCompanyId,
              mode: 'mcp',
              environment: payload.environment,
              mcpBaseUrl: payload.mcpBaseUrl,
              mcpApiKey: payload.mcpApiKey,
              mcpWorkspaceKey: payload.mcpWorkspaceKey,
              allowedTools: payload.allowedTools,
              scopes: payload.scopes,
            })
          : await companyOnboardingService.connectZoho({
              companyId: scopedCompanyId,
              mode: 'rest',
              authorizationCode: payload.authorizationCode,
              scopes: payload.scopes,
              environment: payload.environment,
            });
      await auditService.recordLog({
        actorId: session.userId,
        companyId: scopedCompanyId,
        action: 'company.onboarding.zoho.connect',
        outcome: 'success',
        metadata: {
          environment: payload.environment,
          syncJobId: result.initialSync.jobId,
        },
      });
      return result;
    } catch (error) {
      await auditService.recordLog({
        actorId: session.userId,
        companyId: scopedCompanyId,
        action: 'company.onboarding.zoho.connect',
        outcome: 'failure',
        metadata: {
          environment: payload.environment,
          reason: error instanceof Error ? error.message : 'unknown_error',
        },
      });
      throw error;
    }
  }

  async disconnectOnboarding(session: SessionScope, payload: DisconnectOnboardingDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    try {
      const result = await companyOnboardingService.disconnectZoho(scopedCompanyId);
      await auditService.recordLog({
        actorId: session.userId,
        companyId: scopedCompanyId,
        action: 'company.onboarding.zoho.disconnect',
        outcome: 'success',
        metadata: {
          affectedConnections: result.affectedConnections,
        },
      });
      return result;
    } catch (error) {
      await auditService.recordLog({
        actorId: session.userId,
        companyId: scopedCompanyId,
        action: 'company.onboarding.zoho.disconnect',
        outcome: 'failure',
        metadata: {
          reason: error instanceof Error ? error.message : 'unknown_error',
        },
      });
      throw error;
    }
  }

  async triggerHistoricalSync(session: SessionScope, payload: TriggerHistoricalSyncDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    try {
      const result = await companyOnboardingService.triggerHistoricalSync(
        scopedCompanyId,
        'admin_manual_resync',
      );

      await auditService.recordLog({
        actorId: session.userId,
        companyId: scopedCompanyId,
        action: 'company.onboarding.zoho.sync.historical.trigger',
        outcome: 'success',
        metadata: {
          syncStatus: result.sync.status,
          jobId: result.sync.jobId,
        },
      });
      return result;
    } catch (error) {
      await auditService.recordLog({
        actorId: session.userId,
        companyId: scopedCompanyId,
        action: 'company.onboarding.zoho.sync.historical.trigger',
        outcome: 'failure',
        metadata: {
          reason: error instanceof Error ? error.message : 'unknown_error',
        },
      });
      throw error;
    }
  }

  async upsertLarkBinding(session: SessionScope, payload: UpsertLarkBindingDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    const binding = await larkTenantBindingRepository.upsert({
      companyId: scopedCompanyId,
      larkTenantKey: payload.larkTenantKey,
      createdBy: session.userId,
      isActive: payload.isActive,
    });

    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.lark_binding.upsert',
      outcome: 'success',
      metadata: {
        bindingId: binding.id,
        larkTenantKey: binding.larkTenantKey,
        isActive: binding.isActive,
      },
    });

    try {
      await larkDirectorySyncService.trigger(scopedCompanyId, 'setup');
    } catch {
      // setup sync is best-effort and remains available through manual trigger
    }

    return {
      bindingId: binding.id,
      companyId: binding.companyId,
      larkTenantKey: binding.larkTenantKey,
      isActive: binding.isActive,
      updatedAt: binding.updatedAt.toISOString(),
    };
  }

  async getLarkWorkspaceConfigStatus(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const status = await larkWorkspaceConfigRepository.getStatus(scopedCompanyId);
    return status ?? { configured: false };
  }

  async upsertLarkWorkspaceConfig(session: SessionScope, payload: UpsertLarkWorkspaceConfigDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    const existing = await larkWorkspaceConfigRepository.findByCompanyId(scopedCompanyId);

    const appSecret = payload.appSecret?.trim() || existing?.appSecret;
    if (!appSecret) {
      throw new HttpException(400, 'Lark appSecret is required');
    }

    const verificationToken = payload.verificationToken?.trim() || existing?.verificationToken;
    const signingSecret = payload.signingSecret?.trim() || existing?.signingSecret;
    if (!verificationToken && !signingSecret) {
      throw new HttpException(400, 'Provide verificationToken or signingSecret');
    }

    const record = await larkWorkspaceConfigRepository.upsert({
      companyId: scopedCompanyId,
      createdBy: session.userId,
      appId: payload.appId.trim(),
      appSecret,
      verificationToken,
      signingSecret,
      staticTenantAccessToken: payload.staticTenantAccessToken?.trim() || existing?.staticTenantAccessToken,
      apiBaseUrl: payload.apiBaseUrl?.trim() || existing?.apiBaseUrl,
    });

    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.lark_workspace_config.upsert',
      outcome: 'success',
      metadata: {
        appId: payload.appId.trim(),
      },
    });

    try {
      await larkDirectorySyncService.trigger(scopedCompanyId, 'setup');
    } catch {
      // setup sync is best-effort and remains available through manual trigger
    }

    return {
      configured: true,
      companyId: scopedCompanyId,
      appId: record.appId,
      apiBaseUrl: record.apiBaseUrl,
      hasVerificationToken: Boolean(record.verificationTokenEncrypted),
      hasSigningSecret: Boolean(record.signingSecretEncrypted),
      hasStaticTenantAccessToken: Boolean(record.staticTenantAccessTokenEncrypted),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async deleteLarkWorkspaceConfig(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    await larkWorkspaceConfigRepository.delete(scopedCompanyId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.lark_workspace_config.delete',
      outcome: 'success',
      metadata: {},
    });
    return {
      companyId: scopedCompanyId,
      deleted: true,
    };
  }

  async getLarkUserSyncStatus(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    return larkDirectorySyncService.getStatus(scopedCompanyId);
  }

  async triggerLarkUserSync(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const result = await larkDirectorySyncService.trigger(scopedCompanyId, 'manual');
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.lark_user_sync.trigger',
      outcome: 'success',
      metadata: result,
    });
    return result;
  }

  async getProviderStatus(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    return companyOnboardingService.getProviderStatus(scopedCompanyId);
  }

  async upsertZohoOAuthConfig(session: SessionScope, payload: UpsertZohoOAuthConfigDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    const record = await zohoOAuthConfigRepository.upsert(scopedCompanyId, {
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      redirectUri: payload.redirectUri,
      accountsBaseUrl: payload.accountsBaseUrl,
      apiBaseUrl: payload.apiBaseUrl,
    });

    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.zoho_oauth_config.upsert',
      outcome: 'success',
      metadata: { clientId: payload.clientId },
    });

    return {
      companyId: scopedCompanyId,
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      accountsBaseUrl: record.accountsBaseUrl,
      apiBaseUrl: record.apiBaseUrl,
      configured: true,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async getZohoOAuthConfigStatus(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const status = await zohoOAuthConfigRepository.getStatus(scopedCompanyId);
    return status ?? { configured: false };
  }

  async getZohoAuthorizeUrl(
    session: SessionScope,
    input: { companyId?: string; scopes?: string; environment: 'prod' | 'sandbox' },
  ) {
    const scopedCompanyId = resolveCompanyScope(session, input.companyId);
    const oauthStatus = await zohoOAuthConfigRepository.getStatus(scopedCompanyId);

    const clientId = oauthStatus?.clientId ?? config.ZOHO_CLIENT_ID;
    const redirectUri = oauthStatus?.redirectUri ?? config.ZOHO_REDIRECT_URI;
    const accountsBaseUrl = oauthStatus?.accountsBaseUrl ?? config.ZOHO_ACCOUNTS_BASE_URL;

    if (!clientId || !redirectUri) {
      throw new HttpException(
        400,
        'Zoho OAuth App is not configured. Save client ID, client secret, and redirect URI first.',
      );
    }

    const scopes = (input.scopes ?? 'ZohoCRM.modules.ALL')
      .split(',')
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);

    if (scopes.length === 0) {
      throw new HttpException(400, 'At least one Zoho scope is required');
    }

    const statePayload = {
      companyId: scopedCompanyId,
      scopes,
      environment: input.environment,
    };

    const state = Buffer.from(JSON.stringify(statePayload), 'utf8').toString('base64');
    const authorizeUrl = new URL('/oauth/v2/auth', accountsBaseUrl);
    authorizeUrl.searchParams.set('scope', scopes.join(','));
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('access_type', 'offline');
    authorizeUrl.searchParams.set('prompt', 'consent');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', state);

    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.zoho.oauth_authorize_url.generate',
      outcome: 'success',
      metadata: {
        environment: input.environment,
        scopesCount: scopes.length,
        oauthSource: oauthStatus?.configured ? 'company_config' : 'env_fallback',
      },
    });

    return {
      authorizeUrl: authorizeUrl.toString(),
      redirectUri,
      scopes,
      environment: input.environment,
      source: oauthStatus?.configured ? 'company_config' : 'env_fallback',
    };
  }

  async deleteZohoOAuthConfig(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    await zohoOAuthConfigRepository.delete(scopedCompanyId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.zoho_oauth_config.delete',
      outcome: 'success',
      metadata: {},
    });
    return { companyId: scopedCompanyId, deleted: true };
  }

  async listChannelIdentities(session: SessionScope, companyId?: string, channel?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const rows = await channelIdentityRepository.listByCompany(scopedCompanyId, channel);
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      channel: row.channel,
      externalUserId: row.externalUserId,
      externalTenantId: row.externalTenantId,
      displayName: row.displayName ?? undefined,
      email: row.email ?? undefined,
      larkOpenId: row.larkOpenId ?? undefined,
      larkUserId: row.larkUserId ?? undefined,
      sourceRoles: row.sourceRoles,
      aiRole: row.aiRole,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async getToolPermissions(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    return toolPermissionService.getMatrix(scopedCompanyId);
  }

  async updateToolPermission(
    session: SessionScope,
    toolId: string,
    role: string,
    enabled: boolean,
    companyId?: string,
  ) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const normalizedRole = role.trim().toUpperCase().replace(/\s+/g, '_');
    const validRoleSlugs = await aiRoleService.getRoleSlugs(scopedCompanyId);
    if (!validRoleSlugs.includes(normalizedRole)) {
      throw new HttpException(404, `Unknown AI role: ${normalizedRole}`);
    }
    const result = await toolPermissionService.updatePermission(
      scopedCompanyId,
      toolId,
      normalizedRole,
      enabled,
      session.userId,
    );
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'tool.permission.update',
      outcome: 'success',
      metadata: { toolId, role: normalizedRole, enabled },
    });
    return result;
  }

  async listAiRoles(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    return aiRoleService.listRoles(scopedCompanyId);
  }

  async createAiRole(session: SessionScope, slug: string, displayName: string, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const role = await aiRoleService.createRole(scopedCompanyId, slug, displayName);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'ai_role.create',
      outcome: 'success',
      metadata: { slug: role.slug, displayName: role.displayName },
    });
    return role;
  }

  async updateAiRole(session: SessionScope, roleId: string, displayName: string, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const role = await aiRoleService.updateRole(scopedCompanyId, roleId, displayName);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'ai_role.update',
      outcome: 'success',
      metadata: { roleId, displayName },
    });
    return role;
  }

  async deleteAiRole(session: SessionScope, roleId: string, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    await aiRoleService.deleteRole(scopedCompanyId, roleId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'ai_role.delete',
      outcome: 'success',
      metadata: { roleId },
    });
    return { deleted: true };
  }

  async setLarkUserRole(session: SessionScope, identityId: string, aiRole: string, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const normalizedRole = aiRole.trim().toUpperCase().replace(/\s+/g, '_');
    const validRoleSlugs = await aiRoleService.getRoleSlugs(scopedCompanyId);
    if (!validRoleSlugs.includes(normalizedRole)) {
      throw new HttpException(404, `Unknown AI role: ${normalizedRole}`);
    }
    const identity = await channelIdentityRepository.findById(identityId);
    if (!identity || identity.companyId !== scopedCompanyId) {
      throw new HttpException(404, 'Channel identity not found');
    }
    const updated = await channelIdentityRepository.setAiRole(identityId, normalizedRole);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'channel_identity.ai_role.update',
      outcome: 'success',
      metadata: { identityId, aiRole: normalizedRole },
    });
    return {
      id: updated.id,
      externalUserId: updated.externalUserId,
      displayName: updated.displayName ?? undefined,
      aiRole: updated.aiRole,
    };
  }
}

export const companyAdminService = new CompanyAdminService();
