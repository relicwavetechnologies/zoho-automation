import { randomUUID } from 'crypto';

import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import config from '../../config';
import { channelIdentityRepository } from '../../company/channels/channel-identity.repository';
import { larkDirectorySyncService } from '../../company/channels/lark/lark-directory-sync.service';
import { larkOAuthService } from '../../company/channels/lark/lark-oauth.service';
import { larkTenantBindingRepository } from '../../company/channels/lark/lark-tenant-binding.repository';
import { larkWorkspaceConfigRepository } from '../../company/channels/lark/lark-workspace-config.repository';
import { larkOperationalConfigRepository } from '../../company/channels/lark/lark-operational-config.repository';
import { auditService } from '../audit/audit.service';
import { companyOnboardingService } from '../company-onboarding/company-onboarding.service';
import { CompanyAdminRepository, companyAdminRepository } from './company-admin.repository';
import {
  ConnectOnboardingDto,
  ConnectLarkOnboardingDto,
  DisconnectOnboardingDto,
  TriggerHistoricalSyncDto,
  UpsertLarkBindingDto,
  UpsertLarkOperationalConfigDto,
  UpsertLarkWorkspaceConfigDto,
  UpsertZohoOAuthConfigDto,
} from './dto/connect-onboarding.dto';
import { CreateInviteDto } from './dto/create-invite.dto';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { aiRoleService } from '../../company/tools/ai-role.service';
import { zohoRoleAccessService } from '../../company/tools/zoho-role-access.service';
import { knowledgeShareService } from '../../company/knowledge-share/knowledge-share.service';
import { prisma } from '../../utils/prisma';
import { qdrantAdapter, vectorDocumentRepository } from '../../company/integrations/vector';

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

const DEFAULT_ZOHO_SCOPES = [
  'ZohoCRM.modules.ALL',
  'ZohoCRM.coql.READ',
  'ZohoCRM.settings.fields.READ',
];

const hasPlatformZohoOAuthConfig = (): boolean =>
  Boolean(
    config.ZOHO_CLIENT_ID.trim()
    && config.ZOHO_CLIENT_SECRET.trim()
    && config.ZOHO_REDIRECT_URI.trim(),
  );

