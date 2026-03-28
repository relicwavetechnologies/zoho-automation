import { Request, Response } from 'express';

import config from '../../config';
import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import {
  createZohoConnectionProfileSchema,
  connectLarkOnboardingSchema,
  connectGoogleOnboardingSchema,
  connectOnboardingSchema,
  disconnectOnboardingSchema,
  googleAuthorizeUrlQuerySchema,
  larkAuthorizeUrlQuerySchema,
  larkSyncQuerySchema,
  triggerHistoricalSyncSchema,
  updateZohoConnectionProfileSchema,
  zohoAuthorizeUrlQuerySchema,
  zohoProfileQuerySchema,
  upsertLarkBindingSchema,
  upsertLarkWorkspaceConfigSchema,
  upsertLarkOperationalConfigSchema,
  upsertZohoOAuthConfigSchema,
} from './dto/connect-onboarding.dto';
import { createInviteSchema } from './dto/create-invite.dto';
import { CompanyAdminService, companyAdminService } from './company-admin.service';

class CompanyAdminController extends BaseController {
  constructor(private readonly service: CompanyAdminService = companyAdminService) {
    super();
  }

  private readSession = (req: Request) =>
    (req as Request & {
      adminSession?: {
        userId: string;
        role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
        companyId?: string;
      };
    }).adminSession;

