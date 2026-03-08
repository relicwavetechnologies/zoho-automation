import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import config from '../config';
import { HttpException } from '../core/http-exception';
import { memberAuthService, MemberSessionDTO } from '../modules/member-auth/member-auth.service';

type MemberJwtPayload = {
  userId: string;
  sessionId: string;
  role: string;
  companyId: string;
  channel: string;
};

type MemberRequest = Request & {
  memberSession?: MemberSessionDTO;
};

type MemberMiddleware = (req: MemberRequest, res: Response, next: NextFunction) => Promise<void> | void;

const withErrorForwarding =
  (middleware: MemberMiddleware) =>
    (req: MemberRequest, res: Response, next: NextFunction): void => {
      Promise.resolve(middleware(req, res, next)).catch(next);
    };

const readBearerToken = (req: MemberRequest): string => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HttpException(401, 'Authorization header missing or invalid');
  }
  return authHeader.slice('Bearer '.length).trim();
};

export const requireMemberSession = () => {
  return withErrorForwarding(async (req: MemberRequest, _res: Response, next: NextFunction) => {
    const token = readBearerToken(req);

    let decoded: MemberJwtPayload;
    try {
      decoded = jwt.verify(token, config.JWT_SECRET) as MemberJwtPayload;
    } catch {
      throw new HttpException(401, 'Invalid or expired member token');
    }

    const session = await memberAuthService.resolveMemberSession(decoded.sessionId);
    if (!session) {
      throw new HttpException(401, 'Member session is invalid, expired, or revoked');
    }

    req.memberSession = session;
    return next();
  });
};
