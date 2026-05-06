import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma';
import type { PrismaClient } from '../../generated/prisma';
import type { TypedEnv } from '../../config/env';
import type { AuditService } from '../../application/observability/audit.service';
import type { Logger } from '../../shared/logger';

type AdminRole = 'SUPER_ADMIN' | 'COMPANY_ADMIN' | 'DEPARTMENT_MANAGER';

type AdminSessionDto = {
  userId: string;
  companyId?: string;
  role: AdminRole;
  sessionId: string;
  expiresAt: string;
};

type AdminJwtPayload = {
  userId: string;
  sessionId: string;
  role: AdminRole;
  companyId?: string;
  exp: number;
};

type RouteError = Error & { status: number };

const require = createRequire(__filename);
const bcrypt = require('bcryptjs') as {
  hash(input: string, rounds: number): Promise<string>;
  compare(input: string, hashed: string): Promise<boolean>;
};

const ADMIN_SESSION_TTL_MINUTES = 480;

const bootstrapSuperAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2).max(120).optional(),
});

const loginSuperAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const loginCompanyAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  companyId: z.string().uuid().optional(),
});

const signupCompanyAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2).max(120).optional(),
  companyName: z.string().min(2).max(160),
});

const signupMemberInviteSchema = z.object({
  inviteToken: z.string().uuid(),
  password: z.string().min(8),
  name: z.string().min(2).max(120).optional(),
});

const grantCompanyAdminSchema = z.object({
  userId: z.string().uuid(),
  companyId: z.string().uuid(),
});

const success = <T>(res: Response, data: T, message?: string, status = 200) =>
  res.status(status).json({
    success: true,
    data,
    ...(message ? { message } : {}),
  });

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({
    success: false,
    message,
  });

const routeError = (status: number, message: string): RouteError => {
  const error = new Error(message) as RouteError;
  error.status = status;
  return error;
};

const asyncRoute = (
  handler: (req: Request, res: Response) => Promise<void>,
) => async (req: Request, res: Response): Promise<void> => {
  try {
    await handler(req, res);
  } catch (error) {
    if (error instanceof z.ZodError) {
      fail(res, 400, error.issues[0]?.message ?? 'Invalid request');
      return;
    }

    if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
      fail(res, error.status, error.message);
      return;
    }

    throw error;
  }
};

const base64Url = (value: string) => Buffer.from(value).toString('base64url');

const signAdminJwt = (payload: AdminJwtPayload, secret: string): string => {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
};

const verifyAdminJwt = (token: string, secret: string): AdminJwtPayload | null => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const expected = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signatureB64))) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as AdminJwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};

const readBearerToken = (req: Request): string => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw routeError(401, 'Authorization header missing or invalid');
  }
  return authHeader.slice('Bearer '.length).trim();
};

const buildSessionDto = (session: {
  userId: string;
  companyId: string | null;
  role: string;
  sessionId: string;
  expiresAt: Date;
}): AdminSessionDto => ({
  userId: session.userId,
  ...(session.companyId ? { companyId: session.companyId } : {}),
  role: session.role as AdminRole,
  sessionId: session.sessionId,
  expiresAt: session.expiresAt.toISOString(),
});

