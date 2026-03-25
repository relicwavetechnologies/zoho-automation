import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';

import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import config from '../../config';
import { channelIdentityRepository } from '../../company/channels/channel-identity.repository';
import { larkDirectorySyncService } from '../../company/channels/lark/lark-directory-sync.service';
import { larkOAuthService } from '../../company/channels/lark/lark-oauth.service';
import { larkTenantBindingRepository } from '../../company/channels/lark/lark-tenant-binding.repository';
import { larkWorkspaceConfigRepository } from '../../company/channels/lark/lark-workspace-config.repository';
import { larkOperationalConfigRepository } from '../../company/channels/lark/lark-operational-config.repository';
import { googleOAuthService } from '../../company/channels/google/google-oauth.service';
import { companyGoogleAuthLinkRepository } from '../../company/channels/google/company-google-auth-link.repository';
import { auditService } from '../audit/audit.service';
import { companyOnboardingService } from '../company-onboarding/company-onboarding.service';
import { CompanyAdminRepository, companyAdminRepository } from './company-admin.repository';
import {
  ConnectOnboardingDto,
  ConnectLarkOnboardingDto,
  ConnectGoogleOnboardingDto,
  GoogleAuthorizeUrlQueryDto,
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
import { zohoUserAccessExceptionService } from '../../company/tools/zoho-user-access-exception.service';
import { knowledgeShareService } from '../../company/knowledge-share/knowledge-share.service';
import { prisma } from '../../utils/prisma';
import { qdrantAdapter, vectorDocumentRepository } from '../../company/integrations/vector';
import { fileRetrievalService } from '../../company/retrieval/file-retrieval.service';
import { retrievalOrchestratorService, retrievalPlannerService } from '../../company/retrieval';
import {
  REQUIRED_ZOHO_OAUTH_SCOPES,
  resolveZohoOAuthScopes,
} from '../../company/integrations/zoho/zoho-oauth-scopes';
import { chooseFileChunkingPlan } from '../file-upload/file-chunking';

export type SessionScope = {
  userId: string;
  role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
  companyId?: string;
};

type CompanyDirectoryEntry = {
  key: string;
  userId?: string;
  channelIdentityId?: string;
  name?: string;
  email?: string;
  source: 'app' | 'lark' | 'app+lark';
  appStatus: 'joined_app' | 'lark_only';
  companyRole?: string;
  larkLinked: boolean;
  googleConnected: boolean;
  departmentCount: number;
  managerDepartmentCount: number;
  departmentNames: string[];
  larkRoles: string[];
  createdAt?: string;
  updatedAt?: string;
};

type RagReplayInput = {
  companyId?: string;
  query: string;
  fileAssetId?: string;
  preferParentContext?: boolean;
  limit?: number;
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

type CompanyGoogleStatePayload = {
  kind: 'company_google_connect';
  nonce: string;
  companyId: string;
  actorUserId: string;
};

const COMPANY_GOOGLE_STATE_TTL_SECONDS = 10 * 60;

const GOOGLE_ADMIN_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

const buildExpiry = (seconds?: number): Date | undefined => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return new Date(Date.now() + seconds * 1000);
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

  async getCompanyDirectory(session: SessionScope, companyId?: string): Promise<CompanyDirectoryEntry[]> {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const [activeMembers, larkIdentities, larkLinks, googleLinks, departmentMemberships] = await Promise.all([
      prisma.adminMembership.findMany({
        where: {
          companyId: scopedCompanyId,
          isActive: true,
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
        orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
      }),
      prisma.channelIdentity.findMany({
        where: {
          companyId: scopedCompanyId,
          channel: 'lark',
        },
        orderBy: [{ updatedAt: 'desc' }],
      }),
      prisma.larkUserAuthLink.findMany({
        where: {
          companyId: scopedCompanyId,
          revokedAt: null,
        },
        select: {
          userId: true,
        },
      }),
      prisma.googleUserAuthLink.findMany({
        where: {
          companyId: scopedCompanyId,
          revokedAt: null,
        },
        select: {
          userId: true,
        },
      }),
      prisma.departmentMembership.findMany({
        where: {
          status: 'active',
          department: {
            companyId: scopedCompanyId,
          },
        },
        include: {
          role: {
            select: {
              slug: true,
            },
          },
          department: {
            select: {
              name: true,
            },
          },
        },
      }),
    ]);

    const larkLinkedUserIds = new Set(larkLinks.map((row) => row.userId));
    const googleLinkedUserIds = new Set(googleLinks.map((row) => row.userId));

    const departmentSummaryByUserId = new Map<
      string,
      { departmentCount: number; managerDepartmentCount: number; departmentNames: string[] }
    >();

    for (const membership of departmentMemberships) {
      const current = departmentSummaryByUserId.get(membership.userId) ?? {
        departmentCount: 0,
        managerDepartmentCount: 0,
        departmentNames: [],
      };
      current.departmentCount += 1;
      if (membership.role.slug === 'MANAGER') {
        current.managerDepartmentCount += 1;
      }
      if (!current.departmentNames.includes(membership.department.name)) {
        current.departmentNames.push(membership.department.name);
      }
      departmentSummaryByUserId.set(membership.userId, current);
    }

    const memberByEmail = new Map<string, (typeof activeMembers)[number]>();
    const memberByUserId = new Map<string, (typeof activeMembers)[number]>();
    for (const member of activeMembers) {
      memberByUserId.set(member.userId, member);
      const email = member.user.email.trim().toLowerCase();
      if (!memberByEmail.has(email)) {
        memberByEmail.set(email, member);
      }
    }

    const entries = new Map<string, CompanyDirectoryEntry>();

    for (const identity of larkIdentities) {
      const normalizedEmail = identity.email?.trim().toLowerCase();
      const matchedMember = normalizedEmail ? memberByEmail.get(normalizedEmail) : undefined;
      const userId = matchedMember?.userId;
      const departmentSummary = userId ? departmentSummaryByUserId.get(userId) : undefined;
      const key = userId ? `user:${userId}` : `lark:${identity.id}`;

      entries.set(key, {
        key,
        userId,
        channelIdentityId: identity.id,
        name: matchedMember?.user.name ?? identity.displayName ?? undefined,
        email: matchedMember?.user.email ?? identity.email ?? undefined,
        source: userId ? 'app+lark' : 'lark',
        appStatus: userId ? 'joined_app' : 'lark_only',
        companyRole: matchedMember?.role,
        larkLinked: userId ? larkLinkedUserIds.has(userId) : false,
        googleConnected: userId ? googleLinkedUserIds.has(userId) : false,
        departmentCount: departmentSummary?.departmentCount ?? 0,
        managerDepartmentCount: departmentSummary?.managerDepartmentCount ?? 0,
        departmentNames: departmentSummary?.departmentNames ?? [],
        larkRoles: identity.sourceRoles,
        createdAt: matchedMember?.createdAt.toISOString() ?? identity.createdAt.toISOString(),
        updatedAt: identity.updatedAt.toISOString(),
      });
    }

    for (const member of activeMembers) {
      const key = `user:${member.userId}`;
      if (entries.has(key)) {
        continue;
      }
      const departmentSummary = departmentSummaryByUserId.get(member.userId);
      entries.set(key, {
        key,
        userId: member.userId,
        name: member.user.name ?? undefined,
        email: member.user.email,
        source: 'app',
        appStatus: 'joined_app',
        companyRole: member.role,
        larkLinked: larkLinkedUserIds.has(member.userId),
        googleConnected: googleLinkedUserIds.has(member.userId),
        departmentCount: departmentSummary?.departmentCount ?? 0,
        managerDepartmentCount: departmentSummary?.managerDepartmentCount ?? 0,
        departmentNames: departmentSummary?.departmentNames ?? [],
        larkRoles: [],
        createdAt: member.createdAt.toISOString(),
        updatedAt: member.updatedAt.toISOString(),
      });
    }

    return [...entries.values()].sort((left, right) => {
      const leftStatus = left.appStatus === 'joined_app' ? 1 : 0;
      const rightStatus = right.appStatus === 'joined_app' ? 1 : 0;
      if (rightStatus !== leftStatus) return rightStatus - leftStatus;
      return (left.name ?? left.email ?? left.key).localeCompare(right.name ?? right.email ?? right.key);
    });
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

  async getGoogleWorkspaceStatus(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const configured = googleOAuthService.isConfigured();
    const link = await companyGoogleAuthLinkRepository.findActiveByCompany(scopedCompanyId);
    return {
      configured,
      connected: Boolean(link),
      email: link?.googleEmail,
      name: link?.googleName,
      scopes: link?.scopes,
      updatedAt: link?.updatedAt?.toISOString(),
      source: link ? 'company_admin_oauth' : undefined,
      redirectUri: this.getGoogleAdminRedirectUri(),
    };
  }

  async getGoogleAuthorizeUrl(session: SessionScope, query: GoogleAuthorizeUrlQueryDto) {
    const scopedCompanyId = resolveCompanyScope(session, query.companyId);
    if (!googleOAuthService.isConfigured()) {
      throw new HttpException(400, 'Google OAuth is not configured in server env.');
    }

    const state = this.signGoogleWorkspaceState({
      kind: 'company_google_connect',
      nonce: randomUUID(),
      companyId: scopedCompanyId,
      actorUserId: session.userId,
    });

    return {
      authorizeUrl: googleOAuthService.getAuthorizeUrl({
        state,
        redirectUri: this.getGoogleAdminRedirectUri(),
        scopes: GOOGLE_ADMIN_SCOPES,
      }),
      redirectUri: this.getGoogleAdminRedirectUri(),
      scopes: GOOGLE_ADMIN_SCOPES,
    };
  }

  async connectGoogleWorkspace(session: SessionScope, payload: ConnectGoogleOnboardingDto) {
    const state = this.verifyGoogleWorkspaceState(payload.state);
    const scopedCompanyId = resolveCompanyScope(session, payload.companyId ?? state.companyId);
    if (state.companyId !== scopedCompanyId) {
      throw new HttpException(403, 'Google OAuth company scope mismatch.');
    }
    if (state.actorUserId !== session.userId) {
      throw new HttpException(403, 'Google OAuth actor mismatch.');
    }

    const tokenBundle = await googleOAuthService.exchangeAuthorizationCode(
      payload.authorizationCode,
      this.getGoogleAdminRedirectUri(),
    );
    const userInfo = await googleOAuthService.fetchUserInfo(tokenBundle.accessToken);

    const row = await companyGoogleAuthLinkRepository.upsert({
      companyId: scopedCompanyId,
      googleUserId: userInfo.sub,
      googleEmail: userInfo.email,
      googleName: userInfo.name,
      scope: tokenBundle.scope,
      accessToken: tokenBundle.accessToken,
      refreshToken: tokenBundle.refreshToken,
      tokenType: tokenBundle.tokenType,
      accessTokenExpiresAt: buildExpiry(tokenBundle.expiresIn),
      linkedByUserId: session.userId,
      tokenMetadata: {
        source: 'company_admin_oauth',
      },
    });

    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.google_workspace.connect',
      outcome: 'success',
      metadata: {
        googleEmail: row.googleEmail,
        googleName: row.googleName,
        scopes: row.scopes,
      },
    });

    return {
      connected: true,
      email: row.googleEmail,
      name: row.googleName,
      scopes: row.scopes,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async disconnectGoogleWorkspace(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    await companyGoogleAuthLinkRepository.revokeByCompany(scopedCompanyId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'company.onboarding.google_workspace.disconnect',
      outcome: 'success',
      metadata: {},
    });
    return { disconnected: true };
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

    const scopes = resolveZohoOAuthScopes(input.scopes);

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
        requiredScopesCount: REQUIRED_ZOHO_OAUTH_SCOPES.length,
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
    const normalizedEmails = [...new Set(rows
      .map((row) => row.email?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value)))];
    const users = normalizedEmails.length > 0
      ? await prisma.user.findMany({
        where: {
          OR: normalizedEmails.map((email) => ({
            email: {
              equals: email,
              mode: 'insensitive',
            },
          })),
        },
        select: { id: true, email: true },
      })
      : [];
    const userIdByEmail = new Map(
      users
        .map((row) => [row.email.trim().toLowerCase(), row.id] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1])),
    );
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
      linkedUserId: row.email ? userIdByEmail.get(row.email.trim().toLowerCase()) : undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async getToolPermissions(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    return toolPermissionService.getMatrix(scopedCompanyId);
  }

  async listZohoAccessExceptions(session: SessionScope, companyId?: string) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    return zohoUserAccessExceptionService.listByCompany(scopedCompanyId);
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

  async createZohoAccessException(
    session: SessionScope,
    input: {
      userId?: string;
      channelIdentityId?: string;
      bypassRelationScope?: boolean;
      reason?: string;
      expiresAt?: string;
    },
    companyId?: string,
  ) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const result = await zohoUserAccessExceptionService.upsert({
      companyId: scopedCompanyId,
      userId: input.userId,
      channelIdentityId: input.channelIdentityId,
      bypassRelationScope: input.bypassRelationScope,
      reason: input.reason,
      expiresAt: input.expiresAt,
      actorId: session.userId,
    });
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'zoho.access_exception.upsert',
      outcome: 'success',
      metadata: {
        exceptionId: result.id,
        userId: result.userId,
        channelIdentityId: result.channelIdentityId,
        bypassRelationScope: result.bypassRelationScope,
        expiresAt: result.expiresAt ?? null,
      },
    });
    return result;
  }

  async deleteZohoAccessException(
    session: SessionScope,
    exceptionId: string,
    companyId?: string,
  ) {
    const scopedCompanyId = resolveCompanyScope(session, companyId);
    const result = await zohoUserAccessExceptionService.delete(exceptionId, scopedCompanyId);
    await auditService.recordLog({
      actorId: session.userId,
      companyId: scopedCompanyId,
      action: 'zoho.access_exception.delete',
      outcome: 'success',
      metadata: {
        exceptionId: result.id,
        userId: result.userId,
      },
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

  async listRagFiles(session: SessionScope, input: {
    companyId?: string;
    query?: string;
    ingestionStatus?: string;
    limit?: number;
  }) {
    const scopedCompanyId = resolveCompanyScope(session, input.companyId);
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const query = input.query?.trim();
    const ingestionStatus = input.ingestionStatus?.trim();

    const files = await prisma.fileAsset.findMany({
      where: {
        companyId: scopedCompanyId,
        ...(ingestionStatus ? { ingestionStatus: ingestionStatus as never } : {}),
        ...(query
          ? {
              OR: [
                { fileName: { contains: query, mode: 'insensitive' } },
                { mimeType: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: limit,
      include: {
        vectorDocs: {
          orderBy: [{ chunkIndex: 'asc' }],
          take: 1,
        },
        _count: {
          select: {
            vectorDocs: true,
          },
        },
        accessPolicies: {
          select: {
            aiRole: true,
            canRead: true,
          },
          orderBy: [{ aiRole: 'asc' }],
        },
      },
    });

    return files.map((file) => {
      const firstPayload = (file.vectorDocs[0]?.payload ?? {}) as Record<string, unknown>;
      const previewText =
        typeof firstPayload._chunk === 'string'
          ? firstPayload._chunk
          : typeof firstPayload.text === 'string'
            ? firstPayload.text
            : '';
      const plan = chooseFileChunkingPlan({
        fileName: file.fileName,
        mimeType: file.mimeType,
        text: previewText,
      });

      return {
        fileAssetId: file.id,
        fileName: file.fileName,
        mimeType: file.mimeType,
        ingestionStatus: file.ingestionStatus,
        ingestionError: file.ingestionError ?? undefined,
        updatedAt: file.updatedAt.toISOString(),
        createdAt: file.createdAt.toISOString(),
        chunkCount: file._count.vectorDocs,
        documentClass:
          typeof firstPayload.documentClass === 'string' ? firstPayload.documentClass : plan.documentClass,
        chunkingStrategy:
          typeof firstPayload.chunkingStrategy === 'string' ? firstPayload.chunkingStrategy : plan.strategy,
        hierarchical:
          typeof firstPayload.hierarchical === 'boolean' ? firstPayload.hierarchical : plan.hierarchical,
        allowedRoles: file.accessPolicies.filter((policy) => policy.canRead).map((policy) => policy.aiRole),
      };
    });
  }

  async getRagFileDiagnostics(session: SessionScope, input: {
    companyId?: string;
    fileAssetId: string;
  }) {
    const scopedCompanyId = resolveCompanyScope(session, input.companyId);
    const file = await prisma.fileAsset.findFirst({
      where: {
        id: input.fileAssetId,
        companyId: scopedCompanyId,
      },
      include: {
        vectorDocs: {
          orderBy: [{ chunkIndex: 'asc' }],
        },
        accessPolicies: {
          select: {
            aiRole: true,
            canRead: true,
          },
          orderBy: [{ aiRole: 'asc' }],
        },
      },
    });

    if (!file) {
      throw new HttpException(404, 'File asset not found');
    }

    const chunks = file.vectorDocs.map((doc) => {
      const payload = (doc.payload ?? {}) as Record<string, unknown>;
      return {
        id: doc.id,
        chunkIndex: doc.chunkIndex,
        documentKey: doc.documentKey ?? undefined,
        contentHash: doc.contentHash,
        embeddingSchemaVersion: doc.embeddingSchemaVersion ?? undefined,
        retrievalProfile: doc.retrievalProfile ?? undefined,
        sourceUpdatedAt: doc.sourceUpdatedAt?.toISOString(),
        rawChunkText:
          typeof payload._chunk === 'string'
            ? payload._chunk
            : typeof payload.rawChunkText === 'string'
              ? payload.rawChunkText
              : undefined,
        indexedChunkText:
          typeof payload.indexedChunkText === 'string'
            ? payload.indexedChunkText
            : typeof payload.text === 'string'
              ? payload.text
              : undefined,
        documentClass: typeof payload.documentClass === 'string' ? payload.documentClass : undefined,
        chunkingStrategy: typeof payload.chunkingStrategy === 'string' ? payload.chunkingStrategy : undefined,
        sectionPath: Array.isArray(payload.sectionPath) ? payload.sectionPath : [],
        parentSectionId: typeof payload.parentSectionId === 'string' ? payload.parentSectionId : undefined,
        parentSectionText:
          typeof payload.parentSectionText === 'string' ? payload.parentSectionText : undefined,
        contextPrefix: typeof payload.contextPrefix === 'string' ? payload.contextPrefix : undefined,
        contextualEnrichmentApplied:
          typeof payload.contextualEnrichmentApplied === 'boolean'
            ? payload.contextualEnrichmentApplied
            : undefined,
      };
    });

    const previewText = chunks[0]?.rawChunkText ?? '';
    const inferredPlan = chooseFileChunkingPlan({
      fileName: file.fileName,
      mimeType: file.mimeType,
      text: previewText,
    });

    return {
      file: {
        fileAssetId: file.id,
        companyId: file.companyId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        cloudinaryUrl: file.cloudinaryUrl,
        ingestionStatus: file.ingestionStatus,
        ingestionError: file.ingestionError ?? undefined,
        updatedAt: file.updatedAt.toISOString(),
        createdAt: file.createdAt.toISOString(),
      },
      diagnostics: {
        chunkCount: chunks.length,
        documentClass: chunks[0]?.documentClass ?? inferredPlan.documentClass,
        chunkingStrategy: chunks[0]?.chunkingStrategy ?? inferredPlan.strategy,
        hierarchical: inferredPlan.hierarchical,
        contextualEnrichment: inferredPlan.contextualEnrichment,
        allowedRoles: file.accessPolicies.filter((policy) => policy.canRead).map((policy) => policy.aiRole),
      },
      chunks,
    };
  }

  async replayRagQuery(session: SessionScope, input: RagReplayInput) {
    const scopedCompanyId = resolveCompanyScope(session, input.companyId);
    const query = input.query.trim();
    if (!query) {
      throw new HttpException(400, 'query is required');
    }

    let fileFilter: string | undefined;
    let fileMetadata:
      | {
          fileAssetId: string;
          fileName: string;
          mimeType: string;
          ingestionStatus: string;
        }
      | undefined;

    if (input.fileAssetId?.trim()) {
      const file = await prisma.fileAsset.findFirst({
        where: {
          id: input.fileAssetId.trim(),
          companyId: scopedCompanyId,
        },
      });
      if (!file) {
        throw new HttpException(404, 'Selected file was not found');
      }
      fileFilter = file.id;
      fileMetadata = {
        fileAssetId: file.id,
        fileName: file.fileName,
        mimeType: file.mimeType,
        ingestionStatus: file.ingestionStatus,
      };
    }

    const startedAt = Date.now();
    const planner = retrievalPlannerService.buildPlan({
      messageText: query,
      domains: ['docs'],
      retrievalMode: 'vector',
      hasAttachments: Boolean(fileFilter),
    });
    const orchestrator = retrievalOrchestratorService.planExecution({
      messageText: query,
      domains: ['docs'],
      retrievalMode: 'vector',
      hasAttachments: Boolean(fileFilter),
    });
    const retrieval = await fileRetrievalService.search({
      companyId: scopedCompanyId,
      query,
      fileAssetId: fileFilter,
      limit: input.limit,
      preferParentContext: input.preferParentContext ?? true,
    });

    return {
      file: fileMetadata,
      planner,
      orchestrator: {
        toolFamilies: orchestrator.toolFamilies,
        systemDirectives: orchestrator.systemDirectives,
      },
      retrieval,
      metrics: {
        durationMs: Date.now() - startedAt,
        matchCount: retrieval.matches.length,
        citationCount: retrieval.citations.length,
        enhancements: retrieval.enhancements,
        correctiveRetryUsed: retrieval.correctiveRetryUsed,
      },
    };
  }

  private getGoogleAdminRedirectUri(): string {
    const backendBaseUrl = config.BACKEND_PUBLIC_URL.trim();
    if (!backendBaseUrl) {
      throw new HttpException(500, 'BACKEND_PUBLIC_URL is required for Google workspace OAuth.');
    }
    return `${backendBaseUrl.replace(/\/$/, '')}/api/admin/company/onboarding/google/callback`;
  }

  private signGoogleWorkspaceState(payload: CompanyGoogleStatePayload): string {
    return jwt.sign(payload, config.ADMIN_JWT_SECRET, {
      expiresIn: `${COMPANY_GOOGLE_STATE_TTL_SECONDS}s`,
    });
  }

  private verifyGoogleWorkspaceState(rawState: string): CompanyGoogleStatePayload {
    try {
      const parsed = jwt.verify(rawState, config.ADMIN_JWT_SECRET) as CompanyGoogleStatePayload;
      if (
        parsed.kind !== 'company_google_connect'
        || typeof parsed.companyId !== 'string'
        || parsed.companyId.trim().length === 0
        || typeof parsed.actorUserId !== 'string'
        || parsed.actorUserId.trim().length === 0
      ) {
        throw new Error('invalid_google_oauth_state');
      }
      return parsed;
    } catch {
      throw new HttpException(400, 'Invalid Google OAuth state.');
    }
  }
}

export const companyAdminService = new CompanyAdminService();
