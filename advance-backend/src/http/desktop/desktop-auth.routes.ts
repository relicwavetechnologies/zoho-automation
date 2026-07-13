import { Router, type Request, type Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { LarkOAuthService } from '../../infrastructure/lark/lark-oauth.service';
import type { GoogleOAuthService } from '../../infrastructure/google/google-oauth.service';
import type { ZohoTokenService } from '../../infrastructure/zoho/zoho-token.service';
import type { ZohoConnectionRepository } from '../../infrastructure/zoho/zoho-connection.repository';
import type { LarkUserAuthLinkRepository } from '../../infrastructure/persistence/lark-user-auth-link.repository';
import type { IntegrationConnectionRepository } from '../../infrastructure/persistence/integration-connection.repository';
import type { Logger } from '../../shared/logger';
import type { TypedEnv } from '../../config/env';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';
import type { PermissionService } from '../../application/permissions/permission.service';
import type { SkillCatalogService } from '../../application/skills/skill-catalog.service';
import { buildDesktopCapabilityBootstrap, isFinanceDepartment } from '../../application/desktop/desktop-capability-bootstrap';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';

export interface DesktopAuthRoutesDeps {
  prisma:                 PrismaClient;
  larkOAuthService:       LarkOAuthService;
  googleOAuthService:     GoogleOAuthService;
  zohoTokenService:       ZohoTokenService;
  zohoConnectionRepo:     ZohoConnectionRepository;
  larkUserAuthLinkRepo:   LarkUserAuthLinkRepository;
  connectionRepo:         IntegrationConnectionRepository;
  permissions:            PermissionService;
  skillCatalog:           SkillCatalogService;
  logger:                 Logger;
  env:                    TypedEnv;
  memberJwtSecret:        string;
  backendPublicUrl:       string;
  sessionTtlMinutes:      number;
}

interface StatePayload {
  kind: string;
  nonce: string;
  userId?: string;
  companyId?: string;
  sessionId?: string;
  exp?: number;
}

const DESKTOP_PROTOCOL = 'cursorr';
const HANDOFF_TTL_MS   = 5 * 60 * 1000;
const GOOGLE_GRANT_ACCESSES = new Set(['read_only', 'read_write', 'admin']);
const GOOGLE_GRANTEE_TYPES = new Set(['user', 'department', 'role', 'company']);
const COMPANY_ADMIN_ROLES = new Set(['COMPANY_ADMIN', 'SUPER_ADMIN']);
const DEFAULT_ZOHO_SCOPES = [
  'ZohoCRM.modules.ALL',
  'ZohoCRM.settings.ALL',
  'ZohoBooks.fullaccess.all',
  'ZohoBooks.contacts.all',
  'ZohoBooks.invoices.all',
  'ZohoBooks.expenses.all',
];

const runtimeContextQuerySchema = z.object({
  departmentId: z.string().uuid().optional(),
});

const pendingCallbacks = new Map<string, { code: string; state: string; createdAt: number }>();
const pendingCallbackCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingCallbacks) {
    if (now - v.createdAt > 5 * 60 * 1000) pendingCallbacks.delete(k);
  }
}, 60_000);
pendingCallbackCleanup.unref?.();

function signJwt(payload: Record<string, unknown>, secret: string, expiresInSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token: string, secret: string): StatePayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(sigB64, 'base64url'), Buffer.from(expected, 'base64url'))) return null;
  } catch { return null; }
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as StatePayload;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

async function issueDesktopSession(
  deps: DesktopAuthRoutesDeps,
  userId: string,
  companyId: string,
  role: string,
  opts: { authProvider: string; larkTenantKey?: string; larkOpenId?: string; larkUserId?: string | null },
) {
  const sessionId = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + deps.sessionTtlMinutes * 60 * 1000);

  await deps.prisma.memberSession.create({
    data: {
      sessionId,
      userId,
      companyId,
      role,
      channel:       'desktop',
      authProvider:   opts.authProvider,
      larkTenantKey:  opts.larkTenantKey ?? null,
      larkOpenId:     opts.larkOpenId ?? null,
      larkUserId:     opts.larkUserId ?? null,
      expiresAt,
    },
  });

  const token = signJwt(
    { userId, sessionId, role, companyId, channel: 'desktop' },
    deps.memberJwtSecret,
    deps.sessionTtlMinutes * 60,
  );

  return { token, sessionId, userId, companyId, role, expiresAt };
}

