import type { PrismaClient } from '../../generated/prisma';
import { randomBytes } from 'node:crypto';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { LarkContactRecord } from '../../application/context-search/context-search.ports';
import type { CachePort } from '../../shared/cache';

const LARK_IDENTITY_TTL = 900; // 15 min — identity almost never changes; invalidated on OAuth success
// v2 selects the canonical Divo owner when historical duplicate Lark
// connections exist. The version bump prevents a previously cached legacy
// owner from surviving the corrected resolution semantics.
const identityCacheKey = (larkOpenId: string, tenantKey?: string) => tenantKey
  ? `lark:id:v3:${tenantKey}:${larkOpenId}`
  : `lark:id:v2:${larkOpenId}`;

export interface ChannelIdentityRow {
  id: string;
  companyId: string;
  channel: string;
  larkOpenId?: string | null;
  displayName?: string | null;
  aiRole: string;
  aiRoleSource?: string | null;
}

export interface ResolvedUserIdentity {
  userId: string;
  companyId: string;
  aiRole: string;
  channel: string;
  /** Active department from UserDepartmentPreference, if set. */
  activeDepartmentId?: string;
  /** Lark open_id (when resolved via Lark channel). */
  larkOpenId?: string;
  /** Human-readable display name from the channel identity record. */
  displayName?: string;
  /** Email address from the channel identity record. */
  email?: string;
}

export type PendingLarkLoginResolution =
  | {
      status: 'ready';
      userId: string;
      companyId: string;
      aiRole: string;
      larkOpenId: string;
      displayName?: string;
      email: string;
      createdUser: boolean;
    }
  | {
      status: 'missing_email';
      companyId: string;
      aiRole: string;
      larkOpenId: string;
      displayName?: string;
    };

export interface ChannelIdentityRepoPort {
  /** Legacy resolution for flows that do not yet have a trusted Lark tenant key. */
  resolveByLarkOpenId(larkOpenId: string): Promise<Result<ResolvedUserIdentity | null, InfraError>>;
  /** Resolves webhook identities within one authenticated Lark installation. */
  resolveByLarkTenantIdentity(
    larkOpenId: string,
    tenantKey: string,
  ): Promise<Result<ResolvedUserIdentity | null, InfraError>>;
  /** Resolves the company installation without treating a room speaker as an authenticated user. */
  resolveLarkTenantCompanyId(
    tenantKey: string,
  ): Promise<Result<string | null, InfraError>>;
  /** Prepares a one-time OAuth link for a known Lark identity that has no active auth link yet. */
  prepareLarkLogin(
    larkOpenId: string,
    tenantKey?: string,
  ): Promise<Result<PendingLarkLoginResolution | null, InfraError>>;
  /** Invalidates cached Lark identity after auth or department context changes. */
  invalidateIdentityCache?(larkOpenId: string): Promise<void>;
  /** Resolves an internal user only within the authoritative company context. */
  resolveByUserId(
    userId: string,
    companyId: string,
  ): Promise<Result<ResolvedUserIdentity | null, InfraError>>;
}

// ─── Token helpers for contact search ────────────────────────────────────────

const NOISE_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'is', 'in', 'on', 'for', 'of', 'with', 'at']);

function extractSearchTokens(normalized: string): string[] {
  return Array.from(
    new Set(
      normalized
        .split(/[\s,;|@]+/)
        .map(t => t.trim().replace(/[^a-z0-9._+-]/g, ''))
        .filter(t => t.length >= 2 && !NOISE_WORDS.has(t)),
    ),
  );
}

function scoreContactRow(
  row: { displayName?: string | null; email?: string | null; larkOpenId?: string | null },
  tokens: string[],
): number {
  const haystack = [row.displayName, row.email, row.larkOpenId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) score += t.length >= 4 ? 3 : 1;
    if (haystack.startsWith(t)) score += 2;
  }
  return score;
}

