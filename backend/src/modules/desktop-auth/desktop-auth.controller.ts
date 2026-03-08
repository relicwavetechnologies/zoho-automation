import { Request, Response } from 'express';
import { z } from 'zod';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { MemberSessionDTO } from '../member-auth/member-auth.service';
import { desktopAuthService } from './desktop-auth.service';
import { memberAuthService } from '../member-auth/member-auth.service';

const exchangeSchema = z.object({
  code: z.string().min(1),
});

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

class DesktopAuthController extends BaseController {
  /** Called by web app after member login to generate a handoff code. */
  generateHandoff = async (req: Request, res: Response) => {
    const session = (req as MemberRequest).memberSession;
    if (!session) {
      return res.status(401).json({ success: false, message: 'Member session required' });
    }

    const result = await desktopAuthService.createHandoff(
      session.userId,
      session.companyId,
      session.role,
    );

    return res.status(201).json(ApiResponse.success(result, 'Desktop handoff code generated'));
  };

  /** Called by desktop app to exchange a handoff code for a session. */
  exchange = async (req: Request, res: Response) => {
    const { code } = exchangeSchema.parse(req.body);
    const result = await desktopAuthService.exchangeHandoff(code);
    return res.json(ApiResponse.success(result, 'Desktop session issued'));
  };

  /** Desktop: validate current session. */
  me = async (req: Request, res: Response) => {
    const session = (req as MemberRequest).memberSession;
    return res.json(ApiResponse.success(session, 'Desktop session resolved'));
  };

  /** Desktop: logout. */
  logout = async (req: Request, res: Response) => {
    const session = (req as MemberRequest).memberSession;
    if (session?.sessionId) {
      await memberAuthService.logout(session.sessionId);
    }
    return res.json(ApiResponse.success({ loggedOut: true }, 'Desktop session revoked'));
  };
}

export const desktopAuthController = new DesktopAuthController();