export function createDesktopAuthRoutes(deps: DesktopAuthRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'desktop-auth' });

  const memberAuth = createMemberAuthMiddleware({
    prisma:    deps.prisma,
    jwtSecret: deps.memberJwtSecret,
    logger:    deps.logger,
  });

  const buildGoogleConnectionManagePayload = async (
    connectionId: string,
    userId: string,
    companyId: string,
    role: string,
    provider: 'google_workspace' | 'zoho' = 'google_workspace',
  ) => {
    const accessible = provider === 'zoho'
      ? await deps.connectionRepo.listAccessibleZohoConnections({ userId, companyId })
      : await deps.connectionRepo.listAccessibleGoogleConnections({ userId, companyId });
    if (!accessible.ok) throw new Error(accessible.error.message);
    const summary = accessible.value.find(connection => connection.connectionId === connectionId);

    const connection = await deps.prisma.integrationConnection.findFirst({
      where: {
        id:        connectionId,
        companyId,
        provider,
        revokedAt: null,
        status:    'connected',
      },
      include: {
        ownerUser: { select: { id: true, email: true, name: true } },
        grants: {
          where:   { revokedAt: null },
          orderBy: { grantedAt: 'desc' },
          include: {
            grantedByUser: { select: { id: true, email: true, name: true } },
          },
        },
      },
    });
    if (!connection || !summary) return null;

    const canManage =
      connection.ownerUserId === userId ||
      connection.createdBy === userId ||
      summary.access === 'admin' ||
      COMPANY_ADMIN_ROLES.has(role);
    if (!canManage) return { forbidden: true as const };

    const [memberships, departments, departmentRoles, company] = await Promise.all([
      deps.prisma.adminMembership.findMany({
        where: { companyId, isActive: true },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
        orderBy: [{ role: 'asc' }, { updatedAt: 'desc' }],
      }),
      deps.prisma.department.findMany({
        where:   { companyId, status: 'active' },
        select:  { id: true, name: true, slug: true },
        orderBy: { name: 'asc' },
      }),
      deps.prisma.departmentRole.findMany({
        where: {
          department: { companyId, status: 'active' },
        },
        select: {
          id: true,
          name: true,
          slug: true,
          department: { select: { id: true, name: true } },
        },
        orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
      }),
      deps.prisma.company.findUnique({
        where:  { id: companyId },
        select: { id: true, name: true },
      }),
    ]);

    const users = memberships.map(membership => ({
      id:    membership.user.id,
      name:  membership.user.name,
      email: membership.user.email,
      role:  membership.role,
    }));
    const usersById = new Map(users.map(user => [user.id, user]));
    const departmentsById = new Map(departments.map(department => [department.id, department]));
    const departmentRolesById = new Map(departmentRoles.map(departmentRole => [departmentRole.id, departmentRole]));
    const companyRoles = ['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'].map(companyRole => ({
      id:   companyRole,
      name: companyRole.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
    }));
    const companyRolesById = new Map(companyRoles.map(companyRole => [companyRole.id, companyRole]));

    return {
      connection: {
        connectionId: connection.id,
        label:        connection.label,
        accountEmail: connection.accountEmail ?? null,
        accountName:  connection.accountName ?? null,
        ownerType:    connection.ownerType,
        ownerUser:    connection.ownerUser ?? null,
        access:       summary.access,
        scopes:       connection.scopes,
        connectedAt:  connection.connectedAt.toISOString(),
      },
      grants: connection.grants.map(grant => {
        const user = grant.granteeType === 'user' ? usersById.get(grant.granteeId) : undefined;
        const department = grant.granteeType === 'department' ? departmentsById.get(grant.granteeId) : undefined;
        const departmentRole = grant.granteeType === 'role' ? departmentRolesById.get(grant.granteeId) : undefined;
        const companyRole = grant.granteeType === 'role' ? companyRolesById.get(grant.granteeId) : undefined;
        const granteeLabel =
          user?.name || user?.email ||
          department?.name ||
          (departmentRole ? `${departmentRole.department.name} / ${departmentRole.name}` : undefined) ||
          companyRole?.name ||
          company?.name ||
          grant.granteeId;

        return {
          id:          grant.id,
          granteeType: grant.granteeType,
          granteeId:   grant.granteeId,
          granteeLabel,
          granteeDetail: user?.email ?? departmentRole?.department.name ?? null,
          access:      grant.access,
          grantedAt:   grant.grantedAt.toISOString(),
          grantedBy:   grant.grantedByUser
            ? { id: grant.grantedByUser.id, email: grant.grantedByUser.email, name: grant.grantedByUser.name }
            : null,
        };
      }),
      candidates: {
        users,
        departments,
        roles: [
          ...companyRoles.map(companyRole => ({ ...companyRole, kind: 'company' })),
          ...departmentRoles.map(departmentRole => ({
            id:           departmentRole.id,
            name:         departmentRole.name,
            slug:         departmentRole.slug,
            kind:         'department',
            departmentId: departmentRole.department.id,
            department:   departmentRole.department.name,
          })),
        ],
        company: company ? { id: company.id, name: company.name } : null,
      },
      accessLevels: [
        {
          value: 'read_only',
          label: 'Read-only',
          description: provider === 'zoho'
            ? 'Can read Zoho CRM and Books data allowed by Zoho scopes.'
            : 'Can read Gmail, Drive, and Calendar data allowed by Google scopes.',
        },
        {
          value: 'read_write',
          label: 'Read/write',
          description: provider === 'zoho'
            ? 'Can read plus create, update, send, or delete through approved Zoho tools.'
            : 'Can read plus create, update, send, or delete through approved Google tools.',
        },
        { value: 'admin', label: 'Admin', description: 'Can use the connection and manage who else has access.' },
      ],
    };
  };

  const fetchZohoAccountSummary = async (accessToken: string, apiBaseUrl: string) => {
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/books/v3/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
      const payload = (await res.json().catch(() => ({}))) as {
        organizations?: Array<{
          organization_id?: string;
          organizationId?: string;
          name?: string;
          is_default_org?: boolean;
          is_default?: boolean;
        }>;
      };
      if (!res.ok || !Array.isArray(payload.organizations)) return null;
      const org = payload.organizations.find(item => item.is_default_org === true || item.is_default === true)
        ?? payload.organizations[0];
      if (!org) return null;
      return {
        externalAccountId: org.organization_id ?? org.organizationId,
        accountName: org.name,
      };
    } catch {
      return null;
    }
  };

  // ── Lark OAuth (no auth) ──────────────────────────────────────────────────

  router.get('/lark/authorize-url', async (_req: Request, res: Response) => {
    try {
      if (!deps.larkOAuthService.isConfigured()) {
        res.status(503).json({ success: false, message: 'Lark OAuth not configured' });
        return;
      }

      const nonce = randomBytes(16).toString('hex');
      const state = signJwt(
        { kind: 'desktop_lark_login', nonce },
        deps.memberJwtSecret,
        600,
      );

      const redirectUri = `${deps.backendPublicUrl}/api/desktop/auth/lark/callback`;
      const authorizeUrl = deps.larkOAuthService.getAuthorizeUrl(state, { redirectUri });

      res.json({ success: true, data: { authorizeUrl, redirectUri, nonce } });
    } catch (e) {
      log.error('lark.authorize-url.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Failed to generate authorize URL' });
    }
  });

  router.get('/lark/callback', (req: Request, res: Response) => {
    const { code, state } = req.query;
    if (!code || !state) {
      res.status(400).send('<html><body><h2>Missing code or state</h2></body></html>');
      return;
    }

    const statePayload = verifyJwt(String(state), deps.memberJwtSecret);
    if (statePayload?.nonce) {
      pendingCallbacks.set(statePayload.nonce, {
        code: String(code),
        state: String(state),
        createdAt: Date.now(),
      });
    }

    res.send(`<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Divo authentication complete</title>
  </head>
  <body style="background:#111217;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
    <main style="width:min(420px,calc(100vw - 48px));border:1px solid rgba(255,255,255,.12);border-radius:18px;background:#181a22;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.45);text-align:center">
      <div style="width:44px;height:44px;border-radius:14px;background:linear-gradient(135deg,#2563eb,#7c3aed);display:grid;place-items:center;margin:0 auto 16px;font-weight:800">D</div>
      <h1 style="font-size:20px;line-height:1.25;margin:0 0 8px">Authentication complete</h1>
      <p style="font-size:14px;line-height:1.6;color:#a1a1aa;margin:0 0 18px">Return to Divo Desktop. This tab can be closed.</p>
      <button onclick="window.close()" style="border:1px solid rgba(255,255,255,.16);border-radius:10px;background:#f4f4f5;color:#111217;padding:10px 14px;font-weight:650;cursor:pointer">Close window</button>
      <p style="font-size:12px;color:#71717a;margin:18px 0 0">If it does not close automatically, close it manually.</p>
    </main>
    <script>setTimeout(() => window.close(), 2500);</script>
  </body>
</html>`);
  });

  router.get('/lark/poll', (req: Request, res: Response) => {
    const nonce = String(req.query.nonce ?? '');
    if (!nonce) {
      res.status(400).json({ success: false, message: 'nonce required' });
      return;
    }
    const pending = pendingCallbacks.get(nonce);
    if (!pending) {
      res.json({ success: false, pending: true });
      return;
    }
    pendingCallbacks.delete(nonce);
    res.json({ success: true, data: { code: pending.code, state: pending.state } });
  });

  router.post('/lark/exchange', async (req: Request, res: Response) => {
    try {
      const { code, state } = req.body as { code?: string; state?: string };
      log.info('lark.exchange.attempt', { hasCode: !!code, hasState: !!state, codeLen: code?.length, stateLen: state?.length });
      if (!code || !state) {
        log.warn('lark.exchange.missing_params', { code: !!code, state: !!state });
        res.status(400).json({ success: false, message: 'code and state are required' });
        return;
      }

      const payload = verifyJwt(state, deps.memberJwtSecret);
      if (!payload || payload.kind !== 'desktop_lark_login') {
        log.warn('lark.exchange.bad_state', { payloadKind: payload?.kind, hasPayload: !!payload });
        res.status(400).json({ success: false, message: 'Invalid or expired state token' });
        return;
      }

      const redirectUri = `${deps.backendPublicUrl}/api/desktop/auth/lark/callback`;
      const tokenBundle = await deps.larkOAuthService.exchangeCode(code, redirectUri);
      log.info('lark.exchange.token_bundle', {
        larkEmail: tokenBundle.larkEmail, larkName: tokenBundle.larkName,
        larkOpenId: tokenBundle.larkOpenId, tenantKey: tokenBundle.tenantKey,
      });

      const tenantKey = tokenBundle.tenantKey ?? '';

      const company = await deps.prisma.company.findFirst();
      if (!company) {
        res.status(500).json({ success: false, message: 'No company configured' });
        return;
      }
      const companyId = company.id;

      let email = (tokenBundle.larkEmail?.trim()) || null;

      let user: { id: string; email: string; name: string | null } | null = null;

      if (email) {
        user = await deps.prisma.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' as const } },
        });
      }

      if (!user && tokenBundle.larkOpenId) {
        const existingLink = await deps.prisma.larkUserAuthLink.findFirst({
          where: { larkOpenId: tokenBundle.larkOpenId, companyId, revokedAt: null },
          select: { userId: true },
        });
        if (existingLink) {
          user = await deps.prisma.user.findUnique({ where: { id: existingLink.userId } });
        }
      }

      if (!user) {
        if (!email) {
          log.warn('lark.exchange.email_missing', {
            larkOpenId: tokenBundle.larkOpenId,
            returnedScopes: tokenBundle.scope,
          });
          res.status(400).json({
            success: false,
            message: 'Lark did not return an email. Check that the Lark app has email scope enabled and published, then sign in again.',
          });
          return;
        }

        const userEmail = email;
        const hashedPassword = createHmac('sha256', deps.memberJwtSecret)
          .update(randomBytes(32)).digest('hex');
        user = await deps.prisma.user.create({
          data: { email: userEmail, name: tokenBundle.larkName ?? 'Lark User', password: hashedPassword },
        });
        log.info('lark.exchange.user_created', { userId: user.id, email: userEmail });
      }

      const membership = await deps.prisma.adminMembership.findFirst({
        where: { userId: user.id, companyId, isActive: true },
      });
      const role = membership?.role ?? 'MEMBER';
      if (!membership) {
        await deps.prisma.adminMembership.create({
          data: { userId: user.id, companyId, role: 'MEMBER', isActive: true },
        });
      }

      const accessExpiry = new Date(Date.now() + (tokenBundle.expiresIn ?? 7200) * 1000);
      const refreshExpiry = tokenBundle.refreshTokenExpiresIn
        ? new Date(Date.now() + tokenBundle.refreshTokenExpiresIn * 1000)
        : new Date(Date.now() + 30 * 24 * 3600 * 1000);

      const upsertResult = await deps.larkUserAuthLinkRepo.upsert({
        userId:    user.id,
        companyId,
        larkTenantKey: tenantKey,
        larkOpenId:    tokenBundle.larkOpenId,
        larkUserId:    tokenBundle.larkUserId ?? null,
        larkEmail:     email || user.email,
        larkName:      tokenBundle.larkName ?? null,
        accessToken:   tokenBundle.accessToken,
        refreshToken:  tokenBundle.refreshToken ?? '',
        tokenType:     tokenBundle.tokenType ?? 'Bearer',
        accessTokenExpiresAt:  accessExpiry,
        refreshTokenExpiresAt: refreshExpiry,
      });
      if (!upsertResult.ok) {
        log.error('lark.exchange.upsert_failed', { error: String(upsertResult.error) });
      }

      const session = await issueDesktopSession(deps, user.id, companyId, role, {
        authProvider:  'lark',
        larkTenantKey: tenantKey,
        larkOpenId:    tokenBundle.larkOpenId,
        larkUserId:    tokenBundle.larkUserId,
      });

      const departments = await deps.prisma.department.findMany({
        where: { companyId, memberships: { some: { userId: user.id } } },
        select: { id: true, name: true },
      });

      log.info('lark.exchange.success', { userId: user.id, email: user.email });

      res.json({
        success: true,
        data: {
          token: session.token,
          session: {
            ...session,
            authProvider: 'lark',
            email: user.email,
            name: user.name ?? email,
            larkTenantKey: tenantKey,
            larkOpenId:    tokenBundle.larkOpenId,
            larkUserId:    tokenBundle.larkUserId,
            avatarUrl:     tokenBundle.avatarUrl,
            departments,
          },
        },
        message: 'Desktop Lark session issued',
      });
    } catch (e) {
      log.error('lark.exchange.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  // ── Handoff exchange (no auth — code is credential) ──────────────────────

  router.post('/exchange', async (req: Request, res: Response) => {
    try {
      const { code } = req.body as { code?: string };
      if (!code) {
        res.status(400).json({ success: false, message: 'code is required' });
        return;
      }

      const handoff = await deps.prisma.desktopAuthHandoff.findUnique({ where: { code } });
      if (!handoff) {
        res.status(404).json({ success: false, message: 'Invalid handoff code' });
        return;
      }
      if (handoff.consumedAt) {
        res.status(409).json({ success: false, message: 'Handoff code already used' });
        return;
      }
      if (handoff.expiresAt.getTime() <= Date.now()) {
        res.status(410).json({ success: false, message: 'Handoff code has expired' });
        return;
      }

      await deps.prisma.desktopAuthHandoff.update({
        where: { id: handoff.id },
        data:  { consumedAt: new Date() },
      });

      const session = await issueDesktopSession(deps, handoff.userId, handoff.companyId, handoff.role, {
        authProvider: 'handoff',
      });

      const user = await deps.prisma.user.findUnique({ where: { id: handoff.userId } });

      res.json({
        success: true,
        data: {
          token: session.token,
          session: { ...session, authProvider: 'handoff', email: user?.email, name: user?.name },
        },
        message: 'Desktop session issued via handoff',
      });
    } catch (e) {
      log.error('exchange.handoff.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  // ── Protected routes (require member session) ────────────────────────────

  router.post('/handoff', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string) ?? 'MEMBER';

      const code = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);

      await deps.prisma.desktopAuthHandoff.create({
        data: { code, userId, companyId, role, expiresAt },
      });

      res.json({ success: true, data: { code, expiresAt: expiresAt.toISOString() } });
    } catch (e) {
      log.error('handoff.create.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/me', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;

      const user = await deps.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      });
      const departments = await deps.prisma.department.findMany({
        where: { companyId, memberships: { some: { userId } } },
        select: { id: true, name: true },
      });
      const larkLink = await deps.prisma.larkUserAuthLink.findFirst({
        where: { userId, companyId, revokedAt: null },
        select: { larkOpenId: true, larkUserId: true, larkEmail: true, larkName: true, larkTenantKey: true },
      });
      const googleConnections = await deps.connectionRepo.listAccessibleGoogleConnections({ userId, companyId });

      res.json({
        success: true,
        data: {
          userId, companyId,
          role: res.locals['aiRole'],
          email: user?.email,
          name:  user?.name,
          departments,
          lark:   larkLink ?? null,
          google: googleConnections.ok ? {
            connected:   googleConnections.value.length > 0,
            connections: googleConnections.value.map(connection => ({
              connectionId: connection.connectionId,
              label:        connection.label,
              accountEmail: connection.accountEmail ?? null,
              accountName:  connection.accountName ?? null,
              ownerType:    connection.ownerType,
              access:       connection.access,
            })),
          } : null,
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  /**
   * Desktop boot context. This intentionally stays outside gateway discovery:
   * it is fetched at session lifecycle boundaries and cached locally by Jan,
   * rather than fetched by Pi for each agent run.
   */
  router.get('/runtime-context', memberAuth, async (req: Request, res: Response) => {
    const parsed = runtimeContextQuerySchema.safeParse({
      departmentId: typeof req.query.departmentId === 'string'
        ? req.query.departmentId
        : undefined,
    });
    if (!parsed.success) {
      res.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? 'Invalid departmentId' });
      return;
    }

    const userId = res.locals['userId'] as string;
    const companyId = res.locals['companyId'] as string;
    const departmentId = parsed.data.departmentId;

    if (!departmentId) {
      res.json({
        success: true,
        data: {
          departmentId: null,
          departmentName: null,
          personaPrompt: '',
          version: null,
        },
      });
      return;
    }

    try {
      const membership = await deps.prisma.departmentMembership.findFirst({
        where: {
          userId,
          departmentId,
          status: 'active',
          department: { companyId, status: 'active' },
        },
        select: {
          department: {
            select: {
              id: true,
              name: true,
              slug: true,
              agentConfig: {
                select: {
                  desktopPersonaPrompt: true,
                  isActive: true,
                  updatedAt: true,
                },
              },
            },
          },
        },
      });

      if (!membership) {
        res.status(403).json({ success: false, message: 'Department access denied' });
        return;
      }

      const config = membership.department.agentConfig;
      const active = config?.isActive === true;
      let capabilityBootstrap;
      if (isFinanceDepartment(membership.department.name, membership.department.slug)) {
        try {
          const companyRole = String(res.locals['aiRole'] ?? 'MEMBER');
          const permissionResult = await deps.permissions.resolve({
            companyId: asCompanyId(companyId),
            userId: asUserId(userId),
            companyRole: asCompanyRoleSlug(companyRole),
            departmentId: asDepartmentId(membership.department.id),
            channel: 'desktop',
          });
          if (permissionResult.ok) {
            const [visibleSkills, zohoConnectionsResult] = await Promise.all([
              deps.skillCatalog.listVisible({
                companyId,
                departmentId: membership.department.id,
                permission: permissionResult.value,
              }),
              deps.connectionRepo.listAccessibleZohoConnections({ userId, companyId }),
            ]);
            capabilityBootstrap = buildDesktopCapabilityBootstrap({
              departmentName: membership.department.name,
              departmentSlug: membership.department.slug,
              companyRole,
              permission: permissionResult.value,
              visibleSkills,
              ...(zohoConnectionsResult.ok ? {
                zohoConnections: zohoConnectionsResult.value.map(connection => ({
                  connectionId: connection.connectionId,
                  label: connection.label,
                  access: connection.access,
                })),
              } : {}),
            });
          }
        } catch (error) {
          log.warn('runtime_context.capability_bootstrap_failed', {
            error: String(error), userId, companyId, departmentId,
          });
        }
      }
      res.json({
        success: true,
        data: {
          departmentId: membership.department.id,
          departmentName: membership.department.name,
          personaPrompt: active ? config.desktopPersonaPrompt : '',
          version: active ? config.updatedAt.toISOString() : null,
          ...(capabilityBootstrap ? { capabilityBootstrap } : {}),
        },
      });
    } catch (e) {
      log.error('runtime_context.read_failed', { error: String(e), userId, companyId, departmentId });
      res.status(500).json({ success: false, message: 'Could not load desktop runtime context' });
    }
  });

  router.get('/departments', memberAuth, async (_req: Request, res: Response) => {
    const userId    = res.locals['userId'] as string;
    const companyId = res.locals['companyId'] as string;
    const departments = await deps.prisma.department.findMany({
      where: { companyId, memberships: { some: { userId } } },
      select: { id: true, name: true },
    });
    res.json({ success: true, data: departments });
  });

  router.get('/google/authorize-url', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;

      const state = signJwt(
        { kind: 'desktop_google_connect', nonce: randomBytes(16).toString('hex'), userId, companyId },
        deps.memberJwtSecret,
        600,
      );

      const redirectUri = `${deps.backendPublicUrl}/api/desktop/auth/google/callback`;
      const authorizeUrl = deps.googleOAuthService.getAuthorizeUrl({ state, redirectUri });

      res.json({ success: true, data: { authorizeUrl } });
    } catch (e) {
      log.error('google.authorize-url.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/google/callback', async (req: Request, res: Response) => {
    try {
      const { code, state, error: oauthError } = req.query;

      if (oauthError) {
        res.send('<html><body><h2>Google connection cancelled</h2><p>You can close this window.</p></body></html>');
        return;
      }
      if (!code || !state) {
        res.status(400).send('<html><body><h2>Missing code or state</h2></body></html>');
        return;
      }

      const payload = verifyJwt(String(state), deps.memberJwtSecret);
      if (!payload || payload.kind !== 'desktop_google_connect' || !payload.userId || !payload.companyId) {
        res.status(400).send('<html><body><h2>Invalid or expired state</h2></body></html>');
        return;
      }

      const redirectUri = `${deps.backendPublicUrl}/api/desktop/auth/google/callback`;
      const tokenBundle = await deps.googleOAuthService.exchangeAuthorizationCode(String(code), redirectUri);
      const userInfo = await deps.googleOAuthService.fetchUserInfo(tokenBundle.accessToken);

      const expiresAt = tokenBundle.expiresIn
        ? new Date(Date.now() + tokenBundle.expiresIn * 1000)
        : new Date(Date.now() + 3600 * 1000);

      const upsertResult = await deps.connectionRepo.upsertGoogleConnection({
        companyId:  payload.companyId,
        ownerType: 'user',
        ownerUserId: payload.userId,
        createdBy: payload.userId,
        googleUserId: userInfo.sub,
        scope:        tokenBundle.scope ?? '',
        accessToken:  tokenBundle.accessToken,
        tokenType:    tokenBundle.tokenType ?? 'Bearer',
        accessTokenExpiresAt: expiresAt,
        initialAccess: 'admin',
        ...(userInfo.email ? { googleEmail: userInfo.email } : {}),
        ...(userInfo.name ? { googleName: userInfo.name } : {}),
        ...(tokenBundle.refreshToken ? { refreshToken: tokenBundle.refreshToken } : {}),
      });
      if (!upsertResult.ok) {
        log.error('google.callback.upsert_failed', { error: String(upsertResult.error) });
      }

      log.info('google.callback.success', { userId: payload.userId });

      res.send(`<!DOCTYPE html><html><body>
<h2>Google connected successfully!</h2>
<p>You can close this window and return to Divo Desktop.</p>
<script>setTimeout(()=>window.close(),3000);</script>
</body></html>`);
    } catch (e) {
      log.error('google.callback.error', { error: String(e) });
      res.send(`<html><body><h2>Google connection failed</h2><p>${String(e)}</p></body></html>`);
    }
  });

  router.get('/google/status', memberAuth, async (_req: Request, res: Response) => {
    const userId    = res.locals['userId'] as string;
    const companyId = res.locals['companyId'] as string;
    const connections = await deps.connectionRepo.listAccessibleGoogleConnections({ userId, companyId });
    if (!connections.ok) {
      res.status(500).json({ success: false, message: connections.error.message });
      return;
    }
    res.json({
      success: true,
      data: {
        connected: connections.value.length > 0,
        connections: connections.value.map(connection => ({
          connectionId: connection.connectionId,
          label:        connection.label,
          accountEmail: connection.accountEmail ?? null,
          accountName:  connection.accountName ?? null,
          ownerType:    connection.ownerType,
          access:       connection.access,
          scopes:       connection.scopes,
          connectedAt:  connection.connectedAt.toISOString(),
          lastUsedAt:   connection.lastUsedAt?.toISOString() ?? null,
        })),
      },
    });
  });

  router.get('/google/connections/:connectionId/manage', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      if (!connectionId) {
        res.status(400).json({ success: false, message: 'connectionId is required' });
        return;
      }

      const payload = await buildGoogleConnectionManagePayload(connectionId, userId, companyId, role);
      if (!payload) {
        res.status(404).json({ success: false, message: 'Google connection not found' });
        return;
      }
      if ('forbidden' in payload) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Google connection' });
        return;
      }
      res.json({ success: true, data: payload });
    } catch (e) {
      log.error('google.manage.read.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/google/connections/:connectionId/grants', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const body = req.body as { granteeType?: string; granteeId?: string; access?: string };

      const granteeType = body.granteeType?.trim();
      const granteeId = body.granteeId?.trim();
      const access = body.access?.trim();
      if (!connectionId || !granteeType || !granteeId || !access) {
        res.status(400).json({ success: false, message: 'connectionId, granteeType, granteeId, and access are required' });
        return;
      }
      if (!GOOGLE_GRANTEE_TYPES.has(granteeType) || !GOOGLE_GRANT_ACCESSES.has(access)) {
        res.status(400).json({ success: false, message: 'Invalid grantee type or access level' });
        return;
      }

      const manageable = await buildGoogleConnectionManagePayload(connectionId, userId, companyId, role);
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Google connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Google connection' });
        return;
      }

      const candidates = manageable.candidates;
      const isKnownGrantee =
        (granteeType === 'user' && candidates.users.some(candidate => candidate.id === granteeId)) ||
        (granteeType === 'department' && candidates.departments.some(candidate => candidate.id === granteeId)) ||
        (granteeType === 'role' && candidates.roles.some(candidate => candidate.id === granteeId)) ||
        (granteeType === 'company' && candidates.company?.id === granteeId);
      if (!isKnownGrantee) {
        res.status(400).json({ success: false, message: 'Selected grantee is not part of this company' });
        return;
      }

      const result = await deps.connectionRepo.grantConnection({
        companyId,
        connectionId,
        granteeType: granteeType as 'user' | 'department' | 'role' | 'company',
        granteeId,
        access: access as 'read_only' | 'read_write' | 'admin',
        grantedBy: userId,
      });
      if (!result.ok) {
        res.status(500).json({ success: false, message: result.error.message });
        return;
      }

      const payload = await buildGoogleConnectionManagePayload(connectionId, userId, companyId, role);
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('google.manage.grant.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/google/connections/:connectionId/grants/:grantId', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const grantId = String(req.params['grantId'] ?? '');
      if (!connectionId || !grantId) {
        res.status(400).json({ success: false, message: 'connectionId and grantId are required' });
        return;
      }

      const manageable = await buildGoogleConnectionManagePayload(connectionId, userId, companyId, role);
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Google connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Google connection' });
        return;
      }

      const result = await deps.connectionRepo.revokeConnectionGrant({ companyId, connectionId, grantId });
      if (!result.ok) {
        res.status(500).json({ success: false, message: result.error.message });
        return;
      }

      const payload = await buildGoogleConnectionManagePayload(connectionId, userId, companyId, role);
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('google.manage.revoke.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/zoho/authorize-url', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      if (!COMPANY_ADMIN_ROLES.has(role)) {
        res.status(403).json({ success: false, message: 'Only company admins can connect Zoho for the company' });
        return;
      }
      if (!deps.zohoTokenService.isConfigured()) {
        res.status(503).json({ success: false, message: 'Zoho OAuth not configured' });
        return;
      }

      const redirectUri = `${deps.backendPublicUrl}/api/desktop/auth/zoho/callback`;
      const authorizeConfig = await deps.zohoTokenService.getAuthorizeConfig(companyId);

      const state = signJwt(
        { kind: 'desktop_zoho_connect', nonce: randomBytes(16).toString('hex'), userId, companyId },
        deps.memberJwtSecret,
        600,
      );
      const authorizeUrl = new URL(`${authorizeConfig.accountsBaseUrl.replace(/\/$/, '')}/oauth/v2/auth`);
      authorizeUrl.searchParams.set('client_id', authorizeConfig.clientId);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('scope', DEFAULT_ZOHO_SCOPES.join(' '));
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('access_type', 'offline');
      authorizeUrl.searchParams.set('prompt', 'consent');
      authorizeUrl.searchParams.set('state', state);

      res.json({ success: true, data: { authorizeUrl: authorizeUrl.toString(), redirectUri } });
    } catch (e) {
      log.error('zoho.authorize-url.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/zoho/callback', async (req: Request, res: Response) => {
    try {
      const { code, state, error: oauthError } = req.query;
      if (oauthError) {
        res.send('<html><body><h2>Zoho connection cancelled</h2><p>You can close this window.</p></body></html>');
        return;
      }
      if (!code || !state) {
        res.status(400).send('<html><body><h2>Missing code or state</h2></body></html>');
        return;
      }

      const payload = verifyJwt(String(state), deps.memberJwtSecret);
      if (!payload || payload.kind !== 'desktop_zoho_connect' || !payload.userId || !payload.companyId) {
        res.status(400).send('<html><body><h2>Invalid or expired state</h2></body></html>');
        return;
      }

      const redirectUri = `${deps.backendPublicUrl}/api/desktop/auth/zoho/callback`;
      const tokens = await deps.zohoTokenService.exchangeAuthorizationCode({
        companyId:         payload.companyId,
        environment:       'prod',
        authorizationCode: String(code),
        redirectUri,
      });
      const apiBaseUrl = tokens.apiDomain ?? deps.env.ZOHO_API_BASE_URL;
      const accountSummary = await fetchZohoAccountSummary(tokens.accessToken, apiBaseUrl);
      const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

      const upsertResult = await deps.zohoConnectionRepo.upsertFromExchange({
        companyId:   payload.companyId,
        environment: 'prod',
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        expiresIn:   tokens.expiresIn,
        scopes:      tokens.scopes.length ? tokens.scopes : DEFAULT_ZOHO_SCOPES,
      });
      if (!upsertResult.ok) throw new Error(upsertResult.error.message);

      const integrationResult = await deps.connectionRepo.upsertZohoConnection({
        companyId:    payload.companyId,
        ownerType:    'user',
        ownerUserId:  payload.userId,
        createdBy:    payload.userId,
        label:        accountSummary?.accountName ? `${accountSummary.accountName} Zoho` : 'Zoho connection',
        ...(accountSummary?.accountName ? { accountName: accountSummary.accountName } : {}),
        externalAccountId: accountSummary?.externalAccountId ?? payload.userId,
        accessToken:  tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
        accessTokenExpiresAt: expiresAt,
        scopes: tokens.scopes.length ? tokens.scopes : DEFAULT_ZOHO_SCOPES,
        ...(tokens.apiDomain ? { apiDomain: tokens.apiDomain } : {}),
        accountsBaseUrl: deps.env.ZOHO_ACCOUNTS_BASE_URL,
        apiBaseUrl,
        environment: 'prod',
        initialAccess: 'admin',
      });
      if (!integrationResult.ok) throw new Error(integrationResult.error.message);

      log.info('zoho.callback.success', {
        userId: payload.userId,
        companyId: payload.companyId,
        connectionId: integrationResult.value.id,
      });
      res.send(`<!DOCTYPE html><html><body>
<h2>Zoho connected successfully!</h2>
<p>You can close this window and return to Divo Desktop.</p>
<script>setTimeout(()=>window.close(),3000);</script>
</body></html>`);
    } catch (e) {
      log.error('zoho.callback.error', { error: String(e) });
      res.send(`<html><body><h2>Zoho connection failed</h2><p>${String(e)}</p></body></html>`);
    }
  });

  router.get('/zoho/status', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connections = await deps.connectionRepo.listAccessibleZohoConnections({ userId, companyId });
      if (!connections.ok) {
        res.status(500).json({ success: false, message: connections.error.message });
        return;
      }
      const legacyRecord = await deps.prisma.zohoConnection.findUnique({
        where: {
          companyId_environment: { companyId, environment: 'prod' },
        },
        select: {
          id: true,
          environment: true,
          providerMode: true,
          status: true,
          connectedAt: true,
          scopes: true,
          lastSyncAt: true,
          accessTokenExpiresAt: true,
          tokenFailureCode: true,
        },
      });
      const legacyConnected = Boolean(legacyRecord && legacyRecord.status === 'CONNECTED');
      res.json({
        success: true,
        data: {
          connected: connections.value.length > 0 || legacyConnected,
          canManage: COMPANY_ADMIN_ROLES.has(role),
          connections: connections.value.map(connection => ({
            connectionId: connection.connectionId,
            label:        connection.label,
            accountEmail: connection.accountEmail ?? null,
            accountName:  connection.accountName ?? null,
            ownerType:    connection.ownerType,
            access:       connection.access,
            scopes:       connection.scopes,
            connectedAt:  connection.connectedAt.toISOString(),
            lastUsedAt:   connection.lastUsedAt?.toISOString() ?? null,
          })),
          legacyConnection: legacyRecord ? {
            connectionId: legacyRecord.id,
            environment: legacyRecord.environment,
            providerMode: legacyRecord.providerMode,
            status: legacyRecord.status,
            scopes: legacyRecord.scopes,
            connectedAt: legacyRecord.connectedAt.toISOString(),
            lastSyncAt: legacyRecord.lastSyncAt?.toISOString() ?? null,
            accessTokenExpiresAt: legacyRecord.accessTokenExpiresAt?.toISOString() ?? null,
            tokenFailureCode: legacyRecord.tokenFailureCode ?? null,
          } : null,
        },
      });
    } catch (e) {
      log.error('zoho.status.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/zoho/connections/:connectionId/manage', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      if (!connectionId) {
        res.status(400).json({ success: false, message: 'connectionId is required' });
        return;
      }

      const payload = await buildGoogleConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
      if (!payload) {
        res.status(404).json({ success: false, message: 'Zoho connection not found' });
        return;
      }
      if ('forbidden' in payload) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Zoho connection' });
        return;
      }
      res.json({ success: true, data: payload });
    } catch (e) {
      log.error('zoho.manage.read.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/zoho/connections/:connectionId/grants', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const body = req.body as { granteeType?: string; granteeId?: string; access?: string };

      const granteeType = body.granteeType?.trim();
      const granteeId = body.granteeId?.trim();
      const access = body.access?.trim();
      if (!connectionId || !granteeType || !granteeId || !access) {
        res.status(400).json({ success: false, message: 'connectionId, granteeType, granteeId, and access are required' });
        return;
      }
      if (!GOOGLE_GRANTEE_TYPES.has(granteeType) || !GOOGLE_GRANT_ACCESSES.has(access)) {
        res.status(400).json({ success: false, message: 'Invalid grantee type or access level' });
        return;
      }

      const manageable = await buildGoogleConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Zoho connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Zoho connection' });
        return;
      }

      const candidates = manageable.candidates;
      const isKnownGrantee =
        (granteeType === 'user' && candidates.users.some(candidate => candidate.id === granteeId)) ||
        (granteeType === 'department' && candidates.departments.some(candidate => candidate.id === granteeId)) ||
        (granteeType === 'role' && candidates.roles.some(candidate => candidate.id === granteeId)) ||
        (granteeType === 'company' && candidates.company?.id === granteeId);
      if (!isKnownGrantee) {
        res.status(400).json({ success: false, message: 'Selected grantee is not part of this company' });
        return;
      }

      const result = await deps.connectionRepo.grantConnection({
        companyId,
        connectionId,
        granteeType: granteeType as 'user' | 'department' | 'role' | 'company',
        granteeId,
        access: access as 'read_only' | 'read_write' | 'admin',
        grantedBy: userId,
      });
      if (!result.ok) {
        res.status(500).json({ success: false, message: result.error.message });
        return;
      }

      const payload = await buildGoogleConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('zoho.manage.grant.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/zoho/connections/:connectionId/grants/:grantId', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const grantId = String(req.params['grantId'] ?? '');
      if (!connectionId || !grantId) {
        res.status(400).json({ success: false, message: 'connectionId and grantId are required' });
        return;
      }

      const manageable = await buildGoogleConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Zoho connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Zoho connection' });
        return;
      }

      const result = await deps.connectionRepo.revokeConnectionGrant({ companyId, connectionId, grantId });
      if (!result.ok) {
        res.status(500).json({ success: false, message: result.error.message });
        return;
      }

      const payload = await buildGoogleConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('zoho.manage.revoke.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/zoho/unlink', memberAuth, async (_req: Request, res: Response) => {
    try {
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      if (!COMPANY_ADMIN_ROLES.has(role)) {
        res.status(403).json({ success: false, message: 'Only company admins can disconnect Zoho' });
        return;
      }
      await deps.prisma.zohoConnection.updateMany({
        where: { companyId, environment: 'prod', status: 'CONNECTED' },
        data:  { status: 'REVOKED', tokenFailureCode: null },
      });
      await deps.prisma.integrationConnection.updateMany({
        where: { companyId, provider: 'zoho', status: 'connected', revokedAt: null },
        data:  { status: 'revoked', revokedAt: new Date() },
      });
      res.json({ success: true, message: 'Zoho disconnected' });
    } catch (e) {
      log.error('zoho.unlink.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/usage', memberAuth, async (_req: Request, res: Response) => {
    const userId    = res.locals['userId'] as string;
    const companyId = res.locals['companyId'] as string;
    const executions = await deps.prisma.executionRun.count({ where: { companyId, userId } });
    const tokenUsage = await deps.prisma.aiTokenUsage.aggregate({
      where: { companyId, userId },
      _sum: { estimatedInputTokens: true, estimatedOutputTokens: true },
    });
    res.json({
      success: true,
      data: {
        totalExecutions:   executions,
        totalInputTokens:  tokenUsage._sum.estimatedInputTokens ?? 0,
        totalOutputTokens: tokenUsage._sum.estimatedOutputTokens ?? 0,
      },
    });
  });

  router.post('/logout', memberAuth, async (req: Request, res: Response) => {
    try {
      const token = req.headers['authorization']?.slice(7) ?? '';
      const jwtPayload = verifyJwt(token, deps.memberJwtSecret);
      if (jwtPayload?.sessionId) {
        await deps.prisma.memberSession.update({
          where: { sessionId: String(jwtPayload.sessionId) },
          data:  { revokedAt: new Date() },
        });
      }
      res.json({ success: true, message: 'Session revoked' });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/lark/unlink', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      await deps.prisma.larkUserAuthLink.updateMany({
        where: { userId, companyId, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      res.json({ success: true, message: 'Lark account unlinked' });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/google/unlink', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      await deps.connectionRepo.revokeGoogleConnectionsForUser(companyId, userId);
      res.json({ success: true, message: 'Google account unlinked' });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  return router;
}
