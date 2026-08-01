/**
 * Admin auth middleware. Guards every /api/admin/* router and /api/executions.
 *
 * Three auth modes (tried in order):
 *   1. x-api-key or Authorization: Bearer <INTERNAL_API_KEY>
 *      → grants SUPER_ADMIN access; companyId must be in x-company-id header
 *   2. Authorization: Bearer <JWT signed with ADMIN_JWT_SECRET>
 *      → verifies HS256 JWT, looks up AdminSession in DB, populates res.locals
 *   3. Authorization: Bearer <JWT signed with MEMBER_JWT_SECRET>
 *      → the single session the web app signs in with. Admitted only when the
 *        person's LIVE AdminMembership is COMPANY_ADMIN or SUPER_ADMIN.
 *
 * Mode 3 exists because sign-in is now one act producing one session, and the
 * console needs both halves of the API. It deliberately grants nothing that
 * mode 2 did not: authority is read from the live membership row on every
 * request, never from the token, and a Pi runtime lease is refused outright
 * rather than merely scoped — member-auth admits leases on two read-only routes
 * by exception, and that exception must not become reachable from here.
 *
 * On success sets:
 *   res.locals.companyId    (string — required for company-scoped routes)
 *   res.locals.isSuperAdmin (boolean)
 *   res.locals.canViewRawExecutionData (boolean — company and super admins)
 *   res.locals.userId       (string | null)
 *   res.locals.adminRole    (current database-backed admin role)
 */

import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

const ADMIN_ROLES = new Set(['COMPANY_ADMIN', 'SUPER_ADMIN']);

export interface AdminAuthMiddlewareDeps {
  prisma:          PrismaClient;
  jwtSecret:       string;
  /** Omit to refuse member tokens entirely — used where only mode 1/2 apply. */
  memberJwtSecret?: string;
  internalApiKey?: string;
  logger:          Logger;
}

interface MemberJwtPayload {
  sessionId?: string;
  userId?:    string;
  companyId?: string;
  exp?:       number;
  /* Runtime-lease markers. Any of these present means a container holds it. */
  aud?:        string;
  instanceId?: string;
  threadId?:   string;
  channel?:    string;
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
  const { prisma, jwtSecret, memberJwtSecret, internalApiKey, logger } = deps;
  const log = logger.child({ middleware: 'admin-auth' });

  /**
   * Mode 3. Three outcomes, kept distinct on purpose — collapsing "refused" into
   * "authorised" would pass a rejected token through to the route with empty
   * locals, which is the worst possible failure for this middleware.
   *
   *   'authorised'  res.locals is populated; continue.
   *   'refused'     the caller has been answered; stop.
   *   'not-member'  not a member token at all; fall through to the admin path.
   */
  type MemberOutcome = 'authorised' | 'refused' | 'not-member';

  const admitMemberToken = async (token: string, res: Response): Promise<MemberOutcome> => {
    if (!memberJwtSecret) return 'not-member';

    const claims = verifyHs256Jwt(token, memberJwtSecret) as MemberJwtPayload | null;
    if (!claims?.sessionId || !claims.userId) return 'not-member';

    // A Pi runtime lease is signed with the same secret and would otherwise
    // verify here. It is held by a container running a member's agent, and no
    // agent gets the admin API — refused outright rather than scoped, so there
    // is no per-route exception anyone can widen later.
    if (claims.aud !== undefined
      || claims.instanceId !== undefined
      || claims.threadId !== undefined
      || claims.channel === 'lark') {
      log.warn('admin-auth.runtime_lease_refused', { userId: claims.userId });
      res.status(403).json({ error: 'forbidden', message: 'Runtime leases cannot access the admin API' });
      return 'refused';
    }

    const session = await prisma.memberSession.findUnique({
      where:  { sessionId: claims.sessionId },
      select: { userId: true, companyId: true, expiresAt: true, revokedAt: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      res.status(401).json({ error: 'unauthorized', message: 'Session expired or revoked' });
      return 'refused';
    }
    if (session.userId !== claims.userId || session.companyId !== claims.companyId) {
      res.status(401).json({ error: 'unauthorized', message: 'Session identity mismatch' });
      return 'refused';
    }

    // Authority comes from the live membership row, never from the token, so a
    // demotion takes effect on the next request rather than at next sign-in.
    const membership = await prisma.adminMembership.findFirst({
      where:   { userId: session.userId, companyId: session.companyId, isActive: true },
      orderBy: { updatedAt: 'desc' },
      select:  { role: true },
    });
    if (!membership || !ADMIN_ROLES.has(membership.role)) {
      res.status(403).json({ error: 'forbidden', message: 'Admin access required' });
      return 'refused';
    }

    res.locals['companyId']    = session.companyId;
    res.locals['isSuperAdmin'] = membership.role === 'SUPER_ADMIN';
    res.locals['canViewRawExecutionData'] = true;
    res.locals['userId']       = session.userId;
    return 'authorised';
  };

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
      res.locals['adminRole']    = 'SUPER_ADMIN';
      return next();
    }

    // ── 3. JWT + AdminSession ─────────────────────────────────────────────────
    if (!bearerToken) {
      res.status(401).json({ error: 'unauthorized', message: 'Authorization header required' });
      return;
    }

    const payload = verifyHs256Jwt(bearerToken, jwtSecret);

    // ── 4. Member session (the web app's single sign-in) ─────────────────────
    // Reached when the token is not an admin JWT at all. Also reached when the
    // two secrets are configured identically, in which case a member token
    // verifies above but matches no AdminSession — handled below.
    try {
      if (!payload || !payload.sessionId) {
        const outcome = await admitMemberToken(bearerToken, res);
        if (outcome === 'authorised') return next();
        if (outcome === 'refused') return;
      }
    } catch (e) {
      log.error('admin-auth.member_session_lookup_failed', { error: String(e) });
      res.status(500).json({ error: 'internal_error' });
      return;
    }

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

      // No AdminSession under this id. With distinct secrets that is simply an
      // expired session; with colliding secrets it is a member token that
      // verified above, so give the member path its chance before refusing.
      if (!session) {
        const outcome = await admitMemberToken(bearerToken, res);
        if (outcome === 'authorised') return next();
        if (outcome === 'refused') return;
      }

      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        res.status(401).json({ error: 'unauthorized', message: 'Session expired or revoked' });
        return;
      }

      const membership = await prisma.adminMembership.findFirst({
        where: {
          userId: session.userId,
          role: session.role,
          isActive: true,
          ...(session.companyId ? { companyId: session.companyId } : {}),
        },
        select: { id: true },
      });
      if (!membership) {
        res.status(403).json({ error: 'forbidden', message: 'Admin membership is no longer active' });
        return;
      }

      res.locals['companyId']    = session.companyId ?? '';
      res.locals['isSuperAdmin'] = session.role === 'SUPER_ADMIN';
      res.locals['canViewRawExecutionData'] =
        session.role === 'SUPER_ADMIN' || session.role === 'COMPANY_ADMIN';
      res.locals['userId']       = session.userId;
      res.locals['adminRole']    = session.role;
    } catch (e) {
      log.error('admin-auth.session_lookup_failed', { error: String(e) });
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    next();
  };
}