export class ChannelIdentityRepository implements ChannelIdentityRepoPort {
  constructor(
    private readonly db: PrismaClient,
    private readonly cache?: CachePort,
  ) {}

  async resolveByLarkOpenId(
    larkOpenId: string,
  ): Promise<Result<ResolvedUserIdentity | null, InfraError>> {
    return this.resolveLarkIdentity(larkOpenId);
  }

  async resolveByLarkTenantIdentity(
    larkOpenId: string,
    tenantKey: string,
  ): Promise<Result<ResolvedUserIdentity | null, InfraError>> {
    return this.resolveLarkIdentity(larkOpenId, tenantKey);
  }

  async resolveLarkTenantCompanyId(
    tenantKey: string,
  ): Promise<Result<string | null, InfraError>> {
    try {
      const binding = await this.db.larkTenantBinding.findFirst({
        where: { larkTenantKey: tenantKey, isActive: true },
        select: { companyId: true },
      });
      return ok(binding?.companyId ?? null);
    } catch (e) {
      return err(wrapInfra('prisma', 'resolveLarkTenantCompanyId', e));
    }
  }

  private async resolveLarkIdentity(
    larkOpenId: string,
    tenantKey?: string,
  ): Promise<Result<ResolvedUserIdentity | null, InfraError>> {
    let boundCompanyId: string | undefined;
    if (tenantKey) {
      try {
        const binding = await this.db.larkTenantBinding.findFirst({
          where: { larkTenantKey: tenantKey, isActive: true },
          select: { companyId: true },
        });
        if (!binding) return ok(null);
        boundCompanyId = binding.companyId;
      } catch (e) {
        return err(wrapInfra('prisma', 'resolveByLarkTenantIdentity.binding', e));
      }
    }

    // Cache read — only non-null identities are cached (null = user may register soon).
    if (this.cache) {
      const cached = await this.cache.get<ResolvedUserIdentity>(identityCacheKey(larkOpenId, tenantKey));
      if (cached.ok && cached.value !== null) {
        if (boundCompanyId && cached.value.companyId !== boundCompanyId) return ok(null);
        const membership = await this.db.adminMembership.findFirst({
          where: {
            userId: cached.value.userId,
            companyId: cached.value.companyId,
            isActive: true,
          },
          select: { role: true },
          orderBy: { updatedAt: 'desc' },
        });
        if (!membership) return ok(null);
        return ok({ ...cached.value, aiRole: membership.role });
      }
    }

    try {
      const ci = await this.db.channelIdentity.findFirst({
        where: {
          channel: 'lark',
          larkOpenId,
          ...(tenantKey ? { externalTenantId: tenantKey } : {}),
          ...(boundCompanyId ? { companyId: boundCompanyId } : {}),
        },
        select: { id: true, aiRole: true, channel: true, companyId: true, displayName: true, email: true },
      });
      if (!ci) return ok(null);

      const connections = await this.db.integrationConnection.findMany({
        where: {
          companyId: ci.companyId,
          provider: 'lark',
          externalAccountId: larkOpenId,
          ...(tenantKey ? {
            tokenMetadata: {
              path: ['larkTenantKey'],
              equals: tenantKey,
            },
          } : {}),
          ownerUserId: { not: null },
          status: 'connected',
          revokedAt: null,
        },
        select: {
          ownerUserId: true,
          ownerUser: { select: { email: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      });

      const identityEmail = ci.email?.trim().toLowerCase();
      const emailMatchedOwner = identityEmail
        ? connections.find(connection => connection.ownerUser?.email.trim().toLowerCase() === identityEmail)
        : undefined;
      const distinctOwnerIds = Array.from(new Set(
        connections
          .map(connection => connection.ownerUserId)
          .filter((ownerUserId): ownerUserId is string => Boolean(ownerUserId)),
      ));
      const ownerUserId = emailMatchedOwner?.ownerUserId
        ?? (distinctOwnerIds.length === 1 ? distinctOwnerIds[0] : undefined);
      if (!ownerUserId) return ok(null);

      const membership = await this.db.adminMembership.findFirst({
        where: {
          userId: ownerUserId,
          companyId: ci.companyId,
          isActive: true,
        },
        select: { role: true },
        orderBy: { updatedAt: 'desc' },
      });
      if (!membership) return ok(null);

      const deptPref = await this.db.userDepartmentPreference.findUnique({
        where: { userId: ownerUserId },
        select: { activeDepartmentId: true },
      });

      const resolved: ResolvedUserIdentity = {
        userId: ownerUserId,
        companyId: ci.companyId,
        aiRole: membership.role,
        channel: ci.channel,
        larkOpenId,
        ...(ci.displayName ? { displayName: ci.displayName } : {}),
        ...(ci.email ? { email: ci.email } : {}),
        ...(deptPref?.activeDepartmentId ? { activeDepartmentId: deptPref.activeDepartmentId } : {}),
      };
      // Populate cache — fire-and-forget.
      if (this.cache) {
        void this.cache.set(identityCacheKey(larkOpenId, tenantKey), resolved, LARK_IDENTITY_TTL);
      }
      return ok(resolved);
    } catch (e) {
      return err(wrapInfra('prisma', 'resolveByLarkOpenId', e));
    }
  }

  /** Invalidate cached identity for a Lark user (call after OAuth link created/updated). */
  async invalidateIdentityCache(larkOpenId: string): Promise<void> {
    if (this.cache) {
      await Promise.all([
        this.cache.del(identityCacheKey(larkOpenId)),
        this.cache.scanDel(`lark:id:v3:*:${larkOpenId}`),
      ]);
    }
  }

  async prepareLarkLogin(
    larkOpenId: string,
    tenantKey?: string,
  ): Promise<Result<PendingLarkLoginResolution | null, InfraError>> {
    try {
      const binding = tenantKey
        ? await this.db.larkTenantBinding.findFirst({
            where: { larkTenantKey: tenantKey, isActive: true },
            select: { companyId: true },
          })
        : null;
      if (tenantKey && !binding) return ok(null);

      const ci = await this.db.channelIdentity.findFirst({
        where: {
          channel: 'lark',
          larkOpenId,
          ...(tenantKey ? { externalTenantId: tenantKey } : {}),
          ...(binding ? { companyId: binding.companyId } : {}),
        },
        select: {
          aiRole:      true,
          companyId:   true,
          displayName: true,
          email:       true,
          larkOpenId:  true,
        },
      });
      if (!ci?.larkOpenId) return ok(null);

      const displayName = ci.displayName?.trim() || undefined;
      const email = ci.email?.trim().toLowerCase();
      if (!email) {
        return ok({
          status: 'missing_email',
          companyId: ci.companyId,
          aiRole: ci.aiRole,
          larkOpenId: ci.larkOpenId,
          ...(displayName ? { displayName } : {}),
        });
      }

      const existingUser = await this.db.user.findUnique({
        where:  { email },
        select: { id: true },
      });

      if (existingUser) {
        const membership = await this.ensureActiveCompanyMembership(existingUser.id, ci.companyId);
        return ok({
          status: 'ready',
          userId: existingUser.id,
          companyId: ci.companyId,
          aiRole: membership.role,
          larkOpenId: ci.larkOpenId,
          ...(displayName ? { displayName } : {}),
          email,
          createdUser: false,
        });
      }

      const user = await this.db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            // Lark-first users authenticate through OAuth. This random password is
            // intentionally not user-facing and cannot be guessed for password login.
            password: `lark-oauth-pending:${randomBytes(32).toString('hex')}`,
            ...(displayName ? { name: displayName } : {}),
          },
          select: { id: true },
        });
        await tx.adminMembership.create({
          data: { userId: created.id, companyId: ci.companyId, role: 'MEMBER', isActive: true },
        });
        return created;
      });

