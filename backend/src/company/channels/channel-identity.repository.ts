import { prisma } from '../../utils/prisma';

type UpsertChannelIdentityInput = {
  channel: string;
  externalUserId: string;
  externalTenantId: string;
  companyId: string;
  displayName?: string;
  email?: string;
};

class ChannelIdentityRepository {
  async upsert(input: UpsertChannelIdentityInput) {
    const row = await prisma.channelIdentity.upsert({
      where: {
        channel_externalUserId_companyId: {
          channel: input.channel,
          externalUserId: input.externalUserId,
          companyId: input.companyId,
        },
      },
      create: {
        channel: input.channel,
        externalUserId: input.externalUserId,
        externalTenantId: input.externalTenantId,
        companyId: input.companyId,
        displayName: input.displayName,
        email: input.email,
      },
      update: {
        externalTenantId: input.externalTenantId,
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
      },
    });
    // createdAt === updatedAt means Prisma just ran the CREATE branch
    const isNew = row.createdAt.getTime() === row.updatedAt.getTime();
    return { ...row, isNew };
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

  async setAiRole(id: string, aiRole: string) {
    return prisma.channelIdentity.update({
      where: { id },
      data: { aiRole },
    });
  }
}

export const channelIdentityRepository = new ChannelIdentityRepository();
