import type { Prisma } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';
import { decryptZohoSecret, encryptZohoSecret } from '../../integrations/zoho/zoho-token.crypto';

export type DecryptedLarkUserAuthLink = {
  id: string;
  userId: string;
  companyId: string;
  larkTenantKey: string;
  larkOpenId?: string;
  larkUserId?: string;
  larkEmail: string;
  larkName?: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  tokenMetadata?: Record<string, unknown>;
  linkedAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
  updatedAt: Date;
};

type UpsertLarkUserAuthLinkInput = {
  userId: string;
  companyId: string;
  larkTenantKey: string;
  larkOpenId?: string;
  larkUserId?: string;
  larkEmail: string;
  larkName?: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  tokenMetadata?: Record<string, unknown>;
};

const toDecrypted = (record: Awaited<ReturnType<typeof prisma.larkUserAuthLink.findUnique>>): DecryptedLarkUserAuthLink | null => {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    userId: record.userId,
    companyId: record.companyId,
    larkTenantKey: record.larkTenantKey,
    larkOpenId: record.larkOpenId ?? undefined,
    larkUserId: record.larkUserId ?? undefined,
    larkEmail: record.larkEmail,
    larkName: record.larkName ?? undefined,
    accessToken: decryptZohoSecret(record.accessTokenEncrypted),
    refreshToken: record.refreshTokenEncrypted ? decryptZohoSecret(record.refreshTokenEncrypted) : undefined,
    tokenType: record.tokenType ?? undefined,
    accessTokenExpiresAt: record.accessTokenExpiresAt ?? undefined,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt ?? undefined,
    tokenMetadata: (record.tokenMetadata as Record<string, unknown> | null) ?? undefined,
    linkedAt: record.linkedAt,
    lastUsedAt: record.lastUsedAt ?? undefined,
    revokedAt: record.revokedAt ?? undefined,
    updatedAt: record.updatedAt,
  };
};

class LarkUserAuthLinkRepository {
  async upsert(input: UpsertLarkUserAuthLinkInput): Promise<DecryptedLarkUserAuthLink> {
    const encryptedAccess = encryptZohoSecret(input.accessToken);
    const encryptedRefresh = input.refreshToken ? encryptZohoSecret(input.refreshToken) : undefined;

    const record = await prisma.larkUserAuthLink.upsert({
      where: {
        userId_companyId: {
          userId: input.userId,
          companyId: input.companyId,
        },
      },
      create: {
        userId: input.userId,
        companyId: input.companyId,
        larkTenantKey: input.larkTenantKey,
        larkOpenId: input.larkOpenId,
        larkUserId: input.larkUserId,
        larkEmail: input.larkEmail,
        larkName: input.larkName,
        accessTokenEncrypted: encryptedAccess.cipherText,
        refreshTokenEncrypted: encryptedRefresh?.cipherText,
        tokenType: input.tokenType,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt,
        tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue | undefined,
        revokedAt: null,
        linkedAt: new Date(),
      },
      update: {
        larkTenantKey: input.larkTenantKey,
        larkOpenId: input.larkOpenId,
        larkUserId: input.larkUserId,
        larkEmail: input.larkEmail,
        larkName: input.larkName,
        accessTokenEncrypted: encryptedAccess.cipherText,
        refreshTokenEncrypted: encryptedRefresh?.cipherText,
        tokenType: input.tokenType,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt,
        tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue | undefined,
        revokedAt: null,
        linkedAt: new Date(),
      },
    });

    return toDecrypted(record)!;
  }

  async findActiveByUser(userId: string, companyId: string): Promise<DecryptedLarkUserAuthLink | null> {
    const record = await prisma.larkUserAuthLink.findUnique({
      where: {
        userId_companyId: {
          userId,
          companyId,
        },
      },
    });
    if (!record || record.revokedAt) {
      return null;
    }
    return toDecrypted(record);
  }

  async touchLastUsed(id: string): Promise<void> {
    await prisma.larkUserAuthLink.update({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  }

  async revokeByUser(userId: string, companyId: string): Promise<void> {
    await prisma.larkUserAuthLink.updateMany({
      where: { userId, companyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export const larkUserAuthLinkRepository = new LarkUserAuthLinkRepository();
