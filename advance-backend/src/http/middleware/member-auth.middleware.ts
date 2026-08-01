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
 *   res.locals.larkTenantKey (string | null)
 *   res.locals.sessionId  (string)
 *   res.locals.authProvider (string — how the session was issued;
 *                            "scheduled_workflow" marks a machine-issued run)
 *   res.locals.email      (string | null)
 *   res.locals.channel    ("desktop" | "lark", trusted from the signed token)
 *   res.locals.runtimeContextAudience ("private" | "shared" for Pi leases)
 */

import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import {
  isPiRuntimeLeaseClaims,
  PI_RUNTIME_AUDIENCE,
} from '../../application/runtime/pi-runtime-lease';

export interface MemberAuthMiddlewareDeps {
  prisma:     PrismaClient;
  jwtSecret:  string;
  logger:     Logger;
  allowPiRuntimeLease?: (req: Request) => boolean;
}

interface MemberJwtPayload {
  sessionId: string;
  userId:    string;
  companyId: string;
  role?:     string;
  exp?:      number;
  aud?:      string;
  channel?:  string;
  instanceId?: string;
  threadId?: string;
  runId?: string;
  chatId?: string;
  contextAudience?: 'private' | 'shared';
  departmentId?: string;
  iat?:      number;
  jti?:      string;
}

const AUTH_DB_RETRY_DELAYS_MS = [50, 150, 300] as const;

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

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as MemberJwtPayload;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
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

    const hasRuntimeClaims = payload.aud !== undefined
      || payload.instanceId !== undefined
      || payload.threadId !== undefined
      || payload.channel === 'lark';
    if (hasRuntimeClaims && !isPiRuntimeLeaseClaims(payload as unknown as Record<string, unknown>)) {
      res.status(401).json({ error: 'Invalid Pi runtime lease' });
      return;
    }
    if (hasRuntimeClaims && !deps.allowPiRuntimeLease?.(req)) {
      res.status(403).json({ error: 'Pi runtime lease is not allowed for this route' });
      return;
    }

    let auth;
    for (let attempt = 0; attempt <= AUTH_DB_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const session = await deps.prisma.memberSession.findUnique({
          where: { sessionId: payload.sessionId },
          include: { user: { select: { email: true } } },
        });

        if (!session || session.revokedAt || new Date() > session.expiresAt) {
          res.status(401).json({ error: 'Session expired or revoked' });
          return;
        }
        if (
          session.userId !== payload.userId
          || session.companyId !== payload.companyId
        ) {
          res.status(401).json({ error: 'Session identity mismatch' });
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
        auth = { session, membership };
        break;
      } catch (error) {
        if (attempt === AUTH_DB_RETRY_DELAYS_MS.length) {
          deps.logger.error('member-auth.middleware.unavailable', {
            attempts: attempt + 1,
            error: String(error),
          });
          res.status(503).json({ error: 'Authentication service temporarily unavailable. Please retry.' });
          return;
        }
        deps.logger.warn('member-auth.middleware.retry', {
          attempt: attempt + 1,
          error: String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, AUTH_DB_RETRY_DELAYS_MS[attempt]));
      }
    }

    try {
      if (!auth) return;
      const { session, membership } = auth;
      res.locals['companyId']  = session.companyId;
      res.locals['userId']     = session.userId;
      res.locals['aiRole']     = membership.role;
      res.locals['isAdmin']    = membership.role === 'COMPANY_ADMIN' || membership.role === 'SUPER_ADMIN';
      res.locals['larkOpenId'] = session.larkOpenId ?? null;
      res.locals['larkTenantKey'] = session.larkTenantKey ?? null;
      res.locals['sessionId']  = session.sessionId;
      // How this session was issued. A scheduled run holds a machine-issued one,
      // and tools that would deliver a reply themselves have to know that: the
      // runtime owns delivery for those runs and sends it to the creator alone.
      res.locals['authProvider'] = session.authProvider;
      res.locals['email']      = session.user?.email ?? null;
      res.locals['channel']    = hasRuntimeClaims ? 'lark' : 'desktop';
      res.locals['isPiRuntimeLease'] = hasRuntimeClaims;
      if (payload.aud === PI_RUNTIME_AUDIENCE) {
        res.locals['runtimeInstanceId'] = payload.instanceId;
        res.locals['runtimeThreadId'] = payload.threadId;
        res.locals['runtimeRunId'] = payload.runId;
        res.locals['runtimeChatId'] = payload.chatId;
        res.locals['runtimeContextAudience'] = payload.contextAudience;
        res.locals['runtimeDepartmentId'] = payload.departmentId ?? null;
      }
      next();
    } catch (e) {
      deps.logger.error('member-auth.middleware.error', { error: String(e) });
      res.status(500).json({ error: 'Authentication failed' });
    }
  };
}
