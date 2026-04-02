import { prisma } from '../../utils/prisma';
import { redDebug } from '../../utils/red-debug';

type UpsertChannelIdentityInput = {
  channel: string;
  externalUserId: string;
  externalTenantId: string;
  companyId: string;
  displayName?: string;
  email?: string;
  larkOpenId?: string;
  larkUserId?: string;
  sourceRoles?: string[];
  aiRole?: string;
  aiRoleSource?: 'sync' | 'manual';
  syncedAiRole?: string;
  syncedFromLarkRole?: string;
};

const CONTACT_QUERY_STOPWORDS = new Set([
  'search',
  'find',
  'lookup',
  'look',
  'up',
  'for',
  'contact',
  'contacts',
  'detail',
  'details',
  'email',
  'emails',
  'mail',
  'phone',
  'mobile',
  'number',
  'numbers',
  'info',
  'information',
  'sir',
  'madam',
  'please',
  'plz',
  'good',
  'now',
  'and',
]);

const extractContactTargets = (query: string): string[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const segments = normalized
    .replace(/\b(contact details?|contact info|email ids?|phone numbers?)\b/gi, ' ')
    .split(/,|\band\b|&|\n/gi)
    .map((segment) =>
      segment
        .split(/[^a-z0-9@._-]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !CONTACT_QUERY_STOPWORDS.has(token))
        .join(' ')
        .trim(),
    )
    .filter(Boolean);

  return Array.from(new Set(segments)).slice(0, 8);
};

const extractSearchTokens = (query: string): string[] =>
  Array.from(new Set(
    query
      .split(/[^a-z0-9@._-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !CONTACT_QUERY_STOPWORDS.has(token))
      .flatMap((token) => {
        const expanded = [token];
        if (token.length >= 4) {
          expanded.push(token.slice(0, 3));
        }
        if (token.length >= 5) {
          expanded.push(token.slice(0, 5));
        }
        if (token.length >= 6) {
          expanded.push(token.slice(0, 4));
        }
        return expanded;
      }),
  )).slice(0, 20);

const normalizeName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const levenshteinDistance = (left: string, right: string): number => {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const previous = new Array(right.length + 1).fill(0).map((_, index) => index);
  const current = new Array(right.length + 1).fill(0);

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + substitutionCost,
      );
    }
    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = current[column];
    }
  }

  return previous[right.length] ?? Math.max(left.length, right.length);
};

const similarityScore = (left: string, right: string): number => {
  const normalizedLeft = normalizeName(left);
  const normalizedRight = normalizeName(right);
  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }
  if (normalizedLeft === normalizedRight) {
    return 1;
  }
  const distance = levenshteinDistance(normalizedLeft, normalizedRight);
  return 1 - (distance / Math.max(normalizedLeft.length, normalizedRight.length, 1));
};

const scoreContactRow = (
  row: { displayName: string | null; email: string | null },
  tokens: string[],
  target?: string,
): number => {
  const displayName = (row.displayName ?? '').toLowerCase();
  const email = (row.email ?? '').toLowerCase();
  const haystack = `${displayName} ${email}`.trim();
  let total = 0;

  for (const token of tokens) {
    if (!token) continue;
    if (haystack === token) total += 12;
    else if (email === token) total += 11;
    else if (displayName === token) total += 10;
    else if (displayName.startsWith(`${token} `) || displayName.endsWith(` ${token}`) || displayName === token) total += 8;
    else if (email.startsWith(`${token}@`)) total += 7;
    else if (email.includes(token)) total += 5;
    else if (displayName.includes(token)) total += 4;
  }

  if (target) {
    const displaySimilarity = similarityScore(target, row.displayName ?? '');
    const firstNameSimilarity = similarityScore(
      normalizeName(target).split(/\s+/)[0] ?? '',
      normalizeName(row.displayName ?? '').split(/\s+/)[0] ?? '',
    );
    if (displaySimilarity >= 0.92) total += 18;
    else if (displaySimilarity >= 0.82) total += 12;
    else if (displaySimilarity >= 0.72) total += 8;

    if (firstNameSimilarity >= 0.92) total += 14;
    else if (firstNameSimilarity >= 0.82) total += 10;
    else if (firstNameSimilarity >= 0.72) total += 6;
  }

  return total;
};