  listMembers = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.listMembers(session, companyId);
    return res.json(ApiResponse.success(result, 'Members loaded'));
  };

  getCompanyDirectory = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getCompanyDirectory(session, companyId);
    return res.json(ApiResponse.success(result, 'Company directory loaded'));
  };

  createInvite = async (req: Request, res: Response) => {
    const payload = createInviteSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }

    const result = await this.service.createInvite(session, payload);
    return res.status(201).json(ApiResponse.success(result, 'Invite created'));
  };

  listInvites = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }

    const result = await this.service.listInvites(session, companyId);
    return res.json(ApiResponse.success(result, 'Invites loaded'));
  };

  listRagFiles = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }

    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const query = typeof req.query.query === 'string' ? req.query.query : undefined;
    const ingestionStatus =
      typeof req.query.ingestionStatus === 'string' && req.query.ingestionStatus.trim().length > 0
        ? req.query.ingestionStatus.trim()
        : undefined;
    const rawLimit =
      typeof req.query.limit === 'string' && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : undefined;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : undefined;

    const result = await this.service.listRagFiles(session, {
      companyId,
      query,
      ingestionStatus,
      limit,
    });
    return res.json(ApiResponse.success(result, 'RAG files loaded'));
  };

  getRagFileDiagnostics = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }

    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const result = await this.service.getRagFileDiagnostics(session, {
      companyId,
      fileAssetId: req.params.fileAssetId,
    });
    return res.json(ApiResponse.success(result, 'RAG file diagnostics loaded'));
  };

  replayRagQuery = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }

    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      return res.status(400).json({ success: false, message: '`query` is required' });
    }

    const rawLimit = req.body?.limit;
    const limit =
      typeof rawLimit === 'number'
        ? rawLimit
        : typeof rawLimit === 'string' && rawLimit.trim().length > 0
          ? Number(rawLimit)
          : undefined;

    const result = await this.service.replayRagQuery(session, {
      companyId: typeof req.body?.companyId === 'string' ? req.body.companyId : undefined,
      query,
      fileAssetId:
        typeof req.body?.fileAssetId === 'string' && req.body.fileAssetId.trim().length > 0
          ? req.body.fileAssetId.trim()
          : undefined,
      preferParentContext:
        typeof req.body?.preferParentContext === 'boolean' ? req.body.preferParentContext : undefined,
      limit: typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined,
    });
    return res.json(ApiResponse.success(result, 'RAG replay completed'));
  };

  cancelInvite = async (req: Request, res: Response) => {
    const inviteId = req.params.inviteId;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }

    const result = await this.service.cancelInvite(session, inviteId);
    return res.json(ApiResponse.success(result, 'Invite cancelled'));
  };

  getOnboardingStatus = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getOnboardingStatus(session, companyId);
    return res.json(ApiResponse.success(result, 'Onboarding status loaded'));
  };

  connectOnboarding = async (req: Request, res: Response) => {
    const payload = connectOnboardingSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.connectOnboarding(session, payload);
    return res.status(202).json(ApiResponse.success(result, 'Zoho connected and sync queued'));
  };

  disconnectOnboarding = async (req: Request, res: Response) => {
    const payload = disconnectOnboardingSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.disconnectOnboarding(session, payload);
    return res.json(ApiResponse.success(result, 'Zoho disconnected'));
  };

  triggerHistoricalSync = async (req: Request, res: Response) => {
    const payload = triggerHistoricalSyncSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.triggerHistoricalSync(session, payload);
    return res.status(202).json(ApiResponse.success(result, 'Historical sync triggered'));
  };

  upsertLarkBinding = async (req: Request, res: Response) => {
    const payload = upsertLarkBindingSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.upsertLarkBinding(session, payload);
    return res.status(201).json(ApiResponse.success(result, 'Lark tenant binding saved'));
  };

  getLarkWorkspaceConfigStatus = async (req: Request, res: Response) => {
    const query = larkSyncQuerySchema.parse(req.query);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getLarkWorkspaceConfigStatus(session, query.companyId);
    return res.json(ApiResponse.success(result, 'Lark workspace config status loaded'));
  };

  upsertLarkWorkspaceConfig = async (req: Request, res: Response) => {
    const payload = upsertLarkWorkspaceConfigSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.upsertLarkWorkspaceConfig(session, payload);
    return res.status(201).json(ApiResponse.success(result, 'Lark workspace config saved'));
  };

  getLarkOperationalConfig = async (req: Request, res: Response) => {
    const query = larkSyncQuerySchema.parse(req.query);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getLarkOperationalConfig(session, query.companyId);
    return res.json(ApiResponse.success(result, 'Lark operational config loaded'));
  };

  upsertLarkOperationalConfig = async (req: Request, res: Response) => {
    const payload = upsertLarkOperationalConfigSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.upsertLarkOperationalConfig(session, payload);
    return res.status(201).json(ApiResponse.success(result, 'Lark operational config saved'));
  };

  deleteLarkWorkspaceConfig = async (req: Request, res: Response) => {
    const query = larkSyncQuerySchema.parse(req.query);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.deleteLarkWorkspaceConfig(session, query.companyId);
    return res.json(ApiResponse.success(result, 'Lark workspace config removed'));
  };

  getLarkUserSyncStatus = async (req: Request, res: Response) => {
    const query = larkSyncQuerySchema.parse(req.query);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getLarkUserSyncStatus(session, query.companyId);
    return res.json(ApiResponse.success(result, 'Lark user sync status loaded'));
  };

  triggerLarkUserSync = async (req: Request, res: Response) => {
    const payload = larkSyncQuerySchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.triggerLarkUserSync(session, payload.companyId);
    return res.status(202).json(ApiResponse.success(result, 'Lark user sync triggered'));
  };

  getProviderStatus = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getProviderStatus(session, companyId);
    return res.json(ApiResponse.success(result, 'Zoho provider status loaded'));
  };

  getGoogleWorkspaceStatus = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getGoogleWorkspaceStatus(session, companyId);
    return res.json(ApiResponse.success(result, 'Google workspace status loaded'));
  };

  getGoogleAuthorizeUrl = async (req: Request, res: Response) => {
    const query = googleAuthorizeUrlQuerySchema.parse(req.query);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getGoogleAuthorizeUrl(session, query);
    return res.json(ApiResponse.success(result, 'Google authorize URL generated'));
  };

  connectGoogleWorkspace = async (req: Request, res: Response) => {
    const payload = connectGoogleOnboardingSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.connectGoogleWorkspace(session, payload);
    return res.status(201).json(ApiResponse.success(result, 'Google workspace connected'));
  };

  disconnectGoogleWorkspace = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.disconnectGoogleWorkspace(session, companyId);
    return res.json(ApiResponse.success(result, 'Google workspace disconnected'));
  };

  googleCallbackRelay = async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;

    const appBaseUrl = config.APP_BASE_URL.trim();
    if (!appBaseUrl) {
      return res.status(500).send('APP_BASE_URL is not configured.');
    }
    const target = new URL(`${appBaseUrl.replace(/\/$/, '')}/google/callback`);
    if (code) target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);
    if (error) target.searchParams.set('error', error);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Google Workspace Callback</title></head>
  <body style="font-family: sans-serif; background: #0a0a0a; color: #e4e4e7; display: flex; min-height: 100vh; align-items: center; justify-content: center;">
    <div style="max-width: 560px; padding: 24px; border: 1px solid #27272a; border-radius: 12px; background: #111;">
      <h1 style="margin: 0 0 12px 0; font-size: 20px;">Returning to admin…</h1>
      <p style="margin: 0 0 16px 0; color: #a1a1aa;">If the dashboard does not open automatically, use the button below.</p>
      <a href="${target.toString().replace(/"/g, '&quot;')}" style="display: inline-block; padding: 10px 16px; border-radius: 8px; background: #f4f4f5; color: #09090b; text-decoration: none; font-weight: 600;">Open Admin Dashboard</a>
      <script>window.location.replace(${JSON.stringify(target.toString())});</script>
    </div>
  </body>
