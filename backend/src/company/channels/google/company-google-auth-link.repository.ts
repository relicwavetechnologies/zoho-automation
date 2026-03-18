import type { Prisma } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';
import { decryptZohoSecret, encryptZohoSecret } from '../../integrations/zoho/zoho-token.crypto';

export type DecryptedCompanyGoogleAuthLink = {
  id: string;
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
  linkedByUserId?: string;
  linkedAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
  updatedAt: Date;
};

type UpsertCompanyGoogleAuthLinkInput = {
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
  linkedByUserId?: string;
};

const toScopes = (scope?: string | null): string[] =>
  scope?.split(' ').map((value) => value.trim()).filter(Boolean) ?? [];

const toDecrypted = (
  record: Awaited<ReturnType<typeof prisma.companyGoogleAuthLink.findUnique>>,
): DecryptedCompanyGoogleAuthLink | null => {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
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
    linkedByUserId: record.linkedByUserId ?? undefined,
    linkedAt: record.linkedAt,
    lastUsedAt: record.lastUsedAt ?? undefined,
    revokedAt: record.revokedAt ?? undefined,
    updatedAt: record.updatedAt,
  };
};

class CompanyGoogleAuthLinkRepository {
  async upsert(input: UpsertCompanyGoogleAuthLinkInput): Promise<DecryptedCompanyGoogleAuthLink> {
    const encryptedAccess = encryptZohoSecret(input.accessToken);
    const encryptedRefresh = input.refreshToken ? encryptZohoSecret(input.refreshToken) : undefined;

    const updateData: Prisma.CompanyGoogleAuthLinkUpdateInput = {
      googleUserId: input.googleUserId,
      googleEmail: input.googleEmail,
      googleName: input.googleName,
      scope: input.scope,
      accessTokenEncrypted: encryptedAccess.cipherText,
      tokenType: input.tokenType,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
      tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue | undefined,
      linkedByUserId: input.linkedByUserId,
      revokedAt: null,
      linkedAt: new Date(),
    };

    if (encryptedRefresh) {
      updateData.refreshTokenEncrypted = encryptedRefresh.cipherText;
    }

    const record = await prisma.companyGoogleAuthLink.upsert({
      where: {
        companyId: input.companyId,
      },
      create: {
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
        linkedByUserId: input.linkedByUserId,
        revokedAt: null,
        linkedAt: new Date(),
      },
      update: updateData,
    });

    return toDecrypted(record)!;
  }

  async findActiveByCompany(companyId: string): Promise<DecryptedCompanyGoogleAuthLink | null> {
    const record = await prisma.companyGoogleAuthLink.findUnique({
      where: {
        companyId,
      },
    });
    if (!record || record.revokedAt) {
      return null;
    }
    return toDecrypted(record);
  }

  async touchLastUsed(id: string): Promise<void> {
    await prisma.companyGoogleAuthLink.update({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  }

  async revokeByCompany(companyId: string): Promise<void> {
    await prisma.companyGoogleAuthLink.updateMany({
      where: { companyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export const companyGoogleAuthLinkRepository = new CompanyGoogleAuthLinkRepository();