class ChannelIdentityRepository {
  async searchLarkContacts(input: {
    companyId: string;
    query: string;
    limit?: number;
  }) {
    const normalized = input.query.trim().toLowerCase();
    const requestedLimit = Math.max(1, Math.min(input.limit ?? 5, 20));
    const targets = extractContactTargets(normalized);
    redDebug('channel_identity.search_lark_contacts.start', {
      companyId: input.companyId,
      query: input.query,
      normalizedQuery: normalized,
      limit: requestedLimit,
      targets,
    });
    if (!normalized) {
      return [];
    }

    const tokens = extractSearchTokens(normalized);

    if (tokens.length === 0) {
      return [];
    }
    redDebug('channel_identity.search_lark_contacts.tokens', {
      companyId: input.companyId,
      query: input.query,
      tokens,
    });

    const broadRows = await prisma.channelIdentity.findMany({
      where: {
        companyId: input.companyId,
        channel: 'lark',
        OR: tokens.flatMap((token) => ([
          { displayName: { contains: token, mode: 'insensitive' as const } },
          { email: { contains: token, mode: 'insensitive' as const } },
        ])),
      },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: Math.min(Math.max(requestedLimit * 8, targets.length * 8, 32), 120),
    });

    const perTargetRowGroups = await Promise.all(
      targets.map(async (target) => {
        const targetTokens = extractSearchTokens(target);
        if (targetTokens.length === 0) {
          return [];
        }
        return prisma.channelIdentity.findMany({
          where: {
            companyId: input.companyId,
            channel: 'lark',
            OR: targetTokens.flatMap((token) => ([
              { displayName: { contains: token, mode: 'insensitive' as const } },
              { email: { contains: token, mode: 'insensitive' as const } },
            ])),
          },
          orderBy: [
            { updatedAt: 'desc' },
            { createdAt: 'desc' },
          ],
          take: 20,
        });
      }),
    );

    const rowsById = new Map<string, (typeof broadRows)[number]>();
    for (const row of broadRows) {
      rowsById.set(row.id, row);
    }
    for (const row of perTargetRowGroups.flat()) {
      rowsById.set(row.id, row);
    }
    const rows = Array.from(rowsById.values());
    redDebug('channel_identity.search_lark_contacts.rows', {
      companyId: input.companyId,
      query: input.query,
      rowCount: rows.length,
      sample: rows.slice(0, 5).map((row) => ({
        displayName: row.displayName,
        email: row.email,
        larkOpenId: row.larkOpenId,
        larkUserId: row.larkUserId,
      })),
    });

    const globallyRanked = rows
      .map((row) => ({ row, score: scoreContactRow(row, tokens) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);

    const coveredIds = new Set<string>();
    const coverageRanked: typeof globallyRanked = [];

    for (const target of targets) {
      const targetTokens = extractSearchTokens(target);
      if (targetTokens.length === 0) {
        continue;
      }
      const bestMatch = rows
        .map((row) => ({ row, score: scoreContactRow(row, targetTokens, target) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score)[0];
      const bestId = bestMatch?.row.id;
      if (!bestMatch || !bestId || coveredIds.has(bestId)) {
        continue;
      }
      coveredIds.add(bestId);
      coverageRanked.push(bestMatch);
    }

    const ranked = [
      ...coverageRanked,
      ...globallyRanked.filter(({ row }) => !coveredIds.has(row.id)),
    ]
      .slice(0, requestedLimit)
      .map(({ row }) => row);
    redDebug('channel_identity.search_lark_contacts.ranked', {
      companyId: input.companyId,
      query: input.query,
      rowCount: ranked.length,
      sample: ranked.slice(0, 5).map((row) => ({
        displayName: row.displayName,
        email: row.email,
        larkOpenId: row.larkOpenId,
      })),
    });
    return ranked;
  }

  async upsert(input: UpsertChannelIdentityInput) {
    const existing =
      (await prisma.channelIdentity.findUnique({
        where: {
          channel_externalUserId_companyId: {
            channel: input.channel,
            externalUserId: input.externalUserId,
            companyId: input.companyId,
          },
        },
      }))
      ?? (input.channel === 'lark' && (input.larkOpenId || input.larkUserId)
        ? await prisma.channelIdentity.findFirst({
          where: {
            companyId: input.companyId,
            channel: input.channel,
            OR: [
              ...(input.larkOpenId ? [{ larkOpenId: input.larkOpenId }] : []),
              ...(input.larkUserId ? [{ larkUserId: input.larkUserId }] : []),
            ],
          },
        })
        : null);

    const row = existing
      ? await prisma.channelIdentity.update({
        where: { id: existing.id },
        data: {
          externalUserId: input.externalUserId,
          externalTenantId: input.externalTenantId,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(typeof input.email === 'string' && input.email.trim().length > 0 ? { email: input.email.trim() } : {}),
          ...(input.larkOpenId !== undefined ? { larkOpenId: input.larkOpenId } : {}),
          ...(input.larkUserId !== undefined ? { larkUserId: input.larkUserId } : {}),
          ...(input.sourceRoles !== undefined ? { sourceRoles: input.sourceRoles } : {}),
          ...(input.syncedAiRole !== undefined ? { syncedAiRole: input.syncedAiRole } : {}),
          ...(input.syncedFromLarkRole !== undefined ? { syncedFromLarkRole: input.syncedFromLarkRole } : {}),
          ...(
            existing.aiRoleSource === 'manual'
              ? {}
              : input.syncedAiRole
                ? { aiRole: input.syncedAiRole, aiRoleSource: 'sync' }
                : input.aiRole
                  ? { aiRole: input.aiRole, aiRoleSource: input.aiRoleSource ?? 'sync' }
                  : {}
          ),
        },
      })
      : await prisma.channelIdentity.create({
        data: {
          channel: input.channel,
          externalUserId: input.externalUserId,
          externalTenantId: input.externalTenantId,
          companyId: input.companyId,
          displayName: input.displayName,
          email: typeof input.email === 'string' && input.email.trim().length > 0 ? input.email.trim() : undefined,
          larkOpenId: input.larkOpenId,
          larkUserId: input.larkUserId,
          sourceRoles: input.sourceRoles ?? [],
          aiRole: input.aiRole ?? input.syncedAiRole ?? 'MEMBER',
          aiRoleSource: input.aiRoleSource ?? 'sync',
          syncedAiRole: input.syncedAiRole,
          syncedFromLarkRole: input.syncedFromLarkRole,
        },
      });
    const isNew = !existing;
    return {
      ...row,
      isNew,
      manualOverridePreserved: Boolean(existing && existing.aiRoleSource === 'manual' && input.syncedAiRole),
    };
  }

  async findById(id: string) {
    return prisma.channelIdentity.findUnique({
      where: { id },
    });
  }

  async listByCompany(companyId: string, channel?: string) {
    return prisma.channelIdentity.findMany({
      where: {
        companyId,
        ...(channel ? { channel } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByExternalUser(channel: string, externalUserId: string, companyId: string) {
    return prisma.channelIdentity.findUnique({
      where: { channel_externalUserId_companyId: { channel, externalUserId, companyId } },
    });
  }

  async findLarkIdentityForProvisioning(input: {
    companyId: string;
    externalUserId?: string;
    larkOpenId?: string;
    larkUserId?: string;
    email?: string;
  }) {
    const orConditions = [
      ...(input.externalUserId ? [{ externalUserId: input.externalUserId }] : []),
      ...(input.larkOpenId ? [{ larkOpenId: input.larkOpenId }] : []),
      ...(input.larkUserId ? [{ larkUserId: input.larkUserId }] : []),
      ...(input.email ? [{ email: input.email }] : []),
    ];

    if (orConditions.length === 0) {
      return null;
    }

    return prisma.channelIdentity.findFirst({
      where: {
        companyId: input.companyId,
        channel: 'lark',
        OR: orConditions,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async setAiRole(id: string, aiRole: string) {
    return prisma.channelIdentity.update({
      where: { id },
      data: { aiRole, aiRoleSource: 'manual' },
    });
  }

  async resetAiRoleToSynced(id: string) {
    const row = await prisma.channelIdentity.findUnique({
      where: { id },
      select: { syncedAiRole: true },
    });
    return prisma.channelIdentity.update({
      where: { id },
      data: {
        aiRole: row?.syncedAiRole ?? 'MEMBER',
        aiRoleSource: 'sync',
      },
    });
  }

  async findByLarkUserInfo(input: {
    companyId: string;
    larkTenantKey: string;
    externalUserId: string;
  }) {
    return prisma.channelIdentity.findFirst({
      where: {
        companyId: input.companyId,
        channel: 'lark',
        externalTenantId: input.larkTenantKey,
        externalUserId: input.externalUserId,
      },
      select: { id: true, externalUserId: true, aiRole: true, email: true },
    });
  }

  /**
   * Returns all channel identities for the company that have an admin AI role
   * and a valid Lark Open ID so we can send them direct messages.
   */
  async findAdminsByCompany(companyId: string): Promise<Array<{
    id: string;
    larkOpenId: string;
    displayName: string | null;
    email: string | null;
  }>> {
    const rows = await prisma.channelIdentity.findMany({
      where: {
        companyId,
        channel: 'lark',
        aiRole: { in: ['COMPANY_ADMIN', 'SUPER_ADMIN'] },
        larkOpenId: { not: null },
      },
      select: { id: true, larkOpenId: true, displayName: true, email: true },
    });
    return rows
      .filter((r): r is { id: string; larkOpenId: string; displayName: string | null; email: string | null } =>
        typeof r.larkOpenId === 'string')
      .map((r) => ({ id: r.id, larkOpenId: r.larkOpenId, displayName: r.displayName, email: r.email }));
  }
}

export const channelIdentityRepository = new ChannelIdentityRepository();
