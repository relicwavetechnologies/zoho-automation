/**
 * Admin auth middleware for internal observability routes (/api/executions).
 *
 * Two auth modes (tried in order):
 *   1. x-api-key or Authorization: Bearer <INTERNAL_API_KEY>
 *      → grants SUPER_ADMIN access; companyId must be in x-company-id header
 *   2. Authorization: Bearer <JWT signed with ADMIN_JWT_SECRET>
 *      → verifies HS256 JWT, looks up AdminSession in DB, populates res.locals
 *
 * On success sets:
 *   res.locals.companyId    (string — required for company-scoped routes)
 *   res.locals.isSuperAdmin (boolean)
 *   res.locals.canViewRawExecutionData (boolean — company and super admins)
 *   res.locals.userId       (string | null)
 */

import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

export interface AdminAuthMiddlewareDeps {
  prisma:          PrismaClient;
  jwtSecret:       string;
  internalApiKey?: string;
  logger:          Logger;
}

interface AdminJwtPayload {
  userId:    string;
  sessionId: string;
  role:      string;
  companyId?: string;
  exp?: number;
}

function verifyHs256Jwt(token: string, secret: string): AdminJwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const signingInput = `${headerB64}.${payloadB64}`;

  const expectedSig = createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');

  try {
    if (!timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sigB64))) return null;
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as AdminJwtPayload;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function createAdminAuthMiddleware(deps: AdminAuthMiddlewareDeps) {
  const { prisma, jwtSecret, internalApiKey, logger } = deps;
  const log = logger.child({ middleware: 'admin-auth' });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // ── 1. Extract token ──────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

    let bearerToken: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      bearerToken = authHeader.slice(7).trim();
    }
    const rawKey = apiKeyHeader ?? bearerToken;

    // ── 2. Internal API key (machine-to-machine) ─────────────────────────────
    if (internalApiKey && rawKey === internalApiKey) {
      const companyId = req.headers['x-company-id'] as string | undefined;
      res.locals['companyId']    = companyId ?? '';
      res.locals['isSuperAdmin'] = true;
      res.locals['canViewRawExecutionData'] = true;
      res.locals['userId']       = null;
      return next();
    }

    // ── 3. JWT + AdminSession ─────────────────────────────────────────────────
    if (!bearerToken) {
      res.status(401).json({ error: 'unauthorized', message: 'Authorization header required' });
      return;
    }

    const payload = verifyHs256Jwt(bearerToken, jwtSecret);
    if (!payload) {
      res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
      return;
    }

    if (!payload.sessionId) {
      res.status(401).json({ error: 'unauthorized', message: 'Token missing sessionId' });
      return;
    }

    // DB lookup
    try {
      const session = await prisma.adminSession.findUnique({
        where: { sessionId: payload.sessionId },
        select: { companyId: true, role: true, userId: true, expiresAt: true, revokedAt: true },
      });

      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        res.status(401).json({ error: 'unauthorized', message: 'Session expired or revoked' });
        return;
      }

      res.locals['companyId']    = session.companyId ?? '';
      res.locals['isSuperAdmin'] = session.role === 'SUPER_ADMIN';
      res.locals['canViewRawExecutionData'] =
        session.role === 'SUPER_ADMIN' || session.role === 'COMPANY_ADMIN';
      res.locals['userId']       = session.userId;
    } catch (e) {
      log.error('admin-auth.session_lookup_failed', { error: String(e) });
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    next();
  };
}
