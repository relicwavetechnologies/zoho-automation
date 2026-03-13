import { prisma } from '../../utils/prisma';

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

class ChannelIdentityRepository {
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
          ...(input.email !== undefined ? { email: input.email } : {}),
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
          email: input.email,
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
