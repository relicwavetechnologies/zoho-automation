import { Request, Response } from 'express';
import { z } from 'zod';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { MemberSessionDTO } from '../member-auth/member-auth.service';
import { desktopAuthService } from './desktop-auth.service';
import { memberAuthService } from '../member-auth/member-auth.service';
import { departmentService } from '../../company/departments/department.service';

const exchangeSchema = z.object({
  code: z.string().min(1),
});

const larkExchangeSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

class DesktopAuthController extends BaseController {
  getLarkAuthorizeUrl = async (_req: Request, res: Response) => {
    const result = await desktopAuthService.createLarkAuthorizeUrl();
    return res.json(ApiResponse.success(result, 'Desktop Lark authorize URL generated'));
  };

  larkCallback = async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(desktopAuthService.renderLarkCallbackHtml({ code, state, error }));
  };

  exchangeLark = async (req: Request, res: Response) => {
    const payload = larkExchangeSchema.parse(req.body);
    const result = await desktopAuthService.exchangeLarkAuthorizationCode(payload);
    return res.json(ApiResponse.success(result, 'Desktop Lark session issued'));
  };

  getGoogleAuthorizeUrl = async (req: Request, res: Response) => {
    const session = (req as MemberRequest).memberSession;
    if (!session) {
      return res.status(401).json({ success: false, message: 'Member session required' });
    }
    const result = await desktopAuthService.createGoogleAuthorizeUrl(session);
    return res.json(ApiResponse.success(result, 'Desktop Google authorize URL generated'));
  };

  googleCallback = async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (!code || !state || error) {
      return res.status(200).send(desktopAuthService.renderGoogleCallbackHtml({
        success: false,
        message: error || 'Google authorization did not complete.',
      }));
    }

    try {
      await desktopAuthService.exchangeGoogleAuthorizationCode({ code, state });
      return res.status(200).send(desktopAuthService.renderGoogleCallbackHtml({
        success: true,
        message: 'Your Google account is now connected.',
      }));
    } catch (err) {
      return res.status(200).send(desktopAuthService.renderGoogleCallbackHtml({
        success: false,
        message: (err as Error).message || 'Google authorization failed.',
      }));
    }
  };

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

  googleStatus = async (req: Request, res: Response) => {
    const session = (req as MemberRequest).memberSession;
    if (!session) {
      return res.status(401).json({ success: false, message: 'Member session required' });
    }
    const result = await desktopAuthService.getGoogleStatus(session);
    return res.json(ApiResponse.success(result, 'Desktop Google connection status resolved'));
  };

  departments = async (req: Request, res: Response) => {
    const session = (req as MemberRequest).memberSession;
    if (!session) {
      return res.status(401).json({ success: false, message: 'Member session required' });
    }
    const departments = await departmentService.listUserDepartments(session.userId, session.companyId);
    return res.json(ApiResponse.success(departments, 'Desktop departments listed'));
  };

  /** Desktop: logout. */
  logout = async (req: Request, res: Response) => {
    const session = (req as MemberRequest).memberSession;
    if (session?.sessionId) {
      await memberAuthService.logout(session.sessionId);
    }
    return res.json(ApiResponse.success({ loggedOut: true }, 'Desktop session revoked'));
  };

  unlinkLark = async (req: Request, res: Response) => {
    const session = (req as MemberRequest).memberSession;
    if (!session) {
      return res.status(401).json({ success: false, message: 'Member session required' });
    }
    const result = await desktopAuthService.unlinkLark(session);
    return res.json(ApiResponse.success(result, 'Desktop Lark link revoked'));
  };

  unlinkGoogle = async (req: Request, res: Response) => {
    const session = (req as MemberRequest).memberSession;
    if (!session) {
      return res.status(401).json({ success: false, message: 'Member session required' });
    }
    const result = await desktopAuthService.unlinkGoogle(session);
    return res.json(ApiResponse.success(result, 'Desktop Google link revoked'));
  };
}

export const desktopAuthController = new DesktopAuthController();
