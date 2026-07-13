/**
 * Company admin routes.
 *
 * All routes require admin auth. Mounted at /api/admin/company.
 *
 *   GET  /members               — list admin members
 *   PUT  /members/:userId/role  — update a company member role
 *   GET  /directory             — company directory (members + Lark identities)
 *   GET  /invites               — list pending invites
 *   POST /invites               — create invite
 *   GET  /onboarding/status     — integration provider status
 *   POST /onboarding/zoho-start — build backend-managed Zoho OAuth URL
 *   POST /onboarding/lark-start — build backend-managed Lark user OAuth URL
 *   POST /onboarding/connect    — complete backend-managed Zoho OAuth callback
 *   GET  /tool-permissions      — company tool permissions matrix
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import type { CachePort } from '../../shared/cache';
import type { TypedEnv } from '../../config/env';
import type { LarkOAuthService } from '../../infrastructure/lark/lark-oauth.service';
import type { ZohoTokenService } from '../../infrastructure/zoho/zoho-token.service';
import type { ZohoConnectionRepository } from '../../infrastructure/zoho/zoho-connection.repository';
import {
  LARK_OAUTH_NONCE_TTL_SECONDS,
  encodeLarkOAuthState,
  larkOAuthNonceKey,
} from '../lark/lark-auth.routes';

export interface CompanyRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
  env: TypedEnv;
  cache: CachePort;
  larkOAuthService?: LarkOAuthService;
  zohoTokenService: ZohoTokenService;
  zohoConnectionRepo: ZohoConnectionRepository;
  larkContactsClient?: { listDepartmentMembers(departmentId: string, limit?: number): Promise<Array<{ openId: string; displayName: string; email?: string }>> };
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

// Company membership is deliberately simpler than platform administration.
// A company admin can assign only these tenant-scoped roles; SUPER_ADMIN is a
// platform operator role and must never be granted from a company workspace.
const updateMemberRoleSchema = z.object({
  role: z.enum(['MEMBER', 'COMPANY_ADMIN']),
  companyId: z.string().uuid().optional(),
});

const ZOHO_SCOPE_LEVELS = ['read_only', 'read_write', 'full'] as const;
type ZohoScopeLevel = typeof ZOHO_SCOPE_LEVELS[number];

const zohoStartSchema = z.object({
  companyId:  z.string().uuid().optional(),
  returnTo:   z.string().url().optional(),
  scopeLevel: z.enum(ZOHO_SCOPE_LEVELS).optional(),
});

const larkStartSchema = z.object({
  companyId: z.string().uuid().optional(),
  returnTo:  z.string().url().optional(),
});

const zohoConnectSchema = z.object({
  code:  z.string().min(1),
  state: z.string().min(1),
});

interface ZohoOAuthState {
  companyId:   string;
  environment: string;
  nonce:       string;
  returnTo?:   string;
}

const ZOHO_NONCE_TTL_SECONDS = 600;

const ZOHO_SCOPES_BY_LEVEL: Record<ZohoScopeLevel, readonly string[]> = {
  read_only: [
    'ZohoCRM.modules.READ',
    'ZohoCRM.settings.READ',
    'ZohoBooks.fullaccess.READ',
  ],
  read_write: [
    'ZohoCRM.modules.ALL',
    'ZohoCRM.settings.READ',
    'ZohoBooks.fullaccess.all',
  ],
  full: [
    'ZohoCRM.modules.ALL',
    'ZohoCRM.settings.ALL',
    'ZohoBooks.fullaccess.all',
  ],
};

const DEFAULT_ZOHO_SCOPES = [
  'ZohoCRM.modules.ALL',
  'ZohoCRM.settings.ALL',
  'ZohoBooks.fullaccess.all',
  'ZohoBooks.contacts.all',
  'ZohoBooks.invoices.all',
  'ZohoBooks.expenses.all',
];

const zohoNonceKey = (nonce: string): string => `zoho:oauth:nonce:${nonce}`;

const oauthNonceFallback = new Map<string, { value: unknown; expiresAt: number }>();
function fallbackSet(key: string, value: unknown, ttlSeconds: number) {
  oauthNonceFallback.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}
function fallbackGet<T>(key: string): T | null {
  const entry = oauthNonceFallback.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { oauthNonceFallback.delete(key); return null; }
  return entry.value as T;
}
function fallbackDel(key: string) { oauthNonceFallback.delete(key); }

function encodeZohoState(state: ZohoOAuthState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

function decodeZohoState(raw: string): ZohoOAuthState | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed.companyId !== 'string' || typeof parsed.nonce !== 'string') return null;
    return {
      companyId: parsed.companyId,
      environment: typeof parsed.environment === 'string' ? parsed.environment : 'prod',
      nonce: parsed.nonce,
      ...(typeof parsed.returnTo === 'string' ? { returnTo: parsed.returnTo } : {}),
    };
  } catch {
    return null;
  }
}

function buildZohoAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  accountsBaseUrl: string;
}): string {
  const url = new URL(`${opts.accountsBaseUrl.replace(/\/$/, '')}/oauth/v2/auth`);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', opts.scopes.join(' '));
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', opts.state);
  return url.toString();
}

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

  // ── Update company member role ──────────────────────────────────────────
  // Keep one active membership authoritative per user/company. Older versions
  // allowed a MEMBER and COMPANY_ADMIN row to remain active at once, which made
  // role reads dependent on query ordering.
  router.put('/members/:userId/role', asyncRoute(async (req, res) => {
    const payload = updateMemberRoleSchema.parse(req.body ?? {});
    const companyId = resolveCompanyId(res, payload.companyId);
    const actorId = res.locals['userId'] as string | null | undefined;
    const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);
    if (!actorId && !isSuperAdmin) throw routeError(403, 'An authenticated company admin is required');

    let result: { userId: string; companyId: string | null; role: string };
    try {
      result = await prisma.$transaction(async (tx) => {
        if (!isSuperAdmin) {
          const actorMembership = await tx.adminMembership.findFirst({
            where: { userId: actorId!, companyId, role: 'COMPANY_ADMIN', isActive: true },
            select: { id: true },
            orderBy: { updatedAt: 'desc' },
          });
          if (!actorMembership) throw routeError(403, 'Only an active company admin can update member roles');
        }

        const memberships = await tx.adminMembership.findMany({
          where: { userId: req.params.userId!, companyId, isActive: true },
          select: { id: true, role: true },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        });
        const primary = memberships[0];
        if (!primary) throw routeError(404, 'Member not found in this company');

        const targetIsCompanyAdmin = memberships.some(membership => membership.role === 'COMPANY_ADMIN');
        if (targetIsCompanyAdmin && payload.role === 'MEMBER') {
          const companyAdminCount = await tx.adminMembership.count({
            where: { companyId, role: 'COMPANY_ADMIN', isActive: true },
          });
          if (companyAdminCount <= 1) {
            throw routeError(409, 'At least one active company admin is required');
          }
        }

        // Deactivate every prior active record before reactivating the newest
        // record as the sole source of truth for this user and company.
        await tx.adminMembership.updateMany({
          where: { userId: req.params.userId!, companyId, isActive: true },
          data: { isActive: false },
        });
        const membership = await tx.adminMembership.update({
          where: { id: primary.id },
          data: { role: payload.role, isActive: true },
          select: { userId: true, companyId: true, role: true },
        });

        // AdminSession carries an issuance-time role. Revoke the target's
        // existing dashboard sessions so a demoted admin cannot retain access.
        await tx.adminSession.updateMany({
          where: { userId: membership.userId, companyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        return membership;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      // Serializable isolation prevents two concurrent demotions from removing
      // every company admin. Surface contention as a safe retry rather than a
      // generic internal failure.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw routeError(409, 'Member roles changed concurrently. Refresh and try again.');
      }
      throw error;
    }

    deps.logger.info('company.member_role.updated', {
      companyId,
      actorId: actorId ?? 'platform',
      userId: result.userId,
      role: result.role,
    });
    success(res, result, 'Member role updated');
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
              ownedIntegrationConnections: {
                where:  { companyId, provider: 'google_workspace', revokedAt: null },
                select: { id: true },
                take:   1,
              },
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
          googleConnected:        m.user.ownedIntegrationConnections.length > 0,
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
        select:  { status: true, environment: true, connectedAt: true, scopes: true, tokenFailureCode: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.larkTenantBinding.findFirst({
        where:  { companyId, isActive: true },
        select: { larkTenantKey: true, isActive: true, createdAt: true },
      }),
      prisma.integrationConnection.findFirst({
        where:   { companyId, provider: 'google_workspace', ownerType: 'company', revokedAt: null },
        select:  { accountEmail: true, connectedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const zohoScopeLevel: ZohoScopeLevel | null = zohoConn?.scopes
      ? (zohoConn.scopes.some((s: string) => s.includes('fullaccess') && !s.includes('READ')) ? 'full'
        : zohoConn.scopes.some((s: string) => s.includes('.ALL')) ? 'read_write'
        : 'read_only')
      : null;

    const providers = [
      {
        provider:    'zoho',
        connected:   zohoConn?.status === 'CONNECTED',
        status:      zohoConn?.tokenFailureCode ? 'error' : (zohoConn?.status?.toLowerCase() ?? 'disconnected'),
        connectedAt: zohoConn?.connectedAt?.toISOString() ?? null,
        updatedAt:   zohoConn?.updatedAt?.toISOString() ?? null,
        scopeLevel:  zohoScopeLevel,
        scopes:      zohoConn?.scopes ?? [],
        error:       zohoConn?.tokenFailureCode ?? null,
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
        connectedAt: googleLink?.connectedAt.toISOString() ?? null,
        details:     googleLink ? { email: googleLink.accountEmail } : null,
      },
    ];

    success(res, providers, 'Onboarding status loaded');
  }));

  router.post('/onboarding/zoho-start', asyncRoute(async (req, res) => {
    const body = zohoStartSchema.parse(req.body ?? {});
    const companyId = resolveCompanyId(res, body.companyId);
    const userId = res.locals['userId'] as string | undefined;
    const clientId = (deps.env.ZOHO_CLIENT_ID ?? '').trim();
    const redirectUri = (deps.env.ZOHO_REDIRECT_URI ?? '').trim();
    const accountsBaseUrl = deps.env.ZOHO_ACCOUNTS_BASE_URL.trim();

    if (!userId) throw routeError(401, 'Admin user context is required');
    if (!deps.zohoTokenService.isConfigured() || !clientId || !redirectUri) {
      throw routeError(503, 'Zoho OAuth is handled by backend env for now, but backend Zoho env is not configured');
    }

    const nonce = randomBytes(24).toString('hex');
    const noncePayload = { companyId, userId };
    const cacheResult = await deps.cache.set(zohoNonceKey(nonce), noncePayload, ZOHO_NONCE_TTL_SECONDS);
    if (!cacheResult.ok) fallbackSet(zohoNonceKey(nonce), noncePayload, ZOHO_NONCE_TTL_SECONDS);

    const state: ZohoOAuthState = {
      companyId,
      environment: 'prod',
      nonce,
      returnTo: body.returnTo ?? `${deps.env.APP_BASE_URL}/settings?tab=integrations`,
    };
    const scopeLevel = body.scopeLevel ?? 'full';
    const scopes = ZOHO_SCOPES_BY_LEVEL[scopeLevel] ?? DEFAULT_ZOHO_SCOPES;

    const authUrl = buildZohoAuthorizeUrl({
      clientId,
      redirectUri,
      scopes: [...scopes],
      state: encodeZohoState(state),
      accountsBaseUrl,
    });

    deps.logger.info('zoho.admin_oauth.start', { companyId, userId, scopeLevel });
    success(res, {
      authUrl,
      provider: 'zoho',
      scopeLevel,
      message: `Zoho OAuth started with ${scopeLevel} access.`,
    }, 'Zoho OAuth URL created');
  }));

  router.post('/onboarding/lark-start', asyncRoute(async (req, res) => {
    const body = larkStartSchema.parse(req.body ?? {});
    const companyId = resolveCompanyId(res, body.companyId);
    const userId = res.locals['userId'] as string | undefined;

    if (!userId) throw routeError(401, 'Admin user context is required');
    if (!deps.larkOAuthService?.isConfigured()) {
      throw routeError(503, 'Lark OAuth is not configured');
    }

    const [user, existingLink, binding] = await Promise.all([
      prisma.user.findUnique({
        where:  { id: userId },
        select: { email: true },
      }),
      prisma.larkUserAuthLink.findUnique({
        where:  { userId_companyId: { userId, companyId } },
        select: { larkOpenId: true },
      }),
      prisma.larkTenantBinding.findFirst({
        where:  { companyId, isActive: true },
        select: { larkTenantKey: true },
      }),
    ]);

    if (!binding) throw routeError(400, 'No active Lark tenant binding exists for this company');

    const identityFilters = [
      ...(user?.email ? [{ email: user.email }] : []),
      ...(existingLink?.larkOpenId ? [
        { larkOpenId: existingLink.larkOpenId },
        { externalUserId: existingLink.larkOpenId },
      ] : []),
    ];

    if (identityFilters.length === 0) {
      throw routeError(400, 'No Lark identity is mapped for this admin user');
    }

    const identity = await prisma.channelIdentity.findFirst({
      where: {
        companyId,
        channel: 'lark',
        OR:      identityFilters,
      },
      select: {
        externalUserId: true,
        larkOpenId:     true,
      },
    });

    const larkOpenId = identity?.larkOpenId ?? identity?.externalUserId ?? existingLink?.larkOpenId;
    if (!larkOpenId) {
      throw routeError(400, 'No Lark open_id is mapped for this admin user');
    }

    const nonce = deps.larkOAuthService.generateNonce();
    const noncePayload = { companyId, userId, larkOpenId };
    const cacheResult = await deps.cache.set(larkOAuthNonceKey(nonce), noncePayload, LARK_OAUTH_NONCE_TTL_SECONDS);
    if (!cacheResult.ok) throw routeError(503, 'Unable to start Lark OAuth session');

    const state = encodeLarkOAuthState({ companyId, userId, larkOpenId, nonce });
    const url = deps.larkOAuthService.getAuthorizeUrl(state);

    deps.logger.info('lark.admin_oauth.start', { companyId, userId, larkOpenId, tenantKey: binding.larkTenantKey });
    success(res, {
      provider: 'lark',
      url,
      returnTo: body.returnTo ?? `${deps.env.APP_BASE_URL}/settings?tab=integrations`,
    }, 'Lark OAuth URL created');
  }));

  router.post('/onboarding/connect', asyncRoute(async (req, res) => {
    const body = zohoConnectSchema.parse(req.body ?? {});
    const state = decodeZohoState(body.state);
    if (!state) throw routeError(400, 'Invalid Zoho OAuth state');

    const companyId = resolveCompanyId(res, state.companyId);
    const nonceKey = zohoNonceKey(state.nonce);
    const stored = await deps.cache.get<{ companyId: string; userId: string }>(nonceKey);
    const noncePayload = (stored.ok && stored.value)
      ? stored.value
      : fallbackGet<{ companyId: string; userId: string }>(nonceKey);
    if (noncePayload) {
      if (noncePayload.companyId !== companyId) {
        throw routeError(400, 'Zoho OAuth state expired or invalid');
      }
      await deps.cache.del(nonceKey);
      fallbackDel(nonceKey);
    } else {
      // Redis unavailable and in-memory lost (e.g. dev server restart).
      // The admin JWT already authenticates the caller, and companyId in the
      // state is verified against the JWT's company — safe to proceed.
      const jwtCompanyId = res.locals['companyId'] as string | undefined;
      if (!jwtCompanyId || jwtCompanyId !== companyId) {
        throw routeError(400, 'Zoho OAuth state expired or invalid');
      }
    }

    const redirectUri = (deps.env.ZOHO_REDIRECT_URI ?? '').trim();
    const tokens = await deps.zohoTokenService.exchangeAuthorizationCode({
      companyId,
      environment: state.environment,
      authorizationCode: body.code,
      ...(redirectUri ? { redirectUri } : {}),
    });

    const upsertResult = await deps.zohoConnectionRepo.upsertFromExchange({
      companyId,
      environment: state.environment,
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      expiresIn: tokens.expiresIn,
      scopes: tokens.scopes,
    });
    if (!upsertResult.ok) throw routeError(500, upsertResult.error.message);

    // Test the connection by hitting the organizations endpoint
    let connectionTest: { success: boolean; organizationName?: string; error?: string } = { success: false };
    try {
      const apiBase = deps.env.ZOHO_API_BASE_URL?.replace(/\/$/, '') ?? 'https://www.zohoapis.com';
      const testRes = await fetch(`${apiBase}/books/v3/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${tokens.accessToken}` },
      });
      const testData = await testRes.json() as { organizations?: Array<{ name?: string }> };
      if (testRes.ok && testData.organizations?.length) {
        connectionTest = { success: true, organizationName: testData.organizations[0]?.name ?? 'Unknown' };
      } else {
        connectionTest = { success: false, error: `API returned ${testRes.status}` };
      }
    } catch (e) {
      connectionTest = { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    deps.logger.info('zoho.admin_oauth.connected', {
      companyId, environment: state.environment, scopes: tokens.scopes,
      connectionTest: connectionTest.success,
      organizationName: connectionTest.organizationName,
    });
    success(res, {
      provider: 'zoho',
      connected: true,
      connectionTest,
      returnTo: state.returnTo ?? `${deps.env.APP_BASE_URL}/settings?tab=integrations`,
      scopes: tokens.scopes,
    }, connectionTest.success
      ? `Zoho connected — verified with org "${connectionTest.organizationName}"`
      : 'Zoho connected but verification failed');
  }));

  // ── Disconnect integration ────────────────────────────────────────────────
  router.post('/onboarding/disconnect', asyncRoute(async (req, res) => {
    const body = z.object({ provider: z.enum(['zoho', 'lark', 'google']) }).parse(req.body ?? {});
    const companyId = resolveCompanyId(res);
    const userId = res.locals['userId'] as string | undefined;

    switch (body.provider) {
      case 'zoho':
        await prisma.zohoConnection.updateMany({
          where: { companyId },
          data: { status: 'DISCONNECTED', tokenFailureCode: 'admin_disconnected' },
        });
        break;
      case 'lark':
        if (userId) {
          await prisma.larkUserAuthLink.updateMany({
            where: { userId, companyId },
            data: { revokedAt: new Date() },
          });
        }
        break;
      case 'google':
        if (userId) {
          await prisma.integrationConnection.updateMany({
            where: { companyId, provider: 'google_workspace', ownerType: 'company', revokedAt: null },
            data: { revokedAt: new Date(), status: 'revoked' },
          });
        }
        break;
    }

    deps.logger.info('admin.integration.disconnected', { companyId, provider: body.provider, userId });
    success(res, { disconnected: true, provider: body.provider }, `${body.provider} disconnected`);
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

  // ── Sync Lark directory (SSE streaming) ─────────────────────────────────────
  router.post('/sync-directory', async (req, res) => {
    let companyId: string;
    try {
      companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    } catch (e) {
      const err = e as RouteError;
      res.status(err.status ?? 400).json({ success: false, message: err.message });
      return;
    }
    if (!deps.larkContactsClient) { res.status(503).json({ success: false, message: 'Lark contacts client not configured' }); return; }

    const binding = await prisma.larkTenantBinding.findFirst({
      where: { companyId, isActive: true },
      select: { larkTenantKey: true },
    });
    if (!binding) { res.status(400).json({ success: false, message: 'No active Lark tenant binding' }); return; }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: Record<string, unknown>) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('status', { phase: 'starting', message: 'Starting Lark directory sync...' });

    const syncRun = await prisma.larkDirectorySyncRun.create({
      data: { companyId, trigger: 'manual', status: 'running', startedAt: new Date() },
    });

    try {
      send('status', { phase: 'fetching', message: 'Fetching users from Lark...' });
      const users = await deps.larkContactsClient.listDepartmentMembers('0', 50);
      send('status', { phase: 'fetched', message: `Found ${users.length} users`, total: users.length });

      let synced = 0;
      let usersCreated = 0;
      for (const user of users) {
        if (!user.openId) continue;

        // 1. Upsert ChannelIdentity (matched by openId)
        await prisma.channelIdentity.upsert({
          where: {
            channel_externalUserId_companyId: {
              channel: 'lark',
              externalUserId: user.openId,
              companyId,
            },
          },
          create: {
            companyId,
            channel: 'lark',
            externalUserId: user.openId,
            externalTenantId: binding.larkTenantKey,
            displayName: user.displayName,
            email: user.email ?? null,
            larkOpenId: user.openId,
            aiRole: 'MEMBER',
            aiRoleSource: 'sync',
            syncedAiRole: 'MEMBER',
            sourceRoles: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          update: {
            displayName: user.displayName,
            ...(user.email ? { email: user.email } : {}),
            updatedAt: new Date(),
          },
        });

        // 2. Auto-create User + AdminMembership if email present and no User exists
        if (user.email) {
          const email = user.email.trim().toLowerCase();
          let existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });

          // If no User with this email, check LarkUserAuthLink — the canonical
          // openId→userId mapping. This catches email changes in Lark: the auth
          // link still points to the original User even after their Lark email changed.
          if (!existingUser) {
            const authLink = await prisma.larkUserAuthLink.findFirst({
              where: { larkOpenId: user.openId },
              select: { userId: true },
            });
            if (authLink) {
              await prisma.user.update({
                where: { id: authLink.userId },
                data: { email, ...(user.displayName ? { name: user.displayName } : {}) },
              }).catch(() => {});
              existingUser = { id: authLink.userId };
            }
          }

          if (!existingUser) {
            const newUser = await prisma.user.create({
              data: {
                email,
                name: user.displayName,
                password: randomBytes(32).toString('hex'),
              },
            });
            await prisma.adminMembership.create({
              data: { userId: newUser.id, companyId, role: 'MEMBER', isActive: true },
            });
            usersCreated++;
          } else if (user.displayName) {
            await prisma.user.update({
              where: { id: existingUser.id },
              data: { name: user.displayName },
            }).catch(() => {});
          }
        }

        synced++;
        if (synced % 5 === 0 || synced === users.length) {
          send('progress', {
            synced, total: users.length,
            pct: Math.round((synced / users.length) * 100),
            usersCreated,
          });
        }
      }

      await prisma.larkDirectorySyncRun.update({
        where: { id: syncRun.id },
        data: { status: 'succeeded', syncedCount: synced, memberCount: synced, finishedAt: new Date() },
      });

      deps.logger.info('directory_sync.completed', { companyId, synced, usersCreated });
      send('done', { synced, usersCreated, message: `Synced ${synced} users from Lark${usersCreated > 0 ? ` (${usersCreated} new accounts created)` : ''}` });
      res.end();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await prisma.larkDirectorySyncRun.update({
        where: { id: syncRun.id },
        data: { status: 'failed', errorMessage: msg, finishedAt: new Date() },
      }).catch(() => {});
      deps.logger.error('directory_sync.failed', { companyId, error: msg });
      send('error', { message: msg });
      res.end();
    }
  });

  return router;
}
