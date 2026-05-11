import type { PrismaClient } from '../../generated/prisma';
import { randomBytes } from 'node:crypto';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { LarkContactRecord } from '../../application/context-search/context-search.ports';
import type { CachePort } from '../../shared/cache';

const LARK_IDENTITY_TTL = 900; // 15 min — identity almost never changes; invalidated on OAuth success
const identityCacheKey = (larkOpenId: string) => `lark:id:v1:${larkOpenId}`;

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
  /** Resolves a user identity by Lark openId without requiring a known companyId (multi-tenant safe). */
  resolveByLarkOpenId(larkOpenId: string): Promise<Result<ResolvedUserIdentity | null, InfraError>>;
  /** Prepares a one-time OAuth link for a known Lark identity that has no active auth link yet. */
  prepareLarkLogin(larkOpenId: string): Promise<Result<PendingLarkLoginResolution | null, InfraError>>;
  /** Resolves a user identity by internal userId — used when only userId is known (e.g. approval resume). */
  resolveByUserId(userId: string): Promise<Result<ResolvedUserIdentity | null, InfraError>>;
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
    // Cache read — only non-null identities are cached (null = user may register soon).
    if (this.cache) {
      const cached = await this.cache.get<ResolvedUserIdentity>(identityCacheKey(larkOpenId));
      if (cached.ok && cached.value !== null) {
        return ok(cached.value);
      }
    }

    try {
      const ci = await this.db.channelIdentity.findFirst({
        where: { channel: 'lark', larkOpenId },
        select: { id: true, aiRole: true, channel: true, companyId: true },
      });
      if (!ci) return ok(null);

      const authLink = await this.db.larkUserAuthLink.findFirst({
        where: { larkOpenId },
        select: { userId: true },
      });
      if (!authLink) return ok(null);

      const deptPref = await this.db.userDepartmentPreference.findUnique({
        where: { userId: authLink.userId },
        select: { activeDepartmentId: true },
      });

      const resolved: ResolvedUserIdentity = {
        userId: authLink.userId,
        companyId: ci.companyId,
        aiRole: ci.aiRole,
        channel: ci.channel,
        larkOpenId,
        ...(deptPref?.activeDepartmentId ? { activeDepartmentId: deptPref.activeDepartmentId } : {}),
      };
      // Populate cache — fire-and-forget.
      if (this.cache) {
        void this.cache.set(identityCacheKey(larkOpenId), resolved, LARK_IDENTITY_TTL);
      }
      return ok(resolved);
    } catch (e) {
      return err(wrapInfra('prisma', 'resolveByLarkOpenId', e));
    }
  }

  /** Invalidate cached identity for a Lark user (call after OAuth link created/updated). */
  async invalidateIdentityCache(larkOpenId: string): Promise<void> {
    if (this.cache) {
      void this.cache.del(identityCacheKey(larkOpenId));
    }
  }

  async prepareLarkLogin(
    larkOpenId: string,
  ): Promise<Result<PendingLarkLoginResolution | null, InfraError>> {
    try {
      const ci = await this.db.channelIdentity.findFirst({
        where: { channel: 'lark', larkOpenId },
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
        return ok({
          status: 'ready',
          userId: existingUser.id,
          companyId: ci.companyId,
          aiRole: ci.aiRole,
          larkOpenId: ci.larkOpenId,
          ...(displayName ? { displayName } : {}),
          email,
          createdUser: false,
        });
      }

      const user = await this.db.user.create({
        data: {
          email,
          // Lark-first users authenticate through OAuth. This random password is
          // intentionally not user-facing and cannot be guessed for password login.
          password: `lark-oauth-pending:${randomBytes(32).toString('hex')}`,
          ...(displayName ? { name: displayName } : {}),
        },
        select: { id: true },
      });

      return ok({
        status: 'ready',
        userId: user.id,
        companyId: ci.companyId,
        aiRole: ci.aiRole,
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
  ): Promise<Result<ResolvedUserIdentity | null, InfraError>> {
    try {
      const authLink = await this.db.larkUserAuthLink.findFirst({
        where: { userId },
        select: { larkOpenId: true },
      });
      if (!authLink?.larkOpenId) return ok(null);

      const ci = await this.db.channelIdentity.findFirst({
        where: { channel: 'lark', larkOpenId: authLink.larkOpenId },
        select: { aiRole: true, channel: true, companyId: true },
      });
      if (!ci) return ok(null);

      const deptPref = await this.db.userDepartmentPreference.findUnique({
        where: { userId },
        select: { activeDepartmentId: true },
      });

      return ok({
        userId,
        companyId:  ci.companyId,
        aiRole:     ci.aiRole,
        channel:    ci.channel,
        larkOpenId: authLink.larkOpenId,
        ...(deptPref?.activeDepartmentId ? { activeDepartmentId: deptPref.activeDepartmentId } : {}),
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'resolveByUserId', e));
    }
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