const getCapabilities = (role: AdminRole) => {
  const allItems: Array<{ id: string; label: string; path: string; roles: AdminRole[] }> = [
    { id: 'home', label: 'Home', path: '/home', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'] },
    { id: 'workspaces', label: 'Workspaces', path: '/workspaces', roles: ['SUPER_ADMIN'] },
    { id: 'people', label: 'People', path: '/people', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'] },
    { id: 'departments', label: 'Departments', path: '/departments', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'] },
    { id: 'ai-ops', label: 'AI Ops', path: '/ai-ops', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'] },
    { id: 'settings', label: 'Settings', path: '/settings', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'] },
  ];

  return {
    navItems: allItems.filter(item => item.roles.includes(role)),
  };
};

const issueSession = async (input: {
  prisma: PrismaClient;
  env: TypedEnv;
  userId: string;
  role: AdminRole;
  companyId?: string;
}) => {
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MINUTES * 60 * 1000);
  const session = await input.prisma.adminSession.create({
    data: {
      userId: input.userId,
      role: input.role,
      ...(input.companyId ? { companyId: input.companyId } : {}),
      expiresAt,
    },
  });

  const payload: AdminJwtPayload = {
    userId: session.userId,
    sessionId: session.sessionId,
    role: session.role as AdminRole,
    ...(session.companyId ? { companyId: session.companyId } : {}),
    exp: Math.floor(expiresAt.getTime() / 1000),
  };

  return {
    token: signAdminJwt(payload, input.env.ADMIN_JWT_SECRET),
    session: buildSessionDto(session),
  };
};

const resolveAdminSession = async (
  prisma: PrismaClient,
  env: TypedEnv,
  req: Request,
): Promise<AdminSessionDto> => {
  const token = readBearerToken(req);
  const payload = verifyAdminJwt(token, env.ADMIN_JWT_SECRET);
  if (!payload?.sessionId) {
    throw routeError(401, 'Invalid or expired admin token');
  }

  const session = await prisma.adminSession.findUnique({
    where: { sessionId: payload.sessionId },
    select: {
      userId: true,
      companyId: true,
      role: true,
      sessionId: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    throw routeError(401, 'Admin session is invalid, expired, or revoked');
  }

  return buildSessionDto(session);
};

export interface AdminAuthRouteDeps {
  prisma: PrismaClient;
  env: TypedEnv;
  auditService: AuditService;
  logger: Logger;
}

export const createAdminAuthRoutes = (deps: AdminAuthRouteDeps): Router => {
  const router = Router();
  const log = deps.logger.child({ route: 'admin-auth' });

  router.post('/bootstrap-super-admin', asyncRoute(async (req, res) => {
    const payload = bootstrapSuperAdminSchema.parse(req.body);

    const existingSuperAdminCount = await deps.prisma.adminMembership.count({
      where: { role: 'SUPER_ADMIN', isActive: true },
    });
    if (existingSuperAdminCount > 0) {
      throw routeError(409, 'Super-admin bootstrap already completed');
    }

    const existingUser = await deps.prisma.user.findUnique({ where: { email: payload.email } });
    if (existingUser) {
      throw routeError(409, 'Bootstrap email already exists');
    }

    const password = await bcrypt.hash(payload.password, 10);
    const user = await deps.prisma.user.create({
      data: {
        email: payload.email,
        password,
        ...(payload.name ? { name: payload.name } : {}),
      },
    });

    await deps.prisma.adminMembership.create({
      data: {
        userId: user.id,
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });

    deps.auditService.record({
      actorId: 'bootstrap',
      action: 'admin.auth.bootstrap_super_admin',
      outcome: 'success',
      metadata: { email: payload.email },
    });

    success(res, payload, 'Super-admin bootstrap completed', 201);
  }));

  router.post('/login/super-admin', asyncRoute(async (req, res) => {
    const payload = loginSuperAdminSchema.parse(req.body);
    const user = await deps.prisma.user.findUnique({ where: { email: payload.email } });
    if (!user || !(await bcrypt.compare(payload.password, user.password))) {
      throw routeError(401, 'Invalid credentials');
    }

    const membership = await deps.prisma.adminMembership.findFirst({
      where: {
        userId: user.id,
        role: 'SUPER_ADMIN',
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!membership) {
      throw routeError(403, 'User is not an active super-admin');
    }

    const result = await issueSession({
      prisma: deps.prisma,
      env: deps.env,
      userId: user.id,
      role: 'SUPER_ADMIN',
    });

    deps.auditService.record({
      actorId: result.session.userId,
      action: 'admin.auth.login_super_admin',
      outcome: 'success',
    });

    success(res, result, 'Super-admin login successful');
  }));

  router.post('/login/company-admin', asyncRoute(async (req, res) => {
    const payload = loginCompanyAdminSchema.parse(req.body);
    const user = await deps.prisma.user.findUnique({ where: { email: payload.email } });
    if (!user || !(await bcrypt.compare(payload.password, user.password))) {
      throw routeError(401, 'Invalid credentials');
    }

    const membership = await deps.prisma.adminMembership.findFirst({
      where: {
        userId: user.id,
        role: 'COMPANY_ADMIN',
        isActive: true,
        ...(payload.companyId ? { companyId: payload.companyId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!membership?.companyId) {
      throw routeError(403, 'User is not an active company admin');
    }

    const result = await issueSession({
      prisma: deps.prisma,
      env: deps.env,
      userId: user.id,
      role: 'COMPANY_ADMIN',
      companyId: membership.companyId,
    });

    deps.auditService.record({
      actorId: result.session.userId,
      action: 'admin.auth.login_company_admin',
      outcome: 'success',
      ...(result.session.companyId ? { companyId: result.session.companyId } : {}),
    });

    success(res, result, 'Company-admin login successful');
  }));

  router.post('/signup/company-admin', asyncRoute(async (req, res) => {
    const payload = signupCompanyAdminSchema.parse(req.body);

    try {
      const result = await deps.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: payload.email,
            password: await bcrypt.hash(payload.password, 10),
            ...(payload.name ? { name: payload.name } : {}),
          },
        });

        const company = await tx.company.create({
          data: { name: payload.companyName },
          select: { id: true },
        });

        await tx.adminMembership.create({
          data: {
            userId: user.id,
            companyId: company.id,
            role: 'COMPANY_ADMIN',
            isActive: true,
          },
        });

        return issueSession({
          prisma: tx as PrismaClient,
          env: deps.env,
          userId: user.id,
          role: 'COMPANY_ADMIN',
          companyId: company.id,
        });
      });

    deps.auditService.record({
      actorId: result.session.userId,
      action: 'admin.auth.signup_company_admin',
      outcome: 'success',
      ...(result.session.companyId ? { companyId: result.session.companyId } : {}),
    });

      success(res, result, 'Company-admin signup successful', 201);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw routeError(409, 'Email already exists');
      }
      throw error;
    }
  }));

  router.post('/signup/member-invite', asyncRoute(async (req, res) => {
    const payload = signupMemberInviteSchema.parse(req.body);
    const invite = await deps.prisma.companyInvite.findUnique({
      where: { token: payload.inviteToken },
    });

    if (!invite) throw routeError(404, 'Invite token not found');
    if (invite.status !== 'pending') throw routeError(409, 'Invite is no longer active');
    if (invite.expiresAt.getTime() < Date.now()) throw routeError(410, 'Invite has expired');

    const hashedPassword = await bcrypt.hash(payload.password, 10);
    const user = await deps.prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({ where: { email: invite.email } });
      const nextUser = existingUser
        ? await tx.user.update({
          where: { id: existingUser.id },
          data: {
            password: hashedPassword,
            ...(payload.name ? { name: payload.name } : {}),
          },
        })
        : await tx.user.create({
          data: {
            email: invite.email,
            password: hashedPassword,
            ...(payload.name ? { name: payload.name } : {}),
          },
        });

      const existingMembership = await tx.adminMembership.findFirst({
        where: {
          userId: nextUser.id,
          companyId: invite.companyId,
          role: invite.role,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (existingMembership) {
        await tx.adminMembership.update({
          where: { id: existingMembership.id },
          data: { isActive: true },
        });
      } else {
        await tx.adminMembership.create({
          data: {
            userId: nextUser.id,
            companyId: invite.companyId,
            role: invite.role,
            isActive: true,
          },
        });
      }

      await tx.companyInvite.update({
        where: { id: invite.id },
        data: {
          status: 'accepted',
          acceptedAt: new Date(),
        },
      });

      return nextUser;
    });

    deps.auditService.record({
      actorId: user.id,
      companyId: invite.companyId,
      action: 'workspace.invite.accept',
      outcome: 'success',
      metadata: {
        role: invite.role,
        email: user.email,
      },
    });

    success(res, {
      accepted: true,
      role: invite.role,
      companyId: invite.companyId,
      userId: user.id,
      email: user.email,
    }, 'Invite accepted', 201);
  }));

  router.post('/memberships/company-admin', asyncRoute(async (req, res) => {
    const actorSession = await resolveAdminSession(deps.prisma, deps.env, req);
    if (actorSession.role !== 'SUPER_ADMIN') {
      throw routeError(403, 'Insufficient admin role for this route');
    }

    const payload = grantCompanyAdminSchema.parse(req.body);
    const [user, company] = await Promise.all([
      deps.prisma.user.findUnique({ where: { id: payload.userId } }),
      deps.prisma.company.findUnique({ where: { id: payload.companyId } }),
    ]);

    if (!user) throw routeError(404, 'User not found');
    if (!company) throw routeError(404, 'Company not found');

    const existing = await deps.prisma.adminMembership.findFirst({
      where: {
        userId: payload.userId,
        companyId: payload.companyId,
        role: 'COMPANY_ADMIN',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      await deps.prisma.adminMembership.update({
        where: { id: existing.id },
        data: { isActive: true },
      });
    } else {
      await deps.prisma.adminMembership.create({
        data: {
          userId: payload.userId,
          companyId: payload.companyId,
          role: 'COMPANY_ADMIN',
          isActive: true,
        },
      });
    }

    deps.auditService.record({
      actorId: actorSession.userId,
      companyId: payload.companyId,
      action: 'admin.auth.grant_company_admin',
      outcome: 'success',
      metadata: { userId: payload.userId },
    });

    success(res, {
      userId: payload.userId,
      companyId: payload.companyId,
      role: 'COMPANY_ADMIN',
    }, 'Company-admin membership granted', 201);
  }));

  router.get('/me', asyncRoute(async (req, res) => {
    const session = await resolveAdminSession(deps.prisma, deps.env, req);
    success(res, session, 'Admin session resolved');
  }));

  router.get('/capabilities', asyncRoute(async (req, res) => {
    const session = await resolveAdminSession(deps.prisma, deps.env, req);
    success(res, getCapabilities(session.role), 'Admin capabilities resolved');
  }));

  router.post('/logout', asyncRoute(async (req, res) => {
    const session = await resolveAdminSession(deps.prisma, deps.env, req);
    await deps.prisma.adminSession.update({
      where: { sessionId: session.sessionId },
      data: { revokedAt: new Date() },
    });

    deps.auditService.record({
      actorId: session.userId,
      action: 'admin.auth.logout',
      outcome: 'success',
      ...(session.companyId ? { companyId: session.companyId } : {}),
    });

    success(res, { loggedOut: true }, 'Admin session revoked');
  }));

  router.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    log.error('admin_auth.unhandled', { error: String(error) });
    fail(res, 500, 'An unexpected error occurred');
  });

  return router;
};
