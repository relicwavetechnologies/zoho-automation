import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import {
  connectOnboardingSchema,
  disconnectOnboardingSchema,
  larkSyncQuerySchema,
  triggerHistoricalSyncSchema,
  zohoAuthorizeUrlQuerySchema,
  upsertLarkBindingSchema,
  upsertLarkWorkspaceConfigSchema,
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

  getZohoOAuthConfigStatus = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getZohoOAuthConfigStatus(session, companyId);
    return res.json(ApiResponse.success(result, 'Zoho OAuth config status loaded'));
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

  getToolPermissions = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = await this.service.getToolPermissions(session, companyId);
    return res.json(ApiResponse.success(result, 'Tool permissions loaded'));
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
