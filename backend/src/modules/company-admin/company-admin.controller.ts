import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
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
}

export const companyAdminController = new CompanyAdminController();