const hasPlatformLarkRuntimeConfig = (): boolean =>
  Boolean(
    config.LARK_APP_ID.trim()
    && config.LARK_APP_SECRET.trim()
    && (config.LARK_VERIFICATION_TOKEN.trim() || config.LARK_WEBHOOK_SIGNING_SECRET.trim()),
  );

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
      if (payload.mode === 'mcp') {
        throw new HttpException(400, 'Zoho MCP onboarding is no longer supported. Use OAuth/REST connection.');
      }
      const result = await companyOnboardingService.connectZoho({
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
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.lark_binding.upsert.blocked',
      outcome: 'failure',
      metadata: {},
    });
    throw new HttpException(403, 'Manual Lark tenant binding is disabled. Use the one-click Lark connect flow.');
  }

  async getLarkWorkspaceConfigStatus(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const legacyStatus = await larkWorkspaceConfigRepository.getStatus(scopedCompanyId);
    const platformConfigured = hasPlatformLarkRuntimeConfig();
    if (platformConfigured) {
      return {
        configured: true,
        appId: config.LARK_APP_ID,
        apiBaseUrl: config.LARK_API_BASE_URL,
        hasVerificationToken: Boolean(config.LARK_VERIFICATION_TOKEN.trim()),
        hasSigningSecret: Boolean(config.LARK_WEBHOOK_SIGNING_SECRET.trim()),
        hasStaticTenantAccessToken: Boolean(config.LARK_BOT_TENANT_ACCESS_TOKEN.trim()),
        source: 'platform_env',
      };
    }
    if (legacyStatus?.configured) {
      return {
        ...legacyStatus,
        source: 'legacy_company_config',
        appId: legacyStatus.appId,
        apiBaseUrl: legacyStatus.apiBaseUrl,
      };
    }
    return { configured: false, source: 'missing' };
  }

  async upsertLarkWorkspaceConfig(session: SessionScope, payload: UpsertLarkWorkspaceConfigDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.lark_workspace_config.upsert.blocked',
      outcome: 'failure',
      metadata: {},
    });
    throw new HttpException(403, 'Company-managed Lark credentials are disabled. Ask the platform admin to configure env-backed Lark access.');
  }

  async deleteLarkWorkspaceConfig(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.lark_workspace_config.delete.blocked',
      outcome: 'failure',
      metadata: {},
    });
    throw new HttpException(403, 'Company-managed Lark credentials are disabled. Existing legacy config is retained for compatibility.');
  }

  async getLarkOperationalConfig(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const configRow = await larkOperationalConfigRepository.findByCompanyId(scopedCompanyId);
    return {
      configured: Boolean(configRow),
      defaultBaseAppToken: configRow?.defaultBaseAppToken ?? undefined,
      defaultBaseTableId: configRow?.defaultBaseTableId ?? undefined,
      defaultBaseViewId: configRow?.defaultBaseViewId ?? undefined,
      defaultTasklistId: configRow?.defaultTasklistId ?? undefined,
      defaultCalendarId: configRow?.defaultCalendarId ?? undefined,
      defaultApprovalCode: configRow?.defaultApprovalCode ?? undefined,
      updatedAt: configRow?.updatedAt?.toISOString(),
    };
  }

  async upsertLarkOperationalConfig(session: SessionScope, payload: UpsertLarkOperationalConfigDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    const row = await larkOperationalConfigRepository.upsert({
      companyId: scopedCompanyId,
      createdBy: session.userId,
      defaultBaseAppToken: payload.defaultBaseAppToken,
      defaultBaseTableId: payload.defaultBaseTableId,
      defaultBaseViewId: payload.defaultBaseViewId,
      defaultTasklistId: payload.defaultTasklistId,
      defaultCalendarId: payload.defaultCalendarId,
      defaultApprovalCode: payload.defaultApprovalCode,
    });
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.lark_operational_config.upsert',
      outcome: 'success',
      metadata: {
        hasDefaultBase: Boolean(row.defaultBaseAppToken && row.defaultBaseTableId),
        hasDefaultTasklist: Boolean(row.defaultTasklistId),
        hasDefaultCalendar: Boolean(row.defaultCalendarId),
        hasDefaultApproval: Boolean(row.defaultApprovalCode),
      },
    });
    return {
      configured: true,
      defaultBaseAppToken: row.defaultBaseAppToken ?? undefined,
      defaultBaseTableId: row.defaultBaseTableId ?? undefined,
      defaultBaseViewId: row.defaultBaseViewId ?? undefined,
      defaultTasklistId: row.defaultTasklistId ?? undefined,
      defaultCalendarId: row.defaultCalendarId ?? undefined,
      defaultApprovalCode: row.defaultApprovalCode ?? undefined,
      updatedAt: row.updatedAt.toISOString(),
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
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.zoho_oauth_config.upsert.blocked',
      outcome: 'failure',
      metadata: {},
    });
    throw new HttpException(403, 'Company-managed Zoho OAuth app credentials are disabled. Zoho uses platform-managed env credentials.');
  }

  async getZohoOAuthConfigStatus(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    void scopedCompanyId;
    if (!hasPlatformZohoOAuthConfig()) {
      return { configured: false, source: 'missing' };
    }
    return {
      configured: true,
      clientId: config.ZOHO_CLIENT_ID,
      redirectUri: config.ZOHO_REDIRECT_URI,
      accountsBaseUrl: config.ZOHO_ACCOUNTS_BASE_URL,
      apiBaseUrl: config.ZOHO_API_BASE_URL,
      source: 'platform_env',
    };
  }

  async getZohoAuthorizeUrl(
    session: SessionScope,
    input: { companyId?: string; scopes?: string; environment: 'prod' | 'sandbox' },
  ) {
    const scopedCompanyId = resolveCompanyScope(session, input.companyId);
    if (!hasPlatformZohoOAuthConfig()) {
      throw new HttpException(
        400,
        'Platform-managed Zoho OAuth is not configured in server env.',
      );
    }

    const scopes = (input.scopes ?? DEFAULT_ZOHO_SCOPES.join(','))
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
    const authorizeUrl = new URL('/oauth/v2/auth', config.ZOHO_ACCOUNTS_BASE_URL);
    authorizeUrl.searchParams.set('scope', scopes.join(','));
    authorizeUrl.searchParams.set('client_id', config.ZOHO_CLIENT_ID);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('access_type', 'offline');
    authorizeUrl.searchParams.set('prompt', 'consent');
    authorizeUrl.searchParams.set('redirect_uri', config.ZOHO_REDIRECT_URI);
    authorizeUrl.searchParams.set('state', state);

    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.zoho.oauth_authorize_url.generate',
      outcome: 'success',
      metadata: {
        environment: input.environment,
        scopesCount: scopes.length,
        oauthSource: 'platform_env',
      },
    });

    return {
      authorizeUrl: authorizeUrl.toString(),
      redirectUri: config.ZOHO_REDIRECT_URI,
      scopes,
      environment: input.environment,
      source: 'platform_env',
    };
  }

  async deleteZohoOAuthConfig(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.zoho_oauth_config.delete.blocked',
      outcome: 'failure',
      metadata: {},
    });
    throw new HttpException(403, 'Company-managed Zoho OAuth app credentials are disabled. Existing legacy config is retained for compatibility.');
  }

  async getLarkAuthorizeUrl(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    if (!larkOAuthService.isConfigured()) {
      throw new HttpException(400, 'Platform-managed Lark OAuth is not configured in server env.');
    }

    const state = Buffer.from(JSON.stringify({ companyId: scopedCompanyId }), 'utf8').toString('base64');
    const authorizeUrl = larkOAuthService.getAuthorizeUrl({ state });

    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.lark.oauth_authorize_url.generate',
      outcome: 'success',
      metadata: {},
    });

    return {
      authorizeUrl,
      redirectUri: larkOAuthService.getRedirectUri(),
      source: 'platform_env',
    };
  }

  async connectLarkOnboarding(session: SessionScope, payload: ConnectLarkOnboardingDto) {
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId);
    try {
      if (!hasPlatformLarkRuntimeConfig()) {
        throw new HttpException(400, 'Platform-managed Lark runtime is not configured in server env.');
      }
      const tokenBundle = await larkOAuthService.exchangeAuthorizationCode(payload.authorizationCode);
      const userInfo = await larkOAuthService.fetchUserInfo(tokenBundle.accessToken);
      const binding = await larkTenantBindingRepository.upsert({
        companyId: scopedCompanyId,
        larkTenantKey: userInfo.tenantKey,
        createdBy: session.userId,
        isActive: true,
      });

      const sync = await larkDirectorySyncService.trigger(scopedCompanyId, 'setup');
      await auditService.recordLog({
        actorId: session.userId,
        companyId: scopedCompanyId,
        action: 'company.onboarding.lark.connect',
        outcome: 'success',
        metadata: {
          bindingId: binding.id,
          larkTenantKey: binding.larkTenantKey,
          runId: sync.runId,
        },
      });

      return {
        bindingId: binding.id,
        companyId: binding.companyId,
        larkTenantKey: binding.larkTenantKey,
        isActive: binding.isActive,
        updatedAt: binding.updatedAt.toISOString(),
        sync,
      };
    } catch (error) {
      await auditService.recordLog({
        actorId: session.userId,
        companyId: scopedCompanyId,
        action: 'company.onboarding.lark.connect',
        outcome: 'failure',
        metadata: {
          reason: error instanceof Error ? error.message : 'unknown_error',
        },
      });
      throw error;
    }
  }

  async disconnectLarkOnboarding(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const result = await larkTenantBindingRepository.deactivateByCompany(scopedCompanyId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.lark.disconnect',
      outcome: 'success',
      metadata: {
        affectedBindings: result.count,
      },
    });
    return {
      companyId: scopedCompanyId,
      affectedBindings: result.count,
      disconnected: true,
    };
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
      aiRoleSource: row.aiRoleSource,
      syncedAiRole: row.syncedAiRole ?? undefined,
      syncedFromLarkRole: row.syncedFromLarkRole ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async getToolPermissions(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    return toolPermissionService.getMatrix(scopedCompanyId);
  }

  async getZohoRoleAccessMatrix(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    return zohoRoleAccessService.getMatrix(scopedCompanyId);
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

  async updateZohoRoleAccess(
    session: SessionScope,
    role: string,
    companyScopedRead: boolean,
    companyId?: string,
  ) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const normalizedRole = role.trim().toUpperCase().replace(/\s+/g, '_');
    const validRoleSlugs = await aiRoleService.getRoleSlugs(scopedCompanyId);
    if (!validRoleSlugs.includes(normalizedRole)) {
      throw new HttpException(404, `Unknown AI role: ${normalizedRole}`);
    }
    const result = await zohoRoleAccessService.updateRoleAccess(
      scopedCompanyId,
      normalizedRole,
      companyScopedRead,
      session.userId,
    );
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'zoho.role_access.update',
      outcome: 'success',
      metadata: { role: normalizedRole, companyScopedRead },
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
      aiRoleSource: updated.aiRoleSource,
    };
  }

  async resetLarkUserRole(session: SessionScope, identityId: string, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const identity = await channelIdentityRepository.findById(identityId);
    if (!identity || identity.companyId !== scopedCompanyId) {
      throw new HttpException(404, 'Channel identity not found');
    }
    const updated = await channelIdentityRepository.resetAiRoleToSynced(identityId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'channel_identity.ai_role.reset_to_sync',
      outcome: 'success',
      metadata: { identityId, syncedAiRole: updated.aiRole },
    });
    return {
      id: updated.id,
      externalUserId: updated.externalUserId,
      displayName: updated.displayName ?? undefined,
      aiRole: updated.aiRole,
      aiRoleSource: updated.aiRoleSource,
    };
  }

  async listVectorShareRequests(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    return knowledgeShareService.listRequests(scopedCompanyId);
  }

  async createVectorShareRequest(
    session: SessionScope,
    input: {
      companyId?: string;
      requesterUserId: string;
      requesterChannelIdentityId?: string;
      conversationKey: string;
      reason?: string;
      expiresAt?: string;
    },
  ) {
    const scopedCompanyId = resolveCompanyScope(session, input.companyId);
    const docs = await vectorDocumentRepository.findByConversation({
      companyId: scopedCompanyId,
      requesterUserId: input.requesterUserId,
      conversationKey: input.conversationKey,
    });

    if (docs.length === 0) {
      throw new HttpException(404, 'No personal conversation vectors found for this request');
    }

    const existingPending = await prisma.vectorShareRequest.findFirst({
      where: {
        companyId: scopedCompanyId,
        requesterUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        status: 'pending',
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const row = existingPending ?? await prisma.vectorShareRequest.create({
      data: {
        companyId: scopedCompanyId,
        requesterUserId: input.requesterUserId,
        requesterChannelIdentityId: input.requesterChannelIdentityId,
        conversationKey: input.conversationKey,
        status: 'pending',
        reason: input.reason,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });

    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'vector_share_request.create',
      outcome: 'success',
      metadata: {
        requestId: row.id,
        requesterUserId: input.requesterUserId,
        conversationKey: input.conversationKey,
        vectorCount: docs.length,
      },
    });

    return {
      id: row.id,
      status: row.status,
      conversationKey: row.conversationKey,
      requesterUserId: row.requesterUserId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async approveVectorShareRequest(
    session: SessionScope,
    requestId: string,
    input: { companyId?: string; decisionNote?: string },
  ) {
    const row = await prisma.vectorShareRequest.findUnique({
      where: { id: requestId },
    });
    if (!row) {
      throw new HttpException(404, 'Vector share request not found');
    }

    const scopedCompanyId = resolveCompanyScope(session, input.companyId ?? row.companyId);
    if (row.companyId !== scopedCompanyId) {
      throw new HttpException(403, 'Company scope mismatch');
    }
    if (row.status !== 'pending' && row.status !== 'delivery_failed') {
      throw new HttpException(409, 'Only pending vector share requests can be approved');
    }
    return knowledgeShareService.approveRequest({
      requestId,
      reviewerUserId: session.userId,
      decisionNote: input.decisionNote,
    });
  }

  async rejectVectorShareRequest(
    session: SessionScope,
    requestId: string,
    input: { companyId?: string; decisionNote?: string },
  ) {
    const row = await prisma.vectorShareRequest.findUnique({
      where: { id: requestId },
    });
    if (!row) {
      throw new HttpException(404, 'Vector share request not found');
    }

    const scopedCompanyId = resolveCompanyScope(session, input.companyId ?? row.companyId);
    if (row.companyId !== scopedCompanyId) {
      throw new HttpException(403, 'Company scope mismatch');
    }
    if (row.status !== 'pending' && row.status !== 'delivery_failed') {
      throw new HttpException(409, 'Only pending vector share requests can be rejected');
    }
    return knowledgeShareService.rejectRequest({
      requestId,
      reviewerUserId: session.userId,
      decisionNote: input.decisionNote,
    });
  }

  async revertVectorShareRequest(
    session: SessionScope,
    requestId: string,
    input: { companyId?: string; decisionNote?: string },
  ) {
    const row = await prisma.vectorShareRequest.findUnique({
      where: { id: requestId },
    });
    if (!row) {
      throw new HttpException(404, 'Vector share request not found');
    }

    const scopedCompanyId = resolveCompanyScope(session, input.companyId ?? row.companyId);
    if (row.companyId !== scopedCompanyId) {
      throw new HttpException(403, 'Company scope mismatch');
    }
    if (!['approved', 'auto_shared', 'shared_notified'].includes(row.status)) {
      throw new HttpException(409, 'Only approved or shared requests can be reverted');
    }
    return knowledgeShareService.revertRequest({
      requestId,
      reviewerUserId: session.userId,
      decisionNote: input.decisionNote,
    });
  }
}

export const companyAdminService = new CompanyAdminService();