</html>`);
  };

  getZohoOAuthConfigStatus = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getZohoOAuthConfigStatus(session, companyId);
    return res.json(ApiResponse.success(result, 'Zoho OAuth config status loaded'));
  };

  listZohoConnectionProfiles = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const query = zohoProfileQuerySchema.parse(req.query);
    const result = await this.service.listZohoConnectionProfiles(session, query);
    return res.json(ApiResponse.success(result, 'Zoho connection profiles loaded'));
  };

  createZohoConnectionProfile = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const payload = createZohoConnectionProfileSchema.parse(req.body);
    const result = await this.service.createZohoConnectionProfile(session, payload);
    return res.status(201).json(ApiResponse.success(result, 'Zoho connection profile created'));
  };

  updateZohoConnectionProfile = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const payload = updateZohoConnectionProfileSchema.parse(req.body);
    const result = await this.service.updateZohoConnectionProfile(session, req.params.profileId, payload);
    return res.json(ApiResponse.success(result, 'Zoho connection profile updated'));
  };

  activateZohoConnectionProfile = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const companyId = typeof req.body?.companyId === 'string' ? req.body.companyId : undefined;
    const result = await this.service.activateZohoConnectionProfile(session, req.params.profileId, companyId);
    return res.json(ApiResponse.success(result, 'Zoho connection profile activated'));
  };

  disableZohoConnectionProfile = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const companyId = typeof req.body?.companyId === 'string' ? req.body.companyId : undefined;
    const result = await this.service.disableZohoConnectionProfile(session, req.params.profileId, companyId);
    return res.json(ApiResponse.success(result, 'Zoho connection profile disabled'));
  };

  getZohoAuthorizeUrl = async (req: Request, res: Response) => {
    const query = zohoAuthorizeUrlQuerySchema.parse(req.query);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getZohoAuthorizeUrl(session, {
      companyId: query.companyId,
      scopes: query.scopes,
      environment: query.environment ?? 'prod',
    });
    return res.json(ApiResponse.success(result, 'Zoho OAuth authorize URL generated'));
  };

  upsertZohoOAuthConfig = async (req: Request, res: Response) => {
    const payload = upsertZohoOAuthConfigSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.upsertZohoOAuthConfig(session, payload);
    return res.status(201).json(ApiResponse.success(result, 'Zoho OAuth app credentials saved'));
  };

  deleteZohoOAuthConfig = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.deleteZohoOAuthConfig(session, companyId);
    return res.json(ApiResponse.success(result, 'Zoho OAuth app credentials removed'));
  };

  getLarkAuthorizeUrl = async (req: Request, res: Response) => {
    const query = larkAuthorizeUrlQuerySchema.parse(req.query);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getLarkAuthorizeUrl(session, query.companyId);
    return res.json(ApiResponse.success(result, 'Lark authorize URL generated'));
  };

  connectLarkOnboarding = async (req: Request, res: Response) => {
    const payload = connectLarkOnboardingSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.connectLarkOnboarding(session, payload);
    return res.status(202).json(ApiResponse.success(result, 'Lark workspace linked and sync queued'));
  };

  disconnectLarkOnboarding = async (req: Request, res: Response) => {
    const payload = disconnectOnboardingSchema.parse(req.body);
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.disconnectLarkOnboarding(session, payload.companyId);
    return res.json(ApiResponse.success(result, 'Lark workspace disconnected'));
  };

  listChannelIdentities = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const channel = typeof req.query.channel === 'string' ? req.query.channel : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.listChannelIdentities(session, companyId, channel);
    return res.json(ApiResponse.success(result, 'Channel identities loaded'));
  };

  listVectorShareRequests = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.listVectorShareRequests(session, companyId);
    return res.json(ApiResponse.success(result, 'Vector share requests loaded'));
  };

  createVectorShareRequest = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const { companyId, requesterUserId, requesterChannelIdentityId, conversationKey, reason, expiresAt } = req.body ?? {};
    if (typeof requesterUserId !== 'string' || requesterUserId.trim().length === 0) {
      return res.status(400).json({ success: false, message: '`requesterUserId` is required' });
    }
    if (typeof conversationKey !== 'string' || conversationKey.trim().length === 0) {
      return res.status(400).json({ success: false, message: '`conversationKey` is required' });
    }
    const result = await this.service.createVectorShareRequest(session, {
      companyId: typeof companyId === 'string' ? companyId : undefined,
      requesterUserId: requesterUserId.trim(),
      requesterChannelIdentityId:
        typeof requesterChannelIdentityId === 'string' && requesterChannelIdentityId.trim().length > 0
          ? requesterChannelIdentityId.trim()
          : undefined,
      conversationKey: conversationKey.trim(),
      reason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : undefined,
      expiresAt: typeof expiresAt === 'string' && expiresAt.trim().length > 0 ? expiresAt.trim() : undefined,
    });
    return res.status(201).json(ApiResponse.success(result, 'Vector share request created'));
  };

  approveVectorShareRequest = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.approveVectorShareRequest(session, req.params.requestId, {
      companyId: typeof req.body?.companyId === 'string' ? req.body.companyId : undefined,
      decisionNote:
        typeof req.body?.decisionNote === 'string' && req.body.decisionNote.trim().length > 0
          ? req.body.decisionNote.trim()
          : undefined,
    });
    return res.json(ApiResponse.success(result, 'Vector share request approved'));
  };

  rejectVectorShareRequest = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.rejectVectorShareRequest(session, req.params.requestId, {
      companyId: typeof req.body?.companyId === 'string' ? req.body.companyId : undefined,
      decisionNote:
        typeof req.body?.decisionNote === 'string' && req.body.decisionNote.trim().length > 0
          ? req.body.decisionNote.trim()
          : undefined,
    });
    return res.json(ApiResponse.success(result, 'Vector share request rejected'));
  };

  revertVectorShareRequest = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.revertVectorShareRequest(session, req.params.requestId, {
      companyId: typeof req.body?.companyId === 'string' ? req.body.companyId : undefined,
      decisionNote:
        typeof req.body?.decisionNote === 'string' && req.body.decisionNote.trim().length > 0
          ? req.body.decisionNote.trim()
          : undefined,
    });
    return res.json(ApiResponse.success(result, 'Vector share request reverted'));
  };

  getToolPermissions = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getToolPermissions(session, companyId);
    return res.json(ApiResponse.success(result, 'Tool permissions loaded'));
  };

  getZohoRoleAccessMatrix = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getZohoRoleAccessMatrix(session, companyId);
    return res.json(ApiResponse.success(result, 'Zoho role access loaded'));
  };

  updateToolPermission = async (req: Request, res: Response) => {
    const { toolId, role } = req.params;
    const { enabled } = req.body;
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: '`enabled` must be a boolean' });
    }
    const result = await this.service.updateToolPermission(session, toolId, role as any, enabled, companyId);
    return res.json(ApiResponse.success(result, 'Tool permission updated'));
  };

  updateZohoRoleAccess = async (req: Request, res: Response) => {
    const { role } = req.params;
    const { companyScopedRead } = req.body;
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    if (typeof companyScopedRead !== 'boolean') {
      return res.status(400).json({ success: false, message: '`companyScopedRead` must be a boolean' });
    }
    const result = await this.service.updateZohoRoleAccess(session, role, companyScopedRead, companyId);
    return res.json(ApiResponse.success(result, 'Zoho role access updated'));
  };

  setLarkUserRole = async (req: Request, res: Response) => {
    const { identityId } = req.params;
    const { aiRole } = req.body;
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    if (typeof aiRole !== 'string' || aiRole.trim().length === 0) {
      return res.status(400).json({ success: false, message: '`aiRole` must be a non-empty role slug' });
    }
    const result = await this.service.setLarkUserRole(session, identityId, aiRole.trim(), companyId);
    return res.json(ApiResponse.success(result, 'Lark user AI role updated'));
  };

  resetLarkUserRole = async (req: Request, res: Response) => {
    const { identityId } = req.params;
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.resetLarkUserRole(session, identityId, companyId);
    return res.json(ApiResponse.success(result, 'Lark user AI role reset to synced value'));
  };

  listAiRoles = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.listAiRoles(session, companyId);
    return res.json(ApiResponse.success(result, 'AI roles loaded'));
  };

  createAiRole = async (req: Request, res: Response) => {
    const { slug, displayName } = req.body;
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    if (typeof slug !== 'string' || typeof displayName !== 'string') {
      return res.status(400).json({ success: false, message: '`slug` and `displayName` are required strings' });
    }
    const result = await this.service.createAiRole(session, slug, displayName, companyId);
    return res.status(201).json(ApiResponse.success(result, 'AI role created'));
  };

  updateAiRole = async (req: Request, res: Response) => {
    const { roleId } = req.params;
    const { displayName } = req.body;
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    if (typeof displayName !== 'string') {
      return res.status(400).json({ success: false, message: '`displayName` is required' });
    }
    const result = await this.service.updateAiRole(session, roleId, displayName, companyId);
    return res.json(ApiResponse.success(result, 'AI role updated'));
  };

  deleteAiRole = async (req: Request, res: Response) => {
    const { roleId } = req.params;
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.deleteAiRole(session, roleId, companyId);
    return res.json(ApiResponse.success(result, 'AI role deleted'));
  };
}

export const companyAdminController = new CompanyAdminController();