      return ok({
        status: 'ready',
        userId: user.id,
        companyId: ci.companyId,
        aiRole: 'MEMBER',
        larkOpenId: ci.larkOpenId,
        ...(displayName ? { displayName } : {}),
        email,
        createdUser: true,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'prepareLarkLogin', e));
    }
  }

  async resolveByUserId(
    userId: string,
    companyId: string,
  ): Promise<Result<ResolvedUserIdentity | null, InfraError>> {
    try {
      const membership = await this.db.adminMembership.findFirst({
        where: { userId, companyId, isActive: true },
        select: { role: true },
        orderBy: { updatedAt: 'desc' },
      });
      if (!membership) return ok(null);

      const connection = await this.db.integrationConnection.findFirst({
        where: {
          companyId,
          ownerUserId: userId,
          provider: 'lark',
          status: 'connected',
          revokedAt: null,
        },
        select: { externalAccountId: true, tokenMetadata: true },
        orderBy: { updatedAt: 'desc' },
      });
      const tenantKey = asOptionalString(asRecord(connection?.tokenMetadata)?.['larkTenantKey']);
      const ci = connection?.externalAccountId
        ? await this.db.channelIdentity.findFirst({
            where: {
              companyId,
              channel: 'lark',
              larkOpenId: connection.externalAccountId,
              ...(tenantKey ? { externalTenantId: tenantKey } : {}),
            },
            select: { channel: true, displayName: true, email: true },
          })
        : null;

      const deptPref = await this.db.userDepartmentPreference.findUnique({
        where: { userId },
        select: { activeDepartmentId: true },
      });

      return ok({
        userId,
        companyId,
        aiRole:     membership.role,
        channel:    ci?.channel ?? 'internal',
        ...(connection?.externalAccountId && ci ? { larkOpenId: connection.externalAccountId } : {}),
        ...(ci?.displayName ? { displayName: ci.displayName } : {}),
        ...(ci?.email ? { email: ci.email } : {}),
        ...(deptPref?.activeDepartmentId ? { activeDepartmentId: deptPref.activeDepartmentId } : {}),
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'resolveByUserId', e));
    }
  }

  private async ensureActiveCompanyMembership(
    userId: string,
    companyId: string,
  ): Promise<{ role: string }> {
    const existing = await this.db.adminMembership.findFirst({
      where: { userId, companyId, isActive: true },
      select: { role: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (existing) return existing;

    return this.db.adminMembership.create({
      data: { userId, companyId, role: 'MEMBER', isActive: true },
      select: { role: true },
    });
  }

  /** Full-text search over Lark contacts for a company. Implements LarkContactPort. */
  async searchContacts(input: {
    companyId: string;
    query: string;
    limit: number;
  }): Promise<LarkContactRecord[]> {
    const normalized = input.query.trim().toLowerCase();
    const requestedLimit = Math.max(1, Math.min(input.limit, 20));
    if (!normalized) return [];

    const tokens = extractSearchTokens(normalized);
    if (tokens.length === 0) return [];

    const rows = await this.db.channelIdentity.findMany({
      where: {
        companyId: input.companyId,
        channel: 'lark',
        OR: tokens.flatMap(t => ([
          { displayName: { contains: t, mode: 'insensitive' as const } },
          { email:       { contains: t, mode: 'insensitive' as const } },
        ])),
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(requestedLimit * 6, 24), 120),
    });

    return rows
      .map(row => ({ row, score: scoreContactRow(row, tokens) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, requestedLimit)
      .map(({ row }) => ({
        ...(row.larkOpenId     ? { larkOpenId:     row.larkOpenId }     : {}),
        ...(row.larkUserId     ? { larkUserId:     row.larkUserId }     : {}),
        ...(row.externalUserId ? { externalUserId: row.externalUserId } : {}),
        ...(row.displayName    ? { displayName:    row.displayName }    : {}),
        ...(row.email          ? { email:          row.email }          : {}),
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
      }));
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
