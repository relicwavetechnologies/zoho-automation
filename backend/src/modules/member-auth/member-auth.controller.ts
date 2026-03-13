import { Request, Response } from 'express';
import { z } from 'zod';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { memberAuthService } from './member-auth.service';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  companyId: z.string().uuid().optional(),
});

class MemberAuthController extends BaseController {
  login = async (req: Request, res: Response) => {
    const { email, password, companyId } = loginSchema.parse(req.body);
    const result = await memberAuthService.loginMember(email, password, companyId);
    return res.json(ApiResponse.success(result, 'Member login successful'));
  };

  me = async (req: Request, res: Response) => {
    const session = (req as Request & { memberSession?: unknown }).memberSession;
    return res.json(ApiResponse.success(session, 'Member session resolved'));
  };

  logout = async (req: Request, res: Response) => {
    const session = (req as Request & { memberSession?: { sessionId: string } }).memberSession;
    if (session?.sessionId) {
      await memberAuthService.logout(session.sessionId);
    }
    return res.json(ApiResponse.success({ loggedOut: true }, 'Member session revoked'));
  };

  usage = async (req: Request, res: Response) => {
    const session = (req as Request & { memberSession?: { userId: string, companyId: string } }).memberSession;
    if (!session?.userId || !session?.companyId) {
      return res.status(401).json(ApiResponse.error('Session not found'));
    }
    const usageInfo = await memberAuthService.getUsageInfo(session.userId, session.companyId);
    return res.json(ApiResponse.success(usageInfo, 'Token usage retrieved'));
  };
}

export const memberAuthController = new MemberAuthController();
