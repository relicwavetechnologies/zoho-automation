/**
 * Member session auth middleware.
 * Verifies HS256 JWT signed with MEMBER_JWT_SECRET, looks up MemberSession and
 * the current active company membership in DB.
 *
 * On success sets:
 *   res.locals.companyId  (string)
 *   res.locals.userId     (string)
 *   res.locals.aiRole     (string — e.g. "MEMBER", "COMPANY_ADMIN")
 *   res.locals.isAdmin    (boolean)
 *   res.locals.larkOpenId (string | null)
 *   res.locals.sessionId  (string)
 *   res.locals.email      (string | null)
 */

import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

export interface MemberAuthMiddlewareDeps {
  prisma:     PrismaClient;
  jwtSecret:  string;
  logger:     Logger;
}

interface MemberJwtPayload {
  sessionId: string;
  userId:    string;
  companyId: string;
  role?:     string;
  exp?:      number;
}

function verifyHs256Jwt(token: string, secret: string): MemberJwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  try {
    if (!timingSafeEqual(Buffer.from(sigB64, 'base64url'), Buffer.from(expectedSig, 'base64url'))) {
      return null;
    }
  } catch {
    return null;
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as MemberJwtPayload;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

export function createMemberAuthMiddleware(deps: MemberAuthMiddlewareDeps) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token) {
      res.status(401).json({ error: 'Missing authorization token' });
      return;
    }

    const payload = verifyHs256Jwt(token, deps.jwtSecret);
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    try {
      const session = await deps.prisma.memberSession.findUnique({
        where: { sessionId: payload.sessionId },
        include: { user: { select: { email: true } } },
      });

      if (!session || session.revokedAt || new Date() > session.expiresAt) {
        res.status(401).json({ error: 'Session expired or revoked' });
        return;
      }

      // MemberSession.role and the JWT role are issuance-time metadata only.
      // Resolve the live membership on every request so a role downgrade or
      // membership removal takes effect before any desktop or gateway handler.
      const membership = await deps.prisma.adminMembership.findFirst({
        where: {
          userId:    session.userId,
          companyId: session.companyId,
          isActive:  true,
        },
        orderBy: { updatedAt: 'desc' },
        select: { role: true },
      });

      if (!membership) {
        res.status(401).json({ error: 'Company membership is no longer active' });
        return;
      }

      res.locals['companyId']  = session.companyId;
      res.locals['userId']     = session.userId;
      res.locals['aiRole']     = membership.role;
      res.locals['isAdmin']    = membership.role === 'COMPANY_ADMIN' || membership.role === 'SUPER_ADMIN';
      res.locals['larkOpenId'] = session.larkOpenId ?? null;
      res.locals['sessionId']  = session.sessionId;
      res.locals['email']      = session.user?.email ?? null;
      next();
    } catch (e) {
      deps.logger.error('member-auth.middleware.error', { error: String(e) });
      res.status(500).json({ error: 'Authentication failed' });
    }
  };
}
