import { Router, type Request, type Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import type { LarkOAuthService } from '../../infrastructure/lark/lark-oauth.service';
import type { GoogleOAuthService } from '../../infrastructure/google/google-oauth.service';
import type { CanvaMcpOAuthService } from '../../infrastructure/canva/canva-mcp-oauth.service';
import type { AirtableMcpOAuthService } from '../../infrastructure/airtable/airtable-mcp-oauth.service';
import type { ZohoTokenService } from '../../infrastructure/zoho/zoho-token.service';
import type { ZohoConnectionRepository } from '../../infrastructure/zoho/zoho-connection.repository';
import { apiKeyFingerprint, CONNECTION_NEEDS_KEY, type IntegrationConnectionRepository } from '../../infrastructure/persistence/integration-connection.repository';
import type { AitableKeyVerifier } from '../../application/aitable/aitable-connect.service';
import { AIRTABLE_REQUESTED_SCOPES, AIRTABLE_SCOPE } from '../../application/airtable/airtable-mcp-manifest';
import type { Logger } from '../../shared/logger';
import type { TypedEnv } from '../../config/env';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';
import { parseCallbackOriginAllowlist, requestHost, resolveCallbackOrigin } from './callback-origin';
import type { PermissionService } from '../../application/permissions/permission.service';
import type { SkillCatalogService } from '../../application/skills/skill-catalog.service';
import type { SkillAccessEnforcementPort } from '../../application/skills/skill-access.port';
import type { ManagerPersonaRuntimeService } from '../../application/persona-learning/manager-persona-runtime.service';
import { buildDesktopCapabilityBootstrap, isFinanceDepartment } from '../../application/desktop/desktop-capability-bootstrap';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import {
  connectionGovernancePolicySchema,
  defaultConnectionGovernancePolicy,
  parseConnectionGovernancePolicy,
} from '../../application/governance/connection-governance.policy';
import {
  configureDataExportProfile,
  getDataExportProfile,
} from '../../application/data-export/data-export.profile';

export interface DesktopAuthRoutesDeps {
  prisma:                 PrismaClient;
  larkOAuthService:       LarkOAuthService;
  googleOAuthService:     GoogleOAuthService;
  canvaMcpOAuthService:   CanvaMcpOAuthService;
  airtableMcpOAuthService: AirtableMcpOAuthService;
  /** Proves a pasted AITable key before it is stored. AITable has no OAuth. */
  aitableKeyVerifier:     AitableKeyVerifier;
  zohoTokenService:       ZohoTokenService;
  zohoConnectionRepo:     ZohoConnectionRepository;
  connectionRepo:         IntegrationConnectionRepository;
  permissions:            PermissionService;
  skillCatalog:           SkillCatalogService;
  skillAccessEnforcement: SkillAccessEnforcementPort;
  managerPersonaRuntime:  ManagerPersonaRuntimeService;
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
  label?: string;
  sessionId?: string;
  /** Exact OAuth callback used to mint this signed state. */
  redirectUri?: string;
  exp?: number;
}

const require = createRequire(__filename);
const bcrypt = require('bcryptjs') as {
  compare(input: string, hashed: string): Promise<boolean>;
};

/**
 * A Lark-provisioned user is created with an HMAC digest in `password` rather
 * than a bcrypt hash, because that account has no password to speak of
 * (see the `lark.exchange.user_created` path below). bcryptjs is not obliged to
 * fail cleanly on a hash it cannot parse, so the shape is checked here instead
 * of relying on `compare` to return false for it.
 */
const isBcryptHash = (value: string): boolean => /^\$2[aby]?\$\d{2}\$/.test(value);

const loginSchema = z.object({
  email:     z.string().email(),
  password:  z.string().min(1),
  companyId: z.string().uuid().optional(),
});

const DESKTOP_PROTOCOL = 'cursorr';
const HANDOFF_TTL_MS   = 5 * 60 * 1000;
const CONNECTION_GRANT_ACCESSES = new Set(['read_only', 'read_write', 'admin']);
/** Providers whose connections expose the shared manage/grant/disconnect surface. */
const MANAGEABLE_CONNECTION_PROVIDERS = ['google_workspace', 'zoho', 'canva', 'airtable', 'aitable', 'lark'] as const;
/** Statuses whose grants and governance are still worth showing and editing. */
const MANAGEABLE_STATUSES = ['connected', CONNECTION_NEEDS_KEY];
type ManageableConnectionProvider = typeof MANAGEABLE_CONNECTION_PROVIDERS[number];

function isManageableConnectionProvider(value: string): value is ManageableConnectionProvider {
  return (MANAGEABLE_CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

const CONNECTION_GRANTEE_TYPES = new Set(['user', 'department', 'role', 'company']);
const COMPANY_ADMIN_ROLES = new Set(['COMPANY_ADMIN', 'SUPER_ADMIN']);
const AIRTABLE_PAT_SCOPE_PRESETS = {
  read_only: [
    AIRTABLE_SCOPE.recordsRead,
    AIRTABLE_SCOPE.commentsRead,
    AIRTABLE_SCOPE.schemaRead,
    AIRTABLE_SCOPE.workspacesRead,
  ],
  read_write: [...AIRTABLE_REQUESTED_SCOPES],
} as const;

type AirtablePatAccessMode = keyof typeof AIRTABLE_PAT_SCOPE_PRESETS;
type AirtablePatCheck =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: 'empty' | 'rejected' | 'unreachable'; readonly message: string };

async function verifyAirtablePatIdentity(personalAccessToken: string): Promise<AirtablePatCheck> {
  const token = personalAccessToken.trim();
  if (!token) {
    return { ok: false, reason: 'empty', message: 'Enter an Airtable personal access token.' };
  }
  try {
    const response = await fetch('https://api.airtable.com/v0/meta/whoami', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: 'rejected',
        message: 'Airtable rejected this personal access token. Check that it was copied whole and is still active.',
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: 'unreachable',
        message: 'Could not verify this token with Airtable. The token was not saved — try again in a moment.',
      };
    }
    const identity = await response.json() as { id?: unknown };
    if (typeof identity.id !== 'string' || !identity.id.trim()) {
      return {
        ok: false,
        reason: 'unreachable',
        message: 'Airtable returned an unexpected token identity response. The token was not saved.',
      };
    }
    return { ok: true, userId: identity.id.trim() };
  } catch {
    return {
      ok: false,
      reason: 'unreachable',
      message: 'Could not reach Airtable to verify this token. The token was not saved.',
    };
  }
}

const DEFAULT_ZOHO_SCOPES = [
  'ZohoCRM.modules.ALL',
  'ZohoCRM.settings.ALL',
  'ZohoBooks.fullaccess.all',
  'ZohoBooks.contacts.all',
  'ZohoBooks.invoices.all',
  'ZohoBooks.expenses.all',
];
const ZOHO_SELF_CLIENT_READ_SCOPES = [
  'ZohoCRM.modules.READ',
  'ZohoCRM.settings.READ',
  'ZohoBooks.fullaccess.READ',
];
const ZOHO_DATA_CENTRES = {
  'https://accounts.zoho.com':     'https://www.zohoapis.com',
  'https://accounts.zoho.eu':      'https://www.zohoapis.eu',
  'https://accounts.zoho.in':      'https://www.zohoapis.in',
  'https://accounts.zoho.com.au':  'https://www.zohoapis.com.au',
  'https://accounts.zoho.jp':      'https://www.zohoapis.jp',
  'https://accounts.zohocloud.ca': 'https://www.zohoapis.ca',
  'https://accounts.zoho.sa':      'https://www.zohoapis.sa',
  'https://accounts.zoho.uk':      'https://www.zohoapis.uk',
} as const;
const zohoSelfClientSchema = z.object({
  label:           z.string().trim().max(120).optional(),
  clientId:        z.string().trim().min(8).max(255),
  clientSecret:    z.string().trim().min(8).max(512),
  grantToken:      z.string().trim().min(8).max(4096),
  accountsBaseUrl: z.enum(Object.keys(ZOHO_DATA_CENTRES) as [keyof typeof ZOHO_DATA_CENTRES, ...(keyof typeof ZOHO_DATA_CENTRES)[]]),
});

const runtimeContextQuerySchema = z.object({
  departmentId: z.string().uuid().optional(),
  capabilityVersion: z.literal('3').optional(),
});

const connectionManagerGovernanceUpdateSchema = z.object({
  managerPolicy: connectionGovernancePolicySchema,
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

function isSyntheticLarkIdentityEmail(email: string): boolean {
  return email.toLowerCase().endsWith('@identity.divo.invalid');
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
    allowPiRuntimeLease: req =>
      req.method === 'GET'
      && (req.path === '/me' || req.path === '/runtime-context'),
  });

  const callbackAllowlist = parseCallbackOriginAllowlist(deps.env?.BACKEND_PUBLIC_URL_ALLOWLIST);

  /**
   * Build a callback URL on the backend origin the Desktop actually signed in
   * against. Falling back is legal but almost always a misconfiguration — the
   * user would finish OAuth on a backend they did not choose — so it is logged
   * rather than left silent.
   */
  const desktopCallbackUri = (req: Request, callbackPath: string): string => {
    const host = requestHost(req.headers);
    const resolved = resolveCallbackOrigin({
      host,
      protocol:    req.protocol,
      allowlist:   callbackAllowlist,
      fallbackUrl: deps.backendPublicUrl,
    });
    if (resolved.source === 'fallback' && host) {
      log.warn('desktop.callback.host_not_allowlisted', {
        requestHost: host,
        usedOrigin:  resolved.origin,
        hint:        'Add this origin to BACKEND_PUBLIC_URL_ALLOWLIST if it is a real backend.',
      });
    }
    return `${resolved.origin}${callbackPath}`;
  };

  const buildConnectionManagePayload = async (
    connectionId: string,
    userId: string,
    companyId: string,
    role: string,
    provider: ManageableConnectionProvider = 'google_workspace',
  ) => {
    // Exhaustive lookup rather than a ternary chain: a new provider must be
    // added here or the build fails, instead of quietly listing Google accounts.
    const listAccessibleByProvider: Record<
      ManageableConnectionProvider,
      () => ReturnType<typeof deps.connectionRepo.listAccessibleGoogleConnections>
    > = {
      google_workspace: () => deps.connectionRepo.listAccessibleGoogleConnections({ userId, companyId }),
      zoho:             () => deps.connectionRepo.listAccessibleZohoConnections({ userId, companyId }),
      canva:            () => deps.connectionRepo.listAccessibleCanvaConnections({ userId, companyId }),
      airtable:         () => deps.connectionRepo.listAccessibleAirtableConnections({ userId, companyId }),
      aitable:          () => deps.connectionRepo.listAccessibleAitableConnections({ userId, companyId }),
      lark:             () => deps.connectionRepo.listAccessibleLarkConnections({ userId, companyId }),
    };
    const accessible = await listAccessibleByProvider[provider]();
    if (!accessible.ok) throw new Error(accessible.error.message);
    const summary = accessible.value.find(connection => connection.connectionId === connectionId);

    const connection = await deps.prisma.integrationConnection.findFirst({
      where: {
        id:        connectionId,
        companyId,
        provider,
        revokedAt: null,
        // AITable is the only provider that can hold a listed-but-unusable
        // connection. Restricting this to 'connected' made the manage view
        // 404 for exactly the connection an admin is being told to repair.
        status:    provider === 'aitable' ? { in: MANAGEABLE_STATUSES } : 'connected',
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
        governance: {
          select: {
            managerPolicyJson: true,
            managerConfiguredBy: true,
            managerConfiguredAt: true,
            adminOverrideJson: true,
            adminOverriddenBy: true,
            adminOverriddenAt: true,
            version: true,
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
    const tokenMetadata = connection.tokenMetadata
      && typeof connection.tokenMetadata === 'object'
      && !Array.isArray(connection.tokenMetadata)
      ? connection.tokenMetadata as Record<string, unknown>
      : {};
    const zohoReadOnlyEnforced = provider === 'zoho'
      && (
        tokenMetadata['enforcedAccess'] === 'read_only'
        || (connection.scopes.length > 0 && connection.scopes.every(scope => /\.READ$/i.test(scope)))
      );

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
        readOnlyEnforced: zohoReadOnlyEnforced,
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
      accessLevels: zohoReadOnlyEnforced
        ? [{
            value: 'read_only',
            label: 'Read-only',
            description: 'Can read Zoho CRM and Books data allowed by Zoho scopes.',
          }]
        : [
        {
          value: 'read_only',
          label: 'Read-only',
          description: provider === 'zoho'
            ? 'Can read Zoho CRM and Books data allowed by Zoho scopes.'
            : provider === 'lark'
              ? 'Can read Lark data allowed by this connection’s scopes.'
            : 'Can read connected Google Workspace data allowed by Google scopes.',
        },
        {
          value: 'read_write',
          label: 'Read/write',
          description: provider === 'zoho'
            ? 'Can read plus create, update, send, or delete through approved Zoho tools.'
            : provider === 'lark'
              ? 'Can read plus create, update, send, or delete through approved Lark tools.'
            : 'Can read plus create, update, send, or delete through approved Google tools.',
        },
        { value: 'admin', label: 'Admin', description: 'Can use the connection and manage who else has access.' },
      ],
      governance: {
        managerPolicy: connection.governance?.managerPolicyJson
          ? parseConnectionGovernancePolicy(connection.governance.managerPolicyJson)
          : defaultConnectionGovernancePolicy(),
        managerConfiguredAt: connection.governance?.managerConfiguredAt?.toISOString() ?? null,
        adminOverride: connection.governance?.adminOverrideJson
          ? parseConnectionGovernancePolicy(connection.governance.adminOverrideJson)
          : null,
        adminOverriddenAt: connection.governance?.adminOverriddenAt?.toISOString() ?? null,
        source: connection.governance?.adminOverrideJson
          ? 'company_admin_override'
          : connection.governance?.managerPolicyJson
            ? 'manager_policy'
            : 'platform_default',
        version: connection.governance?.version ?? 0,
      },
    };
  };

  /**
   * Connection owners and connection admins set the baseline operating policy
   * for the connection they administer. Company admins retain a separate,
   * higher-precedence override through the admin API.
   */
  router.put('/connections/:connectionId/governance', memberAuth, async (req: Request, res: Response) => {
    try {
      const connectionId = String(req.params['connectionId'] ?? '');
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const parsed = connectionManagerGovernanceUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? 'Invalid connection policy' });
        return;
      }

      const connection = await deps.prisma.integrationConnection.findFirst({
        where: { id: connectionId, companyId, revokedAt: null, status: 'connected' },
        select: { provider: true },
      });
      if (!connection || !isManageableConnectionProvider(connection.provider)) {
        res.status(404).json({ success: false, message: 'Connection not found' });
        return;
      }

      const manageable = await buildConnectionManagePayload(
        connectionId,
        userId,
        companyId,
        role,
        connection.provider,
      );
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this connection' });
        return;
      }

      const governance = await deps.prisma.integrationConnectionGovernance.upsert({
        where: { connectionId },
        create: {
          companyId,
          connectionId,
          managerPolicyJson: parsed.data.managerPolicy as Prisma.InputJsonValue,
          managerConfiguredBy: userId,
          managerConfiguredAt: new Date(),
        },
        update: {
          managerPolicyJson: parsed.data.managerPolicy as Prisma.InputJsonValue,
          managerConfiguredBy: userId,
          managerConfiguredAt: new Date(),
          version: { increment: 1 },
        },
        select: {
          managerPolicyJson: true,
          managerConfiguredAt: true,
          adminOverrideJson: true,
          adminOverriddenAt: true,
          version: true,
        },
      });
      log.info('connection.manager_governance.updated', { companyId, connectionId, userId, version: governance.version });
      res.json({
        success: true,
        data: {
          managerPolicy: parseConnectionGovernancePolicy(governance.managerPolicyJson),
          managerConfiguredAt: governance.managerConfiguredAt?.toISOString() ?? null,
          adminOverride: governance.adminOverrideJson ? parseConnectionGovernancePolicy(governance.adminOverrideJson) : null,
          adminOverriddenAt: governance.adminOverriddenAt?.toISOString() ?? null,
          source: governance.adminOverrideJson ? 'company_admin_override' : 'manager_policy',
          version: governance.version,
        },
      });
    } catch (e) {
      log.error('connection.manager_governance.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Could not save connection operating controls' });
    }
  });

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

  router.get('/lark/authorize-url', async (req: Request, res: Response) => {
    try {
      if (!deps.larkOAuthService.isConfigured()) {
        res.status(503).json({ success: false, message: 'Lark OAuth not configured' });
        return;
      }

      const nonce = randomBytes(16).toString('hex');
      const redirectUri = desktopCallbackUri(req, '/api/desktop/auth/lark/callback');
      const state = signJwt(
        { kind: 'desktop_lark_login', nonce, redirectUri },
        deps.memberJwtSecret,
        600,
      );

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
      <p style="font-size:14px;line-height:1.6;color:#a1a1aa;margin:0 0 18px">Return to Divo. This tab can be closed.</p>
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

      const redirectUri = payload.redirectUri
        ?? `${deps.backendPublicUrl.replace(/\/+$/, '')}/api/desktop/auth/lark/callback`;
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
        const existingConnection = await deps.connectionRepo.findLarkConnectionOwner({
          larkOpenId: tokenBundle.larkOpenId,
          companyId,
        });
        if (existingConnection.ok && existingConnection.value) {
          user = await deps.prisma.user.findUnique({ where: { id: existingConnection.value.userId } });
        }
      }

      // Older builds created placeholder users when Lark omitted email. Those
      // records are not proof of a Divo identity and must never silently turn a
      // company admin into a fresh Member. A real, pre-linked Divo owner remains
      // valid even when Lark does not return email on a later refresh/login.
      if (!email && user && isSyntheticLarkIdentityEmail(user.email)) {
        log.warn('lark.exchange.synthetic_identity_rejected', {
          userId: user.id,
          larkOpenId: tokenBundle.larkOpenId,
        });
        user = null;
      }

      if (!user) {
        if (!email) {
          log.warn('lark.exchange.email_missing', {
            larkOpenId: tokenBundle.larkOpenId,
            returnedScopes: tokenBundle.scope,
          });
          res.status(400).json({
            success: false,
            message: 'Lark did not return an email. Confirm contact:contact.base:readonly, contact:user.email:readonly, and contact:user.employee:readonly are enabled and published, and that the Lark profile has a work email.',
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

      // A Lark sign-in is also a company-managed Lark connection. The generic
      // registry is the only token and sharing authority.
      if (tokenBundle.larkOpenId) {
        const connectionResult = await deps.connectionRepo.upsertLarkConnection({
          companyId,
          ownerType: 'user',
          ownerUserId: user.id,
          createdBy: user.id,
          larkOpenId: tokenBundle.larkOpenId,
          larkUserId: tokenBundle.larkUserId,
          larkTenantKey: tokenBundle.tenantKey,
          larkEmail: email,
          larkName: tokenBundle.larkName,
          accessToken: tokenBundle.accessToken,
          refreshToken: tokenBundle.refreshToken,
          tokenType: tokenBundle.tokenType,
          accessTokenExpiresAt: accessExpiry,
          refreshTokenExpiresAt: refreshExpiry,
          scopes: tokenBundle.scope?.split(/\s+/).filter(Boolean) ?? [],
          initialAccess: 'admin',
        });
        if (!connectionResult.ok) {
          log.error('lark.exchange.connection_upsert_failed', { error: String(connectionResult.error) });
        }
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

  // ── Password sign-in (no auth — the credential is the body) ──────────────

  /**
   * The fallback half of the single sign-in page. Lark OAuth is the primary
   * route and the only one that produces a session Lark chat can use; this
   * exists for super admins outside the customer's Lark tenant and for members
   * who set a password when they accepted an email invite.
   *
   * A session minted here carries no Lark identity, so it deliberately does not
   * satisfy the runtime lookup — that person's chat stays dark until they link
   * Lark once, which is the honest outcome rather than a half-working one.
   */
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: 'email and password are required' });
        return;
      }
      const payload = parsed.data;

      const user = await deps.prisma.user.findUnique({ where: { email: payload.email } });
      // One failure message for "no such account" and "wrong password" alike, so
      // this route cannot be used to enumerate who has a Divo account.
      const invalid = () => res.status(401).json({ success: false, message: 'Invalid email or password' });

      if (!user || !isBcryptHash(user.password) || !(await bcrypt.compare(payload.password, user.password))) {
        log.warn('desktop.login.rejected', { email: payload.email });
        invalid();
        return;
      }

      const membership = await deps.prisma.adminMembership.findFirst({
        where: {
          userId:   user.id,
          isActive: true,
          ...(payload.companyId ? { companyId: payload.companyId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        select: { companyId: true, role: true },
      });
      // A super admin's membership can carry no company at all, and a session
      // has to belong to one — so this is "no workspace", not a bad password.
      const companyId = membership?.companyId;
      if (!membership || !companyId) {
        // Credentials were right, so this is not an enumeration risk — and the
        // person needs to know the account is real but has no active workspace.
        res.status(403).json({ success: false, message: 'This account has no active workspace membership' });
        return;
      }

      const session = await issueDesktopSession(deps, user.id, companyId, membership.role, {
        authProvider: 'password',
      });

      const departments = await deps.prisma.department.findMany({
        where:  { companyId, memberships: { some: { userId: user.id } } },
        select: { id: true, name: true },
      });

      log.info('desktop.login.ok', { userId: user.id, companyId });

      res.json({
        success: true,
        data: {
          token: session.token,
          session: {
            ...session,
            authProvider: 'password',
            email: user.email,
            name:  user.name ?? user.email,
            // No Lark identity on a password session. The client reads this to
            // tell the person their chat will not work until they link Lark.
            larkTenantKey: null,
            larkOpenId:    null,
            departments,
          },
        },
        message: 'Session issued',
      });
    } catch (e) {
      log.error('desktop.login.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Sign-in failed' });
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
      const company = await deps.prisma.company.findUnique({
        where: { id: companyId },
        select: { name: true },
      });
      // The department role travels with the membership, because it is what
      // decides whether this person sees a Team scope at all. Company role is
      // the ceiling; leading a department is a separate axis, and the web shell
      // cannot derive one from the other.
      const memberships = await deps.prisma.departmentMembership.findMany({
        where:  { userId, status: 'active', department: { companyId } },
        select: {
          department: { select: { id: true, name: true } },
          role:       { select: { slug: true, name: true } },
        },
      });
      const departments = memberships.map(m => ({
        id:       m.department.id,
        name:     m.department.name,
        roleSlug: m.role.slug,
        roleName: m.role.name,
        // Slug is the stable identifier; DepartmentRole.name is user-editable.
        isManager: m.role.slug === 'MANAGER',
      }));
      const larkConnections = await deps.connectionRepo.listAccessibleLarkConnections({ userId, companyId });
      const googleConnections = await deps.connectionRepo.listAccessibleGoogleConnections({ userId, companyId });

      res.json({
        success: true,
        data: {
          userId, companyId,
          companyName: company?.name ?? null,
          role: res.locals['aiRole'],
          runtime: res.locals['channel'] === 'lark'
            ? {
                channel: 'lark',
                instanceId: res.locals['runtimeInstanceId'],
                threadId: res.locals['runtimeThreadId'],
                departmentId: res.locals['runtimeDepartmentId'] ?? null,
              }
            : null,
          email: user?.email,
          name:  user?.name,
          departments,
          lark: larkConnections.ok ? {
            connected: larkConnections.value.length > 0,
            connections: larkConnections.value.map(connection => ({
              connectionId: connection.connectionId,
              label: connection.label,
              accountEmail: connection.accountEmail ?? null,
              accountName: connection.accountName ?? null,
              ownerType: connection.ownerType,
              access: connection.access,
              scopes: connection.scopes,
            })),
          } : null,
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
   * The LLM models this member is allowed to use through the proxy. Drives the
   * desktop model toggle: the client shows a switch only when more than one
   * model is returned. Defaults to Flash-only when no policy is set, mirroring
   * the proxy gate. The proxy remains authoritative — this is a UI hint.
   */
  router.get('/model-options', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const policy = await deps.prisma.memberProxyPolicy.findUnique({
        where: { userId },
        select: { allowedModels: true, blocked: true },
      });
      const allowedModels =
        policy && policy.allowedModels.length > 0 ? policy.allowedModels : ['deepseek-v4-flash'];
      res.json({
        success: true,
        data: { allowedModels, blocked: policy?.blocked ?? false },
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
      capabilityVersion: typeof req.query.capabilityVersion === 'string'
        ? req.query.capabilityVersion
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
      let managerPersonaPrompt = '';
      let managerPersonaVersion: string | null = null;
      try {
        const brief = await deps.managerPersonaRuntime.getDepartmentBrief({
          companyId,
          departmentId: membership.department.id,
        });
        managerPersonaPrompt = brief?.prompt ?? '';
        managerPersonaVersion = brief?.version ?? null;
      } catch (error) {
        // Runtime delivery is advisory. A read failure must not break desktop
        // login, membership checks, or the normal department persona.
        log.warn('runtime_context.manager_persona_failed', {
          error: String(error), userId, companyId, departmentId,
        });
      }
      let capabilityBootstrap;
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
          const finance = isFinanceDepartment(membership.department.name, membership.department.slug);
          const [grantedSkillIds, registryRevision, zohoConnectionsResult] = await Promise.all([
            deps.skillAccessEnforcement.listGrantedSkillIds(companyId, userId),
            deps.skillCatalog.registryRevision(companyId),
            finance
              ? deps.connectionRepo.listAccessibleZohoConnections({ userId, companyId })
              : Promise.resolve(null),
          ]);
          const visibleSkills = await deps.skillCatalog.listVisible({
            companyId,
            departmentId: membership.department.id,
            permission: permissionResult.value,
            grantedSkillIds,
            limit: 50,
          });
          const builtBootstrap = buildDesktopCapabilityBootstrap({
            departmentName: membership.department.name,
            departmentSlug: membership.department.slug,
            companyRole,
            permission: permissionResult.value,
            visibleSkills,
            registryRevision,
            ...(zohoConnectionsResult?.ok ? {
              zohoConnections: zohoConnectionsResult.value.map(connection => ({
                connectionId: connection.connectionId,
                label: connection.label,
                access: connection.access,
              })),
            } : {}),
          });
          if (parsed.data.capabilityVersion === '3') {
            capabilityBootstrap = builtBootstrap;
          } else {
            const { families, ...legacyBootstrap } = builtBootstrap;
            void families;
            capabilityBootstrap = { ...legacyBootstrap, version: 2 };
          }
        }
      } catch (error) {
        log.warn('runtime_context.capability_bootstrap_failed', {
          error: String(error), userId, companyId, departmentId,
        });
      }
      res.json({
        success: true,
        data: {
          departmentId: membership.department.id,
          departmentName: membership.department.name,
          personaPrompt: [
            active ? config.desktopPersonaPrompt : '',
            managerPersonaPrompt,
          ].filter(Boolean).join('\n\n'),
          version: [
            active ? config.updatedAt.toISOString() : null,
            managerPersonaVersion,
          ].filter((value): value is string => Boolean(value)).join('|') || null,
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

  // Company-managed Lark accounts. This is deliberately separate from the
  // desktop login callback so a member can connect additional Lark accounts.
  router.get('/lark/connections/authorize-url', memberAuth, async (req: Request, res: Response) => {
    try {
      if (!deps.larkOAuthService.isConfigured()) {
        res.status(503).json({ success: false, message: 'Lark OAuth not configured' });
        return;
      }
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const redirectUri = desktopCallbackUri(req, '/api/desktop/auth/lark/connections/callback');
      const state = signJwt(
        {
          kind: 'desktop_lark_connect', nonce: randomBytes(16).toString('hex'), userId, companyId, redirectUri,
        },
        deps.memberJwtSecret,
        600,
      );
      const authorizeUrl = deps.larkOAuthService.getAuthorizeUrl(state, { redirectUri });
      res.json({ success: true, data: { authorizeUrl, redirectUri } });
    } catch (e) {
      log.error('lark.connection.authorize_url.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Failed to generate Lark authorize URL' });
    }
  });

  router.get('/lark/connections/callback', async (req: Request, res: Response) => {
    try {
      const { code, state, error: oauthError } = req.query;
      if (oauthError) {
        res.type('text/plain').send('Lark connection cancelled. You can close this window.');
        return;
      }
      if (!code || !state) {
        res.status(400).type('text/plain').send('Missing code or state.');
        return;
      }
      const payload = verifyJwt(String(state), deps.memberJwtSecret);
      if (!payload || payload.kind !== 'desktop_lark_connect' || !payload.userId || !payload.companyId) {
        res.status(400).type('text/plain').send('Invalid or expired state.');
        return;
      }
      const redirectUri = payload.redirectUri
        ?? `${deps.backendPublicUrl.replace(/\/+$/, '')}/api/desktop/auth/lark/connections/callback`;
      const tokens = await deps.larkOAuthService.exchangeCode(String(code), redirectUri);
      if (!tokens.larkOpenId) throw new Error('Lark did not return an account identity');
      const accessTokenExpiresAt = new Date(Date.now() + tokens.expiresIn * 1000);
      const refreshTokenExpiresAt = tokens.refreshTokenExpiresIn
        ? new Date(Date.now() + tokens.refreshTokenExpiresIn * 1000)
        : null;
      const connection = await deps.connectionRepo.upsertLarkConnection({
        companyId: payload.companyId,
        ownerType: 'user',
        ownerUserId: payload.userId,
        createdBy: payload.userId,
        larkOpenId: tokens.larkOpenId,
        larkUserId: tokens.larkUserId,
        larkTenantKey: tokens.tenantKey,
        larkEmail: tokens.larkEmail,
        larkName: tokens.larkName,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: tokens.tokenType,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        scopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? [],
        initialAccess: 'admin',
      });
      if (!connection.ok) throw new Error(connection.error.message);
      res.type('text/plain').send('Lark connection added. You can close this window and return to Divo.');
    } catch (e) {
      log.error('lark.connection.callback.error', { error: String(e) });
      res.status(500).type('text/plain').send('Lark connection failed. You can close this window and try again.');
    }
  });

  router.get('/lark/status', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const connections = await deps.connectionRepo.listAccessibleLarkConnections({ userId, companyId });
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
            label: connection.label,
            accountEmail: connection.accountEmail ?? null,
            accountName: connection.accountName ?? null,
            ownerType: connection.ownerType,
            access: connection.access,
            scopes: connection.scopes,
            connectedAt: connection.connectedAt.toISOString(),
            lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
          })),
        },
      });
    } catch (e) {
      log.error('lark.connection.status.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/lark/connections/:connectionId/manage', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const payload = await buildConnectionManagePayload(String(req.params['connectionId'] ?? ''), userId, companyId, role, 'lark');
      if (!payload) { res.status(404).json({ success: false, message: 'Lark connection not found' }); return; }
      if ('forbidden' in payload) { res.status(403).json({ success: false, message: 'You do not have admin access to this Lark connection' }); return; }
      res.json({ success: true, data: payload });
    } catch (e) {
      log.error('lark.manage.read.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/lark/connections/:connectionId/grants', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const body = req.body as { granteeType?: string; granteeId?: string; access?: string };
      const granteeType = body.granteeType?.trim();
      const granteeId = body.granteeId?.trim();
      const access = body.access?.trim();
      if (!connectionId || !granteeType || !granteeId || !access) {
        res.status(400).json({ success: false, message: 'connectionId, granteeType, granteeId, and access are required' }); return;
      }
      if (!CONNECTION_GRANTEE_TYPES.has(granteeType) || !CONNECTION_GRANT_ACCESSES.has(access)) {
        res.status(400).json({ success: false, message: 'Invalid grantee type or access level' }); return;
      }
      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'lark');
      if (!manageable) { res.status(404).json({ success: false, message: 'Lark connection not found' }); return; }
      if ('forbidden' in manageable) { res.status(403).json({ success: false, message: 'You do not have admin access to this Lark connection' }); return; }
      const candidates = manageable.candidates;
      const isKnownGrantee =
        (granteeType === 'user' && candidates.users.some(candidate => candidate.id === granteeId)) ||
        (granteeType === 'department' && candidates.departments.some(candidate => candidate.id === granteeId)) ||
        (granteeType === 'role' && candidates.roles.some(candidate => candidate.id === granteeId)) ||
        (granteeType === 'company' && candidates.company?.id === granteeId);
      if (!isKnownGrantee) { res.status(400).json({ success: false, message: 'Selected grantee is not part of this company' }); return; }
      const granted = await deps.connectionRepo.grantConnection({
        companyId, connectionId, granteeType: granteeType as 'user' | 'department' | 'role' | 'company', granteeId,
        access: access as 'read_only' | 'read_write' | 'admin', grantedBy: userId,
      });
      if (!granted.ok) { res.status(500).json({ success: false, message: granted.error.message }); return; }
      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'lark');
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('lark.manage.grant.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/lark/connections/:connectionId/grants/:grantId', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'lark');
      if (!manageable) { res.status(404).json({ success: false, message: 'Lark connection not found' }); return; }
      if ('forbidden' in manageable) { res.status(403).json({ success: false, message: 'You do not have admin access to this Lark connection' }); return; }
      const revoked = await deps.connectionRepo.revokeConnectionGrant({ companyId, connectionId, grantId: String(req.params['grantId'] ?? '') });
      if (!revoked.ok) { res.status(500).json({ success: false, message: revoked.error.message }); return; }
      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'lark');
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('lark.manage.revoke_grant.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/lark/connections/:connectionId', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'lark');
      if (!manageable) { res.status(404).json({ success: false, message: 'Lark connection not found' }); return; }
      if ('forbidden' in manageable) { res.status(403).json({ success: false, message: 'You do not have admin access to this Lark connection' }); return; }
      const revoked = await deps.connectionRepo.revokeConnection({ companyId, connectionId, provider: 'lark' });
      if (!revoked.ok) { res.status(500).json({ success: false, message: revoked.error.message }); return; }
      res.json({ success: true, message: 'Lark connection disconnected' });
    } catch (e) {
      log.error('lark.connection.disconnect.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/google/authorize-url', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const redirectUri = desktopCallbackUri(req, '/api/desktop/auth/google/callback');

      const state = signJwt(
        {
          kind: 'desktop_google_connect',
          nonce: randomBytes(16).toString('hex'),
          userId,
          companyId,
          redirectUri,
        },
        deps.memberJwtSecret,
        600,
      );

      const authorizeUrl = deps.googleOAuthService.getAuthorizeUrl({ state, redirectUri });

      res.json({ success: true, data: { authorizeUrl, redirectUri } });
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

      // The state was signed when this flow began, so this is the exact same
      // callback Google used for the authorization code. It lets a locally
      // selected Desktop backend complete its own OAuth flow instead of being
      // pulled back to an unrelated BACKEND_PUBLIC_URL deployment.
      const redirectUri = payload.redirectUri
        ?? `${deps.backendPublicUrl.replace(/\/+$/, '')}/api/desktop/auth/google/callback`;
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

  router.get('/google/data-export-profile', memberAuth, async (_req: Request, res: Response) => {
    const companyId = res.locals['companyId'] as string;
    const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
    if (!COMPANY_ADMIN_ROLES.has(role)) {
      res.status(403).json({ success: false, message: 'Company admin access required' });
      return;
    }
    const configured = await getDataExportProfile(deps.prisma, companyId);
    res.json({
      success: true,
      data: {
        profile: configured.profile,
        configuredAt: configured.configuredAt?.toISOString() ?? null,
        configuredBy: configured.configuredBy,
        version: configured.version,
      },
    });
  });

  router.put('/google/data-export-profile', memberAuth, async (req: Request, res: Response) => {
    const companyId = res.locals['companyId'] as string;
    const userId = res.locals['userId'] as string;
    const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
    if (!COMPANY_ADMIN_ROLES.has(role)) {
      res.status(403).json({ success: false, message: 'Company admin access required' });
      return;
    }
    const parsed = z.object({
      googleConnectionId: z.string().uuid(),
      acknowledged: z.literal(true),
    }).strict().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? 'Invalid export profile' });
      return;
    }
    const manageable = await buildConnectionManagePayload(
      parsed.data.googleConnectionId,
      userId,
      companyId,
      role,
    );
    if (!manageable) {
      res.status(404).json({ success: false, message: 'Google connection not found' });
      return;
    }
    if ('forbidden' in manageable) {
      res.status(403).json({ success: false, message: 'Admin access to the selected Google connection is required' });
      return;
    }
    try {
      const configured = await configureDataExportProfile(deps.prisma, {
        companyId,
        googleConnectionId: parsed.data.googleConnectionId,
        configuredBy: userId,
      });
      log.info('google.data_export_profile.updated', {
        companyId,
        googleConnectionId: parsed.data.googleConnectionId,
        accountEmail: configured.profile.accountEmail,
        userId,
        version: configured.version,
      });
      res.json({
        success: true,
        data: {
          profile: configured.profile,
          configuredAt: configured.configuredAt.toISOString(),
          configuredBy: configured.configuredBy,
          version: configured.version,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('not found') ? 404 : 400).json({ success: false, message });
    }
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

      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role);
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
      if (!CONNECTION_GRANTEE_TYPES.has(granteeType) || !CONNECTION_GRANT_ACCESSES.has(access)) {
        res.status(400).json({ success: false, message: 'Invalid grantee type or access level' });
        return;
      }

      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role);
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

      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role);
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

      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role);
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

      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role);
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('google.manage.revoke.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/google/connections/:connectionId', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      if (!connectionId) {
        res.status(400).json({ success: false, message: 'connectionId is required' });
        return;
      }

      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role);
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Google connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Google connection' });
        return;
      }

      const result = await deps.connectionRepo.revokeConnection({
        companyId,
        connectionId,
        provider: 'google_workspace',
      });
      if (!result.ok) {
        res.status(500).json({ success: false, message: result.error.message });
        return;
      }
      if (!result.value) {
        res.status(404).json({ success: false, message: 'Google connection not found' });
        return;
      }
      res.json({ success: true, message: 'Google connection disconnected' });
    } catch (e) {
      log.error('google.connection.disconnect.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  // ── Canva MCP OAuth + shared connection management ───────────────────────
  // OAuth material is backend-owned. Shared grants only expose this opaque
  // connection ID; callers never receive a Canva access or refresh token.
  router.get('/canva/authorize-url', memberAuth, async (req: Request, res: Response) => {
    try {
      const redirectUri = desktopCallbackUri(req, '/api/desktop/auth/canva/callback');
      if (!deps.canvaMcpOAuthService.isConnectConfigured(redirectUri)) {
        res.status(503).json({
          success: false,
          message: 'Canva MCP OAuth needs an HTTPS backend URL. Sign in against an allowlisted https origin.',
        });
        return;
      }
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const requestedLabel = typeof req.query['label'] === 'string'
        ? req.query['label'].trim().slice(0, 120)
        : '';
      const attemptId = randomBytes(24).toString('hex');
      const state = signJwt(
        {
          kind: 'desktop_canva_connect', nonce: attemptId, userId, companyId, redirectUri,
          ...(requestedLabel ? { label: requestedLabel } : {}),
        },
        deps.memberJwtSecret,
        600,
      );
      const authorizeUrl = await deps.canvaMcpOAuthService.beginAuthorization({ attemptId, state, redirectUri });
      res.json({ success: true, data: { authorizeUrl } });
    } catch (e) {
      log.error('canva.authorize-url.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/canva/callback', async (req: Request, res: Response) => {
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : undefined;
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : undefined;
    const oauthError = typeof req.query['error'] === 'string' ? req.query['error'] : undefined;
    if (oauthError) {
      res.status(400).type('text/plain').send(`Canva connection cancelled: ${oauthError}`);
      return;
    }
    if (!code || !state) {
      res.status(400).type('text/plain').send('Canva connection failed: missing OAuth code or state.');
      return;
    }

    const payload = verifyJwt(state, deps.memberJwtSecret);
    if (!payload || payload.kind !== 'desktop_canva_connect' || !payload.nonce || !payload.userId || !payload.companyId) {
      res.status(400).type('text/plain').send('Canva connection failed: invalid or expired state.');
      return;
    }

    try {
      const tokens = await deps.canvaMcpOAuthService.completeAuthorization({
        attemptId: payload.nonce,
        code,
        // Replay the exact redirect the authorization used; the token exchange
        // fails if it differs by so much as a scheme.
        ...(payload.redirectUri ? { redirectUri: payload.redirectUri } : {}),
      });
      const connection = await deps.connectionRepo.upsertCanvaConnection({
        companyId: payload.companyId,
        ownerType: 'user',
        ownerUserId: payload.userId,
        createdBy: payload.userId,
        // Canva MCP does not promise a profile endpoint. Keep this stable OAuth
        // authorization ID as the provider account key until a canonical subject is exposed.
        externalAccountId: `mcp-oauth:${payload.nonce}`,
        label: typeof payload.label === 'string' && payload.label.trim()
          ? payload.label.trim().slice(0, 120)
          : 'Canva connection',
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        tokenType: tokens.tokenType,
        ...(tokens.expiresIn ? { accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000) } : {}),
        scopes: tokens.scopes,
        tokenMetadata: {
          ...(tokens.clientInformation ? { oauthClientInformation: tokens.clientInformation } : {}),
          ...(tokens.discoveryState ? { oauthDiscoveryState: tokens.discoveryState } : {}),
        },
        initialAccess: 'admin',
      });
      if (!connection.ok) throw new Error(connection.error.message);
      await deps.canvaMcpOAuthService.clearAttempt(payload.nonce);
      log.info('canva.callback.success', {
        companyId: payload.companyId,
        userId: payload.userId,
        connectionId: connection.value.id,
      });
      res.type('text/plain').send('Canva connected successfully. You can close this window and return to Divo Desktop.');
    } catch (e) {
      log.error('canva.callback.error', { error: String(e) });
      res.status(500).type('text/plain').send('Canva connection failed. Return to Divo and try again.');
    }
  });

  router.get('/canva/status', memberAuth, async (_req: Request, res: Response) => {
    const userId = res.locals['userId'] as string;
    const companyId = res.locals['companyId'] as string;
    const connections = await deps.connectionRepo.listAccessibleCanvaConnections({ userId, companyId });
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
          label: connection.label,
          accountEmail: connection.accountEmail ?? null,
          accountName: connection.accountName ?? null,
          ownerType: connection.ownerType,
          ownerUserId: connection.ownerUserId ?? null,
          access: connection.access,
          scopes: connection.scopes,
          connectedAt: connection.connectedAt.toISOString(),
          lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
        })),
      },
    });
  });

  router.get('/canva/connections/:connectionId/manage', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'canva');
      if (!payload) {
        res.status(404).json({ success: false, message: 'Canva connection not found' });
        return;
      }
      if ('forbidden' in payload) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Canva connection' });
        return;
      }
      res.json({ success: true, data: payload });
    } catch (e) {
      log.error('canva.manage.read.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/canva/connections/:connectionId/grants', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const body = req.body as { granteeType?: string; granteeId?: string; access?: string };
      const granteeType = body.granteeType?.trim();
      const granteeId = body.granteeId?.trim();
      const access = body.access?.trim();
      if (!connectionId || !granteeType || !granteeId || !access) {
        res.status(400).json({ success: false, message: 'connectionId, granteeType, granteeId, and access are required' });
        return;
      }
      if (!CONNECTION_GRANTEE_TYPES.has(granteeType) || !CONNECTION_GRANT_ACCESSES.has(access)) {
        res.status(400).json({ success: false, message: 'Invalid grantee type or access level' });
        return;
      }
      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'canva');
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Canva connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Canva connection' });
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
      const granted = await deps.connectionRepo.grantConnection({
        companyId,
        connectionId,
        granteeType: granteeType as 'user' | 'department' | 'role' | 'company',
        granteeId,
        access: access as 'read_only' | 'read_write' | 'admin',
        grantedBy: userId,
      });
      if (!granted.ok) {
        res.status(500).json({ success: false, message: granted.error.message });
        return;
      }
      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'canva');
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('canva.manage.grant.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/canva/connections/:connectionId/grants/:grantId', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const grantId = String(req.params['grantId'] ?? '');
      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'canva');
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Canva connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Canva connection' });
        return;
      }
      const revoked = await deps.connectionRepo.revokeConnectionGrant({ companyId, connectionId, grantId });
      if (!revoked.ok) {
        res.status(500).json({ success: false, message: revoked.error.message });
        return;
      }
      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'canva');
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('canva.manage.revoke_grant.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/canva/connections/:connectionId', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'canva');
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Canva connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Canva connection' });
        return;
      }
      const revoked = await deps.connectionRepo.revokeConnection({ companyId, connectionId, provider: 'canva' });
      if (!revoked.ok) {
        res.status(500).json({ success: false, message: revoked.error.message });
        return;
      }
      res.json({ success: true, message: 'Canva connection disconnected' });
    } catch (e) {
      log.error('canva.connection.disconnect.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  // ── Airtable ───────────────────────────────────────────────────────────────
  // Airtable registers OAuth clients dynamically, so unlike Google there is no
  // console-provisioned app and no client secret; PKCE proves the exchange.

  router.get('/airtable/authorize-url', memberAuth, async (req: Request, res: Response) => {
    try {
      const redirectUri = desktopCallbackUri(req, '/api/desktop/auth/airtable/callback');
      if (!deps.airtableMcpOAuthService.isConnectConfigured(redirectUri)) {
        res.status(503).json({
          success: false,
          message: 'Airtable MCP OAuth needs an HTTPS backend URL, or HTTP on loopback. Sign in against an allowlisted origin.',
        });
        return;
      }
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const requestedLabel = typeof req.query['label'] === 'string'
        ? req.query['label'].trim().slice(0, 120)
        : '';
      const attemptId = randomBytes(24).toString('hex');
      const state = signJwt(
        {
          kind: 'desktop_airtable_connect', nonce: attemptId, userId, companyId, redirectUri,
          ...(requestedLabel ? { label: requestedLabel } : {}),
        },
        deps.memberJwtSecret,
        600,
      );
      const authorizeUrl = await deps.airtableMcpOAuthService.beginAuthorization({ attemptId, state, redirectUri });
      res.json({ success: true, data: { authorizeUrl } });
    } catch (e) {
      log.error('airtable.authorize-url.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/airtable/callback', async (req: Request, res: Response) => {
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : undefined;
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : undefined;
    const oauthError = typeof req.query['error'] === 'string' ? req.query['error'] : undefined;
    if (oauthError) {
      res.status(400).type('text/plain').send(`Airtable connection cancelled: ${oauthError}`);
      return;
    }
    if (!code || !state) {
      res.status(400).type('text/plain').send('Airtable connection failed: missing OAuth code or state.');
      return;
    }

    const payload = verifyJwt(state, deps.memberJwtSecret);
    if (!payload || payload.kind !== 'desktop_airtable_connect' || !payload.nonce || !payload.userId || !payload.companyId) {
      res.status(400).type('text/plain').send('Airtable connection failed: invalid or expired state.');
      return;
    }

    try {
      const tokens = await deps.airtableMcpOAuthService.completeAuthorization({
        attemptId: payload.nonce,
        code,
        // Replay the exact redirect the authorization used; the token exchange
        // fails if it differs by so much as a scheme.
        ...(payload.redirectUri ? { redirectUri: payload.redirectUri } : {}),
      });
      const connection = await deps.connectionRepo.upsertAirtableConnection({
        companyId: payload.companyId,
        ownerType: 'user',
        ownerUserId: payload.userId,
        createdBy: payload.userId,
        // The MCP lane exposes no profile endpoint, so this stable OAuth
        // authorization ID is the account key until a canonical subject exists.
        // It also keeps repeat authorizations of the same Airtable account
        // distinct rows rather than silently overwriting one another.
        externalAccountId: `mcp-oauth:${payload.nonce}`,
        label: typeof payload.label === 'string' && payload.label.trim()
          ? payload.label.trim().slice(0, 120)
          : 'Airtable connection',
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        tokenType: tokens.tokenType,
        ...(tokens.expiresIn ? { accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000) } : {}),
        scopes: tokens.scopes,
        // The dynamically registered client and OAuth discovery document must
        // survive with the connection: a later refresh has to rebuild exactly
        // the client that received this grant.
        tokenMetadata: {
          ...(tokens.clientInformation ? { oauthClientInformation: tokens.clientInformation } : {}),
          ...(tokens.discoveryState ? { oauthDiscoveryState: tokens.discoveryState } : {}),
        },
        initialAccess: 'admin',
      });
      if (!connection.ok) throw new Error(connection.error.message);
      await deps.airtableMcpOAuthService.clearAttempt(payload.nonce);
      log.info('airtable.callback.success', {
        companyId: payload.companyId,
        userId: payload.userId,
        connectionId: connection.value.id,
      });
      res.type('text/plain').send('Airtable connected successfully. You can close this window and return to Divo Desktop.');
    } catch (e) {
      log.error('airtable.callback.error', { error: String(e) });
      res.status(500).type('text/plain').send('Airtable connection failed. Return to Divo and try again.');
    }
  });

  router.post('/airtable/pat', memberAuth, async (req: Request, res: Response) => {
    try {
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      if (!COMPANY_ADMIN_ROLES.has(role)) {
        res.status(403).json({ success: false, message: 'Only a company administrator can connect Airtable with a personal access token.' });
        return;
      }

      const body = req.body as { personalAccessToken?: unknown; label?: unknown; accessMode?: unknown };
      const personalAccessToken = typeof body.personalAccessToken === 'string'
        ? body.personalAccessToken.trim()
        : '';
      const accessMode = body.accessMode === 'read_only' || body.accessMode === 'read_write'
        ? body.accessMode as AirtablePatAccessMode
        : null;
      if (!accessMode) {
        res.status(400).json({ success: false, message: 'Choose whether this Airtable token is read-only or read/write.' });
        return;
      }
      const check = await verifyAirtablePatIdentity(personalAccessToken);
      if (!check.ok) {
        res.status(check.reason === 'unreachable' ? 502 : 400)
          .json({ success: false, message: check.message, reason: check.reason });
        return;
      }

      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const connection = await deps.connectionRepo.upsertAirtableConnection({
        companyId,
        ownerType: 'user',
        ownerUserId: userId,
        createdBy: userId,
        externalAccountId: `mcp-pat:${apiKeyFingerprint(personalAccessToken)}`,
        ...(typeof body.label === 'string' && body.label.trim()
          ? { label: body.label.trim().slice(0, 120) }
          : {}),
        accessToken: personalAccessToken,
        tokenType: 'Bearer',
        scopes: [...AIRTABLE_PAT_SCOPE_PRESETS[accessMode]],
        tokenMetadata: {
          authenticationMethod: 'personal_access_token',
          airtableUserId: check.userId,
          scopeSource: 'admin_declaration',
          declaredAccessMode: accessMode,
        },
        initialAccess: 'admin',
      });
      if (!connection.ok) {
        res.status(500).json({ success: false, message: connection.error.message });
        return;
      }

      log.info('airtable.pat.success', {
        companyId,
        userId,
        connectionId: connection.value.id,
        scopeCount: AIRTABLE_PAT_SCOPE_PRESETS[accessMode].length,
      });
      res.json({
        success: true,
        data: {
          connectionId: connection.value.id,
          label: connection.value.label,
          scopes: AIRTABLE_PAT_SCOPE_PRESETS[accessMode],
        },
      });
    } catch (e) {
      log.error('airtable.pat.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Could not save the Airtable connection.' });
    }
  });

  // ── AITable ────────────────────────────────────────────────────────────────
  // No OAuth exists for AITable, so there is no authorize-url/callback pair
  // here. A member pastes the personal API key they minted in AITable's User
  // Center, and the key is proven against AITable before anything is stored —
  // that live check is the connect step, not a nicety attached to it.
  //
  // Adding a connection is restricted to company administrators for the same
  // reason the tools are (plans/aitable-integration.md §2.7): a connection
  // nobody is permitted to use would be confusing to offer. Both open together
  // when a department is granted the tools.

  const aitableAdminOnly = (res: Response): boolean =>
    COMPANY_ADMIN_ROLES.has((res.locals['aiRole'] as string | undefined) ?? 'MEMBER');

  const verifiedSpaces = async (
    res: Response,
    apiKey: unknown,
  ): Promise<{ id: string; name: string }[] | null> => {
    const check = await deps.aitableKeyVerifier.verify(typeof apiKey === 'string' ? apiKey : '');
    if (!check.ok) {
      // 'rejected' is the caller's fault and permanent; 'unreachable' is
      // neither, so it must not be reported as a bad key. 502 says "ask again".
      res.status(check.reason === 'unreachable' ? 502 : 400)
        .json({ success: false, message: check.message, reason: check.reason });
      return null;
    }
    return check.spaces.map((space: { id: string; name: string }) => ({ id: space.id, name: space.name }));
  };

  router.post('/aitable/connect', memberAuth, async (req: Request, res: Response) => {
    try {
      if (!aitableAdminOnly(res)) {
        res.status(403).json({ success: false, message: 'Only a company administrator can connect AITable.' });
        return;
      }
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const body = req.body as { apiKey?: unknown; label?: unknown };

      const spaces = await verifiedSpaces(res, body.apiKey);
      if (!spaces) return;

      const saved = await deps.connectionRepo.upsertAitableConnection({
        companyId,
        ownerType: 'user',
        ownerUserId: userId,
        createdBy: userId,
        ...(typeof body.label === 'string' && body.label.trim() ? { label: body.label.trim() } : {}),
        apiKey: String(body.apiKey),
        spaces,
      });
      if (!saved.ok) {
        res.status(500).json({ success: false, message: saved.error.message });
        return;
      }

      log.info('aitable.connect.success', { userId, companyId, connectionId: saved.value.id, spaceCount: spaces.length });
      res.json({
        success: true,
        data: {
          connectionId: saved.value.id,
          label: saved.value.label,
          spaceCount: spaces.length,
          // A key that reaches nothing is valid but useless until its owner is
          // added to a workspace. Said plainly rather than left to be discovered
          // when the first tool call comes back empty.
          ...(spaces.length === 0
            ? { warning: 'This key works, but it does not reach any AITable workspace yet.' }
            : {}),
        },
      });
    } catch (e) {
      log.error('aitable.connect.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Could not save the AITable connection.' });
    }
  });

  /**
   * Rotating the key on a connection that already exists. This is the repair
   * path for a connection marked `needs_key`, and it keeps the row — deleting
   * and re-adding would silently drop every grant attached to it.
   */
  router.post('/aitable/connections/:connectionId/key', memberAuth, async (req: Request, res: Response) => {
    try {
      if (!aitableAdminOnly(res)) {
        res.status(403).json({ success: false, message: 'Only a company administrator can update an AITable key.' });
        return;
      }
      const companyId = res.locals['companyId'] as string;
      const connectionId = String(req.params['connectionId'] ?? '');
      const body = req.body as { apiKey?: unknown };

      const spaces = await verifiedSpaces(res, body.apiKey);
      if (!spaces) return;

      const replaced = await deps.connectionRepo.replaceAitableApiKey({
        companyId,
        connectionId,
        apiKey: String(body.apiKey),
        spaces,
      });
      if (!replaced.ok) {
        res.status(500).json({ success: false, message: replaced.error.message });
        return;
      }
      if (!replaced.value) {
        res.status(404).json({ success: false, message: 'AITable connection not found' });
        return;
      }
      log.info('aitable.key.replaced', { companyId, connectionId, spaceCount: spaces.length });
      res.json({ success: true, data: { connectionId, spaceCount: spaces.length } });
    } catch (e) {
      log.error('aitable.key.replace.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Could not update the AITable key.' });
    }
  });

  router.get('/aitable/status', memberAuth, async (_req: Request, res: Response) => {
    const userId = res.locals['userId'] as string;
    const companyId = res.locals['companyId'] as string;
    const connections = await deps.connectionRepo.listAccessibleAitableConnections({ userId, companyId });
    if (!connections.ok) {
      res.status(500).json({ success: false, message: connections.error.message });
      return;
    }
    res.json({
      success: true,
      data: {
        // A connection whose key died does not count as being connected, but it
        // is still listed so it can be repaired rather than silently vanishing.
        connected: connections.value.some(connection => connection.status === 'connected'),
        canConnect: aitableAdminOnly(res),
        connections: connections.value.map(connection => ({
          connectionId: connection.connectionId,
          label: connection.label,
          accountName: connection.accountName ?? null,
          ownerType: connection.ownerType,
          ownerUserId: connection.ownerUserId ?? null,
          access: connection.access,
          status: connection.status ?? 'connected',
          needsKey: connection.status === CONNECTION_NEEDS_KEY,
          connectedAt: connection.connectedAt.toISOString(),
          lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
        })),
      },
    });
  });

  router.get('/aitable/connections/:connectionId/manage', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'aitable');
      if (!payload) {
        res.status(404).json({ success: false, message: 'AITable connection not found' });
        return;
      }
      if ('forbidden' in payload) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this AITable connection' });
        return;
      }
      res.json({ success: true, data: payload });
    } catch (e) {
      log.error('aitable.manage.read.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/aitable/connections/:connectionId/revoke', memberAuth, async (req: Request, res: Response) => {
    try {
      if (!aitableAdminOnly(res)) {
        res.status(403).json({ success: false, message: 'Only a company administrator can revoke an AITable connection.' });
        return;
      }
      const companyId = res.locals['companyId'] as string;
      const connectionId = String(req.params['connectionId'] ?? '');
      const revoked = await deps.connectionRepo.revokeConnection({ companyId, connectionId, provider: 'aitable' });
      if (!revoked.ok) {
        res.status(500).json({ success: false, message: revoked.error.message });
        return;
      }
      log.info('aitable.connection.revoked', { companyId, connectionId });
      res.json({ success: true });
    } catch (e) {
      log.error('aitable.revoke.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/airtable/status', memberAuth, async (_req: Request, res: Response) => {
    const userId = res.locals['userId'] as string;
    const companyId = res.locals['companyId'] as string;
    const connections = await deps.connectionRepo.listAccessibleAirtableConnections({ userId, companyId });
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
          label: connection.label,
          accountEmail: connection.accountEmail ?? null,
          accountName: connection.accountName ?? null,
          ownerType: connection.ownerType,
          ownerUserId: connection.ownerUserId ?? null,
          access: connection.access,
          scopes: connection.scopes,
          connectedAt: connection.connectedAt.toISOString(),
          lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
        })),
      },
    });
  });

  router.get('/airtable/connections/:connectionId/manage', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'airtable');
      if (!payload) {
        res.status(404).json({ success: false, message: 'Airtable connection not found' });
        return;
      }
      if ('forbidden' in payload) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Airtable connection' });
        return;
      }
      res.json({ success: true, data: payload });
    } catch (e) {
      log.error('airtable.manage.read.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/airtable/connections/:connectionId/grants', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const body = req.body as { granteeType?: string; granteeId?: string; access?: string };
      const granteeType = body.granteeType?.trim();
      const granteeId = body.granteeId?.trim();
      const access = body.access?.trim();
      if (!connectionId || !granteeType || !granteeId || !access) {
        res.status(400).json({ success: false, message: 'connectionId, granteeType, granteeId, and access are required' });
        return;
      }
      if (!CONNECTION_GRANTEE_TYPES.has(granteeType) || !CONNECTION_GRANT_ACCESSES.has(access)) {
        res.status(400).json({ success: false, message: 'Invalid grantee type or access level' });
        return;
      }
      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'airtable');
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Airtable connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Airtable connection' });
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
      const granted = await deps.connectionRepo.grantConnection({
        companyId,
        connectionId,
        granteeType: granteeType as 'user' | 'department' | 'role' | 'company',
        granteeId,
        access: access as 'read_only' | 'read_write' | 'admin',
        grantedBy: userId,
      });
      if (!granted.ok) {
        res.status(500).json({ success: false, message: granted.error.message });
        return;
      }
      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'airtable');
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('airtable.manage.grant.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/airtable/connections/:connectionId/grants/:grantId', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const grantId = String(req.params['grantId'] ?? '');
      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'airtable');
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Airtable connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Airtable connection' });
        return;
      }
      const revoked = await deps.connectionRepo.revokeConnectionGrant({ companyId, connectionId, grantId });
      if (!revoked.ok) {
        res.status(500).json({ success: false, message: revoked.error.message });
        return;
      }
      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'airtable');
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('airtable.manage.revoke_grant.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/airtable/connections/:connectionId', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'airtable');
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Airtable connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Airtable connection' });
        return;
      }
      const revoked = await deps.connectionRepo.revokeConnection({ companyId, connectionId, provider: 'airtable' });
      if (!revoked.ok) {
        res.status(500).json({ success: false, message: revoked.error.message });
        return;
      }
      res.json({ success: true, message: 'Airtable connection disconnected' });
    } catch (e) {
      log.error('airtable.connection.disconnect.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/zoho/authorize-url', memberAuth, async (req: Request, res: Response) => {
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

      const redirectUri = desktopCallbackUri(req, '/api/desktop/auth/zoho/callback');
      const authorizeConfig = await deps.zohoTokenService.getAuthorizeConfig(companyId);

      const state = signJwt(
        {
          kind: 'desktop_zoho_connect',
          nonce: randomBytes(16).toString('hex'),
          userId,
          companyId,
          redirectUri,
        },
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

  router.post('/zoho/self-client', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      if (!COMPANY_ADMIN_ROLES.has(role)) {
        res.status(403).json({ success: false, message: 'Only company admins can connect Zoho for the company' });
        return;
      }

      const parsed = zohoSelfClientSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? 'Invalid Self Client details' });
        return;
      }

      let tokens;
      try {
        tokens = await deps.zohoTokenService.exchangeSelfClientGrant(parsed.data);
      } catch (e) {
        res.status(400).json({ success: false, message: `Zoho rejected the Self Client grant: ${String(e)}` });
        return;
      }
      if (!tokens.refreshToken) {
        res.status(400).json({
          success: false,
          message: 'Zoho did not return a refresh token. Generate a new Self Client grant and try again.',
        });
        return;
      }
      const grantedScopes = tokens.scopes.length > 0
        ? tokens.scopes
        : ZOHO_SELF_CLIENT_READ_SCOPES;

      const apiBaseUrl = tokens.apiDomain
        ?? ZOHO_DATA_CENTRES[parsed.data.accountsBaseUrl];
      const accountSummary = await fetchZohoAccountSummary(tokens.accessToken, apiBaseUrl);
      if (!accountSummary?.externalAccountId) {
        res.status(400).json({
          success: false,
          message: 'Zoho connected, but Divo could not verify a Books organization. Check the data centre and read-only scopes, then generate a new grant.',
        });
        return;
      }
      const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);
      const connectionResult = await deps.connectionRepo.upsertZohoConnection({
        companyId,
        ownerType: 'company',
        createdBy: userId,
        label: parsed.data.label || (accountSummary?.accountName ? `${accountSummary.accountName} Zoho` : 'Zoho Self Client'),
        ...(accountSummary.accountName ? { accountName: accountSummary.accountName } : {}),
        externalAccountId: `self-client:${parsed.data.clientId}:${accountSummary.externalAccountId}`,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
        accessTokenExpiresAt: expiresAt,
        scopes: grantedScopes,
        apiDomain: apiBaseUrl,
        accountsBaseUrl: parsed.data.accountsBaseUrl,
        apiBaseUrl,
        selfClientOAuth: {
          clientId:     parsed.data.clientId,
          clientSecret: parsed.data.clientSecret,
        },
        environment: 'prod',
        initialAccess: 'read_only',
      });
      if (!connectionResult.ok) throw new Error(connectionResult.error.message);

      log.info('zoho.self_client.connected', {
        userId,
        companyId,
        connectionId: connectionResult.value.id,
      });
      res.json({
        success: true,
        data: {
          connectionId: connectionResult.value.id,
          label: connectionResult.value.label,
          access: 'read_only',
          scopes: grantedScopes,
        },
      });
    } catch (e) {
      log.error('zoho.self_client.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Could not save the Zoho Self Client connection' });
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

      const redirectUri = payload.redirectUri
        ?? `${deps.backendPublicUrl.replace(/\/+$/, '')}/api/desktop/auth/zoho/callback`;
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
        accountsBaseUrl: tokens.accountsBaseUrl,
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
      const managementRows = await deps.prisma.integrationConnection.findMany({
        where: {
          id: { in: connections.value.map(connection => connection.connectionId) },
          companyId,
          provider: 'zoho',
          revokedAt: null,
        },
        select: {
          id: true,
          ownerUserId: true,
          createdBy: true,
        },
      });
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
      const managementByConnectionId = new Map(
        managementRows.map(connection => [connection.id, connection]),
      );
      const canManageCompanyConnections = COMPANY_ADMIN_ROLES.has(role);
      const legacyConnected = Boolean(legacyRecord && legacyRecord.status === 'CONNECTED');
      res.json({
        success: true,
        data: {
          connected: connections.value.length > 0 || legacyConnected,
          canManage: canManageCompanyConnections,
          connections: connections.value.map(connection => {
            const management = managementByConnectionId.get(connection.connectionId);
            return {
              connectionId: connection.connectionId,
              label:        connection.label,
              accountEmail: connection.accountEmail ?? null,
              accountName:  connection.accountName ?? null,
              ownerType:    connection.ownerType,
              access:       connection.access,
              canManage:
                canManageCompanyConnections ||
                connection.access === 'admin' ||
                management?.ownerUserId === userId ||
                management?.createdBy === userId,
              scopes:       connection.scopes,
              connectedAt:  connection.connectedAt.toISOString(),
              lastUsedAt:   connection.lastUsedAt?.toISOString() ?? null,
            };
          }),
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

      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
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
      if (!CONNECTION_GRANTEE_TYPES.has(granteeType) || !CONNECTION_GRANT_ACCESSES.has(access)) {
        res.status(400).json({ success: false, message: 'Invalid grantee type or access level' });
        return;
      }

      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Zoho connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Zoho connection' });
        return;
      }
      if (
        access !== 'read_only'
        && manageable.connection.readOnlyEnforced
      ) {
        res.status(400).json({ success: false, message: 'This Zoho connection is read-only' });
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

      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
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

      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
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

      const payload = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
      res.json({ success: true, data: payload && !('forbidden' in payload) ? payload : null });
    } catch (e) {
      log.error('zoho.manage.revoke.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.delete('/zoho/connections/:connectionId', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role = (res.locals['aiRole'] as string | undefined) ?? 'MEMBER';
      const connectionId = String(req.params['connectionId'] ?? '');
      if (!connectionId) {
        res.status(400).json({ success: false, message: 'connectionId is required' });
        return;
      }

      const manageable = await buildConnectionManagePayload(connectionId, userId, companyId, role, 'zoho');
      if (!manageable) {
        res.status(404).json({ success: false, message: 'Zoho connection not found' });
        return;
      }
      if ('forbidden' in manageable) {
        res.status(403).json({ success: false, message: 'You do not have admin access to this Zoho connection' });
        return;
      }

      const result = await deps.connectionRepo.revokeConnection({
        companyId,
        connectionId,
        provider: 'zoho',
      });
      if (!result.ok) {
        res.status(500).json({ success: false, message: result.error.message });
        return;
      }
      if (!result.value) {
        res.status(404).json({ success: false, message: 'Zoho connection not found' });
        return;
      }
      res.json({ success: true, message: 'Zoho connection disconnected' });
    } catch (e) {
      log.error('zoho.connection.disconnect.error', { error: String(e) });
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
      const revoked = await deps.connectionRepo.revokeLarkConnectionsForUser(companyId, userId);
      if (!revoked.ok) throw new Error(revoked.error.message);
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
