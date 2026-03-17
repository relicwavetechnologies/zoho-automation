import type { Prisma } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';
import { decryptZohoSecret, encryptZohoSecret } from '../../integrations/zoho/zoho-token.crypto';

export type DecryptedGoogleUserAuthLink = {
  id: string;
  userId: string;
  companyId: string;
  googleUserId?: string;
  googleEmail?: string;
  googleName?: string;
  scope?: string;
  scopes: string[];
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

type UpsertGoogleUserAuthLinkInput = {
  userId: string;
  companyId: string;
  googleUserId?: string;
  googleEmail?: string;
  googleName?: string;
  scope?: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  tokenMetadata?: Record<string, unknown>;
};

const toScopes = (scope?: string | null): string[] =>
  scope?.split(' ').map((value) => value.trim()).filter(Boolean) ?? [];

const toDecrypted = (record: Awaited<ReturnType<typeof prisma.googleUserAuthLink.findUnique>>): DecryptedGoogleUserAuthLink | null => {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    userId: record.userId,
    companyId: record.companyId,
    googleUserId: record.googleUserId ?? undefined,
    googleEmail: record.googleEmail ?? undefined,
    googleName: record.googleName ?? undefined,
    scope: record.scope ?? undefined,
    scopes: toScopes(record.scope),
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

class GoogleUserAuthLinkRepository {
  async upsert(input: UpsertGoogleUserAuthLinkInput): Promise<DecryptedGoogleUserAuthLink> {
    const encryptedAccess = encryptZohoSecret(input.accessToken);
    const encryptedRefresh = input.refreshToken ? encryptZohoSecret(input.refreshToken) : undefined;

    const updateData: Prisma.GoogleUserAuthLinkUpdateInput = {
      googleUserId: input.googleUserId,
      googleEmail: input.googleEmail,
      googleName: input.googleName,
      scope: input.scope,
      accessTokenEncrypted: encryptedAccess.cipherText,
      tokenType: input.tokenType,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
      tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue | undefined,
      revokedAt: null,
      linkedAt: new Date(),
    };

    if (encryptedRefresh) {
      updateData.refreshTokenEncrypted = encryptedRefresh.cipherText;
    }

    const record = await prisma.googleUserAuthLink.upsert({
      where: {
        userId_companyId: {
          userId: input.userId,
          companyId: input.companyId,
        },
      },
      create: {
        userId: input.userId,
        companyId: input.companyId,
        googleUserId: input.googleUserId,
        googleEmail: input.googleEmail,
        googleName: input.googleName,
        scope: input.scope,
        accessTokenEncrypted: encryptedAccess.cipherText,
        refreshTokenEncrypted: encryptedRefresh?.cipherText,
        tokenType: input.tokenType,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt,
        tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue | undefined,
        revokedAt: null,
        linkedAt: new Date(),
      },
      update: updateData,
    });

    return toDecrypted(record)!;
  }

  async findActiveByUser(userId: string, companyId: string): Promise<DecryptedGoogleUserAuthLink | null> {
    const record = await prisma.googleUserAuthLink.findUnique({
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
    await prisma.googleUserAuthLink.update({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  }

  async revokeByUser(userId: string, companyId: string): Promise<void> {
    await prisma.googleUserAuthLink.updateMany({
      where: { userId, companyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export const googleUserAuthLinkRepository = new GoogleUserAuthLinkRepository();
