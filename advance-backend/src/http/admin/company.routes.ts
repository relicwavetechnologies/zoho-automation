/**
 * Company admin routes.
 *
 * All routes require admin auth. Mounted at /api/admin/company.
 *
 *   GET  /members               — list admin members
 *   GET  /directory             — company directory (members + Lark identities)
 *   GET  /invites               — list pending invites
 *   POST /invites               — create invite
 *   GET  /onboarding/status     — integration provider status
 *   GET  /tool-permissions      — company tool permissions matrix
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

export interface CompanyRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type RouteError = Error & { status: number };
const routeError = (status: number, message: string): RouteError => {
  const e = new Error(message) as RouteError;
  e.status = status;
  return e;
};

const success = <T>(res: Response, data: T, message?: string, status = 200) =>
  res.status(status).json({ success: true, data, ...(message ? { message } : {}) });

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, message });

const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) { fail(res, 400, error.issues[0]?.message ?? 'Invalid request'); return; }
      if (error instanceof Error && 'status' in error && typeof (error as RouteError).status === 'number') {
        fail(res, (error as RouteError).status, error.message); return;
      }
      throw error;
    }
  };

function resolveCompanyId(res: Response, providedId?: string): string {
  const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);
  const localId      = (res.locals['companyId'] as string | undefined) ?? '';
  if (isSuperAdmin) {
    if (!providedId) throw routeError(400, 'companyId is required for super-admin requests');
    return providedId;
  }
  if (providedId && providedId !== localId) throw routeError(403, 'Access denied: company mismatch');
  return localId;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const createInviteSchema = z.object({
  email:     z.string().email().max(200),
  roleId:    z.string().min(1).max(50),
  companyId: z.string().uuid().optional(),
});

// ── Route factory ─────────────────────────────────────────────────────────────

export function createCompanyRoutes(deps: CompanyRoutesDeps): Router {
  const router = Router();
  const { prisma } = deps;

  // ── List members ──────────────────────────────────────────────────────────
  router.get('/members', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const rawLimit  = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const limit     = Number.isFinite(rawLimit) ? Math.min(rawLimit, 500) : 50;

    const rows = await prisma.adminMembership.findMany({
      where:   { companyId, isActive: true },
      include: { user: { select: { id: true, name: true, email: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    });

    const members = rows.map(r => ({
      id:        r.id,
      userId:    r.userId,
      name:      r.user.name,
      email:     r.user.email,
      role:      r.role,
      isActive:  r.isActive,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    success(res, members, 'Members loaded');
  }));

  // ── Company directory ─────────────────────────────────────────────────────
  router.get('/directory', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);

    // Fetch data in parallel — minimal selects to keep query fast
    const [memberships, identities] = await Promise.all([
      prisma.adminMembership.findMany({
        where:   { companyId, isActive: true },
        include: {
          user: {
            select: {
              id:        true,
              name:      true,
              email:     true,
              createdAt: true,
              googleAuthLinks:       { select: { id: true, revokedAt: true }, take: 1 },
              departmentMemberships: {
                where:   { status: 'active', department: { companyId, status: 'active' } },
                select:  { department: { select: { name: true } }, role: { select: { slug: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.channelIdentity.findMany({
        where:  { companyId, channel: 'lark' },
        select: { id: true, email: true, displayName: true, larkOpenId: true, larkUserId: true, sourceRoles: true },
      }),
    ]);

    const larkByEmail = new Map(
      identities
        .filter((i): i is typeof i & { email: string } => Boolean(i.email?.trim()))
        .map(i => [i.email.trim().toLowerCase(), i]),
    );

    const seen = new Set<string>();
    const entries = memberships
      .filter(m => !seen.has(m.userId) && seen.add(m.userId))
      .map(m => {
        const email = m.user.email.trim().toLowerCase();
        const lark  = larkByEmail.get(email);
        const depts = m.user.departmentMemberships;
        return {
          userId:                 m.userId,
          name:                   m.user.name,
          email:                  m.user.email,
          companyRole:            m.role,
          larkLinked:             Boolean(lark),
          googleConnected:        m.user.googleAuthLinks.some(l => l.revokedAt === null),
          larkOpenId:             lark?.larkOpenId ?? null,
          larkDisplayName:        lark?.displayName ?? null,
          larkSourceRoles:        lark?.sourceRoles ?? [],
          departmentCount:        depts.length,
          managerDepartmentCount: depts.filter(d => d.role.slug === 'MANAGER').length,
          departmentNames:        depts.map(d => d.department.name),
          createdAt:              m.user.createdAt.toISOString(),
          updatedAt:              m.updatedAt.toISOString(),
        };
      });

    success(res, entries, 'Company directory loaded');
  }));

  // ── List invites ──────────────────────────────────────────────────────────
  router.get('/invites', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const rows      = await prisma.companyInvite.findMany({
      where:   { companyId },
      orderBy: { createdAt: 'desc' },
      take:    100,
    });
    const invites = rows.map(r => ({
      id:        r.id,
      email:     r.email,
      role:      r.role,
      status:    r.status,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
    success(res, invites, 'Invites loaded');
  }));

  // ── Create invite ─────────────────────────────────────────────────────────
  router.post('/invites', asyncRoute(async (req, res) => {
    const payload   = createInviteSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const invitedBy = (res.locals['userId'] as string | undefined) ?? 'unknown';

    const invite = await prisma.companyInvite.create({
      data: {
        companyId,
        email:     payload.email.trim().toLowerCase(),
        role:      payload.roleId,
        status:    'pending',
        token:     randomUUID(),
        invitedBy,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    success(
      res,
      { id: invite.id, email: invite.email, role: invite.role, status: invite.status, expiresAt: invite.expiresAt.toISOString() },
      'Invite created',
      201,
    );
  }));

  // ── Onboarding status ─────────────────────────────────────────────────────
  router.get('/onboarding/status', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);

    const [zohoConn, larkBinding, googleLink] = await Promise.all([
      prisma.zohoConnection.findFirst({
        where:   { companyId },
        select:  { status: true, environment: true, connectedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.larkTenantBinding.findFirst({
        where:  { companyId, isActive: true },
        select: { larkTenantKey: true, isActive: true, createdAt: true },
      }),
      prisma.companyGoogleAuthLink.findFirst({
        where:   { companyId, revokedAt: null },
        select:  { googleEmail: true, linkedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const providers = [
      {
        provider:    'zoho',
        connected:   zohoConn?.status === 'CONNECTED',
        status:      zohoConn?.status ?? 'disconnected',
        connectedAt: zohoConn?.connectedAt?.toISOString() ?? null,
        details:     zohoConn ? { environment: zohoConn.environment } : null,
      },
      {
        provider:    'lark',
        connected:   Boolean(larkBinding),
        status:      larkBinding ? 'connected' : 'disconnected',
        connectedAt: larkBinding?.createdAt.toISOString() ?? null,
        details:     larkBinding ? { tenantKey: larkBinding.larkTenantKey } : null,
      },
      {
        provider:    'google',
        connected:   Boolean(googleLink),
        status:      googleLink ? 'connected' : 'disconnected',
        connectedAt: googleLink?.linkedAt.toISOString() ?? null,
        details:     googleLink ? { email: googleLink.googleEmail } : null,
      },
    ];

    success(res, providers, 'Onboarding status loaded');
  }));

  // ── Tool permissions ──────────────────────────────────────────────────────
  router.get('/tool-permissions', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);

    const [toolPerms, actionPerms] = await Promise.all([
      prisma.toolPermission.findMany({
        where:   { companyId },
        orderBy: [{ toolId: 'asc' }, { role: 'asc' }],
      }),
      prisma.toolActionPermission.findMany({
        where:   { companyId },
        orderBy: [{ toolId: 'asc' }, { role: 'asc' }, { actionGroup: 'asc' }],
      }),
    ]);

    success(res, {
      permissions:       toolPerms.map(p => ({ id: p.id, toolId: p.toolId, role: p.role, enabled: p.enabled })),
      actionPermissions: actionPerms.map(p => ({ id: p.id, toolId: p.toolId, role: p.role, actionGroup: p.actionGroup, enabled: p.enabled })),
    }, 'Tool permissions loaded');
  }));

  return router;
}
