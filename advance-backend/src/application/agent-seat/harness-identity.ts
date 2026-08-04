export type HarnessIdentityStore = {
  channelIdentity: {
    findMany(input: unknown): Promise<Array<{
      larkOpenId: string | null;
      displayName: string | null;
      email: string | null;
    }>>;
  };
};

export type HarnessTenantStore = {
  channelIdentity: {
    findMany(input: unknown): Promise<Array<{ externalTenantId: string }>>;
  };
};

export async function resolveHarnessOpenId(
  db: HarnessIdentityStore,
  selector: string,
): Promise<string> {
  const normalized = selector.trim();
  if (!normalized) {
    throw new Error('User selector is required');
  }
  const selectorFilter = normalized.startsWith('ou_')
    ? [{ larkOpenId: normalized }]
    : [
        { email: { equals: normalized, mode: 'insensitive' } },
        { displayName: { equals: normalized, mode: 'insensitive' } },
      ];
  const matches = await db.channelIdentity.findMany({
    where: {
      channel: 'lark',
      larkOpenId: { not: null },
      OR: selectorFilter,
    },
    select: { larkOpenId: true, displayName: true, email: true },
    orderBy: { updatedAt: 'desc' },
    take: 2,
  });
  if (matches.length === 0) {
    throw new Error(`No DB-linked Lark identity matches ${JSON.stringify(normalized)}`);
  }
  if (matches.length > 1) {
    throw new Error(`Lark identity ${JSON.stringify(normalized)} is ambiguous; pass its exact open_id`);
  }
  return matches[0]!.larkOpenId!;
}

export async function resolveHarnessTenantKey(
  db: HarnessTenantStore,
  companyId: string,
  larkOpenId: string,
): Promise<string> {
  const matches = await db.channelIdentity.findMany({
    where: { companyId, channel: 'lark', larkOpenId },
    select: { externalTenantId: true },
    distinct: ['externalTenantId'],
    take: 2,
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one Lark tenant for openId=${larkOpenId}; found ${matches.length}`);
  }
  return matches[0]!.externalTenantId;
}
