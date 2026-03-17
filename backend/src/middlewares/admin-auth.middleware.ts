import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import config from '../config';
import { HttpException } from '../core/http-exception';
import { adminAuthService } from '../modules/admin-auth/admin-auth.service';
import type { RbacAction } from '../modules/rbac/rbac.constants';
import { rbacService } from '../modules/rbac/rbac.service';

type AdminRole = 'SUPER_ADMIN' | 'COMPANY_ADMIN' | 'DEPARTMENT_MANAGER';

type AdminJwtPayload = {
  userId: string;
  sessionId: string;
  role: AdminRole;
  companyId?: string;
};

type AdminRequest = Request & {
  adminSession?: {
    userId: string;
    sessionId: string;
    role: AdminRole;
    companyId?: string;
    expiresAt: string;
  };
};

type AdminMiddleware = (req: AdminRequest, res: Response, next: NextFunction) => Promise<void> | void;

const withErrorForwarding =
  (middleware: AdminMiddleware) =>
    (req: AdminRequest, res: Response, next: NextFunction): void => {
      Promise.resolve(middleware(req, res, next)).catch(next);
    };

const readBearerToken = (req: AdminRequest): string => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HttpException(401, 'Authorization header missing or invalid');
  }

  return authHeader.slice('Bearer '.length).trim();
};

export const requireAdminSession = () => {
  return withErrorForwarding(async (req: AdminRequest, _res: Response, next: NextFunction) => {
    const token = readBearerToken(req);

    let decoded: AdminJwtPayload;
    try {
      decoded = jwt.verify(token, config.ADMIN_JWT_SECRET) as AdminJwtPayload;
    } catch {
      throw new HttpException(401, 'Invalid or expired admin token');
    }

    const session = await adminAuthService.resolveAdminSession(decoded.sessionId);
    if (!session) {
      throw new HttpException(401, 'Admin session is invalid, expired, or revoked');
    }

    req.adminSession = session;
    return next();
  });
};

export const requireAdminRole = (...roles: AdminRole[]) => {
  return withErrorForwarding((req: AdminRequest, _res: Response, next: NextFunction) => {
    const role = req.adminSession?.role;
    if (!role || !roles.includes(role)) {
      throw new HttpException(403, 'Insufficient admin role for this route');
    }

    return next();
  });
};

export const requireCompanyScope = () => {
  return withErrorForwarding((req: AdminRequest, _res: Response, next: NextFunction) => {
    const requestedCompanyId = req.params.companyId;
    const session = req.adminSession;

    if (!session) {
      throw new HttpException(401, 'Admin session required');
    }

    if (!requestedCompanyId) {
      throw new HttpException(400, 'companyId route parameter is required');
    }

    if (session.role === 'SUPER_ADMIN') {
      return next();
    }

    if (session.role === 'COMPANY_ADMIN' && session.companyId === requestedCompanyId) {
      return next();
    }

    throw new HttpException(403, 'Company scope mismatch for company-admin session');
  });
};

export const requireRbacAction = (actionId: RbacAction) => {
  return withErrorForwarding(async (req: AdminRequest, _res: Response, next: NextFunction) => {
    const session = req.adminSession;
    if (!session) {
      throw new HttpException(401, 'Admin session required');
    }

    const allowed = await rbacService.canRolePerformAction(session.role, actionId);
    if (!allowed) {
      throw new HttpException(403, `RBAC policy denied action: ${actionId}`);
    }

    return next();
  });
};
