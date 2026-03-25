import { prisma } from '../../utils/prisma';
import { channelIdentityRepository } from '../channels/channel-identity.repository';
import { ZohoUserAccessExceptionRepository, zohoUserAccessExceptionRepository } from './zoho-user-access-exception.repository';

export type ZohoUserAccessExceptionDTO = {
  id: string;
  companyId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  channelIdentityId?: string;
  channelDisplayName?: string;
  channelEmail?: string;
  bypassRelationScope: boolean;
  reason?: string;
  expiresAt?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

const normalizeEmail = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

export class ZohoUserAccessExceptionService {
  constructor(private readonly repo: ZohoUserAccessExceptionRepository = zohoUserAccessExceptionRepository) {}

  async listByCompany(companyId: string): Promise<ZohoUserAccessExceptionDTO[]> {
    const rows = await this.repo.listByCompany(companyId);
    const userIds = [...new Set(rows.map((row) => row.userId).filter((value: unknown): value is string => typeof value === 'string'))];
    const users = userIds.length > 0
      ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      })
      : [];
    const userMap = new Map(users.map((user) => [user.id, user]));
    const emails = [...new Set(users.map((user) => normalizeEmail(user.email)).filter((value): value is string => Boolean(value)))];
    const identities = emails.length > 0
      ? await prisma.channelIdentity.findMany({
        where: {
          companyId,
          channel: 'lark',
          OR: emails.map((email) => ({
            email: {
              equals: email,
              mode: 'insensitive' as const,
            },
          })),
        },
        select: { id: true, email: true, displayName: true },
      })
      : [];
    const identityByEmail = new Map(
      identities
        .map((identity) => [normalizeEmail(identity.email), identity] as const)
        .filter((entry): entry is readonly [string, { id: string; email: string | null; displayName: string | null }] => Boolean(entry[0])),
    );
    return rows.map((row) => {
      const user = userMap.get(row.userId);
      const identity = user?.email ? identityByEmail.get(normalizeEmail(user.email) ?? '') : undefined;
      return {
        id: row.id,
        companyId: row.companyId,
        userId: row.userId,
        userName: user?.name ?? undefined,
        userEmail: user?.email ?? undefined,
        channelIdentityId: identity?.id,
        channelDisplayName: identity?.displayName ?? undefined,
        channelEmail: identity?.email ?? undefined,
        bypassRelationScope: Boolean(row.bypassRelationScope),
        reason: typeof row.reason === 'string' && row.reason.length > 0 ? row.reason : undefined,
        expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : undefined,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async resolveActiveException(companyId: string, userId?: string, now = new Date()) {
    if (!userId) {
      return null;
    }
    return this.repo.findActiveByUser(companyId, userId, now);
  }

  async upsert(input: {
    companyId: string;
    userId?: string;
    channelIdentityId?: string;
    bypassRelationScope?: boolean;
    reason?: string;
    expiresAt?: string;
    actorId: string;
  }): Promise<ZohoUserAccessExceptionDTO> {
    const resolvedUserId = input.userId ?? await this.resolveUserIdFromChannelIdentity(input.companyId, input.channelIdentityId);
    if (!resolvedUserId) {
      throw new Error('A linked app user is required before creating a Zoho access exception.');
    }
    const row = await this.repo.upsert({
      companyId: input.companyId,
      userId: resolvedUserId,
      bypassRelationScope: input.bypassRelationScope ?? true,
      reason: input.reason?.trim() || null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      actorId: input.actorId,
    });
    const refreshed = (await this.listByCompany(input.companyId)).find((entry) => entry.id === row.id);
    if (!refreshed) {
      throw new Error('Zoho access exception was saved but could not be reloaded.');
    }
    return refreshed;
  }

  async delete(id: string, companyId: string) {
    const existing = await this.repo.findById(id);
    if (!existing) {
      throw new Error('Zoho access exception was not found.');
    }
    if (existing.companyId !== companyId) {
      throw new Error('Zoho access exception does not belong to the selected company.');
    }
    return this.repo.delete(id);
  }

  private async resolveUserIdFromChannelIdentity(companyId: string, channelIdentityId?: string): Promise<string | undefined> {
    if (!channelIdentityId) {
      return undefined;
    }
    const identity = await channelIdentityRepository.findById(channelIdentityId);
    if (!identity || identity.companyId !== companyId) {
      throw new Error('Channel identity not found for this company.');
    }
    const email = normalizeEmail(identity.email);
    if (!email) {
      throw new Error('Channel identity must have an email before creating a Zoho access exception.');
    }
    const user = await prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
      select: { id: true },
    });
    if (!user) {
      throw new Error('No linked app user exists for this channel identity yet.');
    }
    return user.id;
  }
}

export const zohoUserAccessExceptionService = new ZohoUserAccessExceptionService();
