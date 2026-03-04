import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { auditService } from '../audit/audit.service';
import {
  AdminAuthService,
  adminAuthService,
} from './admin-auth.service';
import { bootstrapSuperAdminSchema } from './dto/bootstrap-super-admin.dto';
import { grantCompanyAdminSchema } from './dto/grant-company-admin.dto';
import { loginCompanyAdminSchema } from './dto/login-company-admin.dto';
import { loginSuperAdminSchema } from './dto/login-super-admin.dto';

class AdminAuthController extends BaseController {
  constructor(private readonly service: AdminAuthService = adminAuthService) {
    super();
  }

  private readSession = (req: Request) =>
    (req as Request & {
      adminSession?: {
        userId: string;
        sessionId: string;
        role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
        companyId?: string;
        expiresAt: string;
      };
    }).adminSession;

  bootstrapSuperAdmin = async (req: Request, res: Response) => {
    const payload = bootstrapSuperAdminSchema.parse(req.body);
    const result = await this.service.bootstrapSuperAdmin(payload);
    await auditService.recordLog({
      actorId: 'bootstrap',
      action: 'admin.auth.bootstrap_super_admin',
      outcome: 'success',
      metadata: { email: payload.email },
    });
    return res.status(201).json(ApiResponse.success(result, 'Super-admin bootstrap completed'));
  };

  loginSuperAdmin = async (req: Request, res: Response) => {
    const payload = loginSuperAdminSchema.parse(req.body);
    const result = await this.service.loginSuperAdmin(payload);
    await auditService.recordLog({
      actorId: result.session.userId,
      action: 'admin.auth.login_super_admin',
      outcome: 'success',
    });
    return res.json(ApiResponse.success(result, 'Super-admin login successful'));
  };

  loginCompanyAdmin = async (req: Request, res: Response) => {
    const payload = loginCompanyAdminSchema.parse(req.body);
    const result = await this.service.loginCompanyAdmin(payload);
    await auditService.recordLog({
      actorId: result.session.userId,
      companyId: result.session.companyId,
      action: 'admin.auth.login_company_admin',
      outcome: 'success',
    });
    return res.json(ApiResponse.success(result, 'Company-admin login successful'));
  };

  grantCompanyAdminMembership = async (req: Request, res: Response) => {
    const payload = grantCompanyAdminSchema.parse(req.body);
    const result = await this.service.grantCompanyAdminMembership(payload);
    const actor = this.readSession(req)?.userId ?? 'unknown';
    await auditService.recordLog({
      actorId: actor,
      companyId: payload.companyId,
      action: 'admin.auth.grant_company_admin',
      outcome: 'success',
      metadata: { userId: payload.userId },
    });
    return res.status(201).json(ApiResponse.success(result, 'Company-admin membership granted'));
  };

  me = async (req: Request, res: Response) =>
    res.json(ApiResponse.success(this.readSession(req), 'Admin session resolved'));

  capabilities = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }
    const result = this.service.getCapabilities(session);
    return res.json(ApiResponse.success(result, 'Admin capabilities resolved'));
  };

  logout = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (session?.sessionId) {
      await this.service.logout(session.sessionId);
      await auditService.recordLog({
        actorId: session.userId,
        companyId: session.companyId,
        action: 'admin.auth.logout',
        outcome: 'success',
      });
    }

    return res.json(ApiResponse.success({ loggedOut: true }, 'Admin session revoked'));
  };
}

export const adminAuthController = new AdminAuthController();
