import { prisma } from '../../../utils/prisma';
import { decryptZohoSecret, encryptZohoSecret } from '../../integrations/zoho/zoho-token.crypto';

type UpsertLarkWorkspaceConfigInput = {
  companyId: string;
  createdBy: string;
  appId: string;
  appSecret: string;
  verificationToken?: string;
  signingSecret?: string;
  staticTenantAccessToken?: string;
  apiBaseUrl?: string;
};

export type DecryptedLarkWorkspaceConfig = {
  companyId: string;
  appId: string;
  appSecret: string;
  verificationToken?: string;
  signingSecret?: string;
  staticTenantAccessToken?: string;
  apiBaseUrl: string;
  updatedAt: Date;
};

class LarkWorkspaceConfigRepository {
  async upsert(input: UpsertLarkWorkspaceConfigInput) {
    const appSecretEncrypted = encryptZohoSecret(input.appSecret).cipherText;
    const verificationTokenEncrypted = input.verificationToken
      ? encryptZohoSecret(input.verificationToken).cipherText
      : null;
    const signingSecretEncrypted = input.signingSecret
      ? encryptZohoSecret(input.signingSecret).cipherText
      : null;
    const staticTenantAccessTokenEncrypted = input.staticTenantAccessToken
      ? encryptZohoSecret(input.staticTenantAccessToken).cipherText
      : null;

    return prisma.larkWorkspaceConfig.upsert({
      where: { companyId: input.companyId },
      create: {
        companyId: input.companyId,
        createdBy: input.createdBy,
        appId: input.appId,
        appSecretEncrypted,
        verificationTokenEncrypted,
        signingSecretEncrypted,
        staticTenantAccessTokenEncrypted,
        apiBaseUrl: input.apiBaseUrl,
      },
      update: {
        appId: input.appId,
        appSecretEncrypted,
        verificationTokenEncrypted,
        signingSecretEncrypted,
        staticTenantAccessTokenEncrypted,
        ...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
      },
    });
  }

  async findRawByCompanyId(companyId: string) {
    return prisma.larkWorkspaceConfig.findUnique({
      where: { companyId },
    });
  }

  async findByCompanyId(companyId: string): Promise<DecryptedLarkWorkspaceConfig | null> {
    const record = await this.findRawByCompanyId(companyId);
    if (!record) {
      return null;
    }

    return {
      companyId: record.companyId,
      appId: record.appId,
      appSecret: decryptZohoSecret(record.appSecretEncrypted),
      verificationToken: record.verificationTokenEncrypted
        ? decryptZohoSecret(record.verificationTokenEncrypted)
        : undefined,
      signingSecret: record.signingSecretEncrypted
        ? decryptZohoSecret(record.signingSecretEncrypted)
        : undefined,
      staticTenantAccessToken: record.staticTenantAccessTokenEncrypted
        ? decryptZohoSecret(record.staticTenantAccessTokenEncrypted)
        : undefined,
      apiBaseUrl: record.apiBaseUrl,
      updatedAt: record.updatedAt,
    };
  }

  async getStatus(companyId: string) {
    const record = await prisma.larkWorkspaceConfig.findUnique({
      where: { companyId },
      select: {
        companyId: true,
        appId: true,
        apiBaseUrl: true,
        verificationTokenEncrypted: true,
        signingSecretEncrypted: true,
        staticTenantAccessTokenEncrypted: true,
        updatedAt: true,
      },
    });

    if (!record) {
      return null;
    }

    return {
      configured: true,
      companyId: record.companyId,
      appId: record.appId,
      apiBaseUrl: record.apiBaseUrl,
      hasVerificationToken: Boolean(record.verificationTokenEncrypted),
      hasSigningSecret: Boolean(record.signingSecretEncrypted),
      hasStaticTenantAccessToken: Boolean(record.staticTenantAccessTokenEncrypted),
      updatedAt: record.updatedAt,
    };
  }

  async delete(companyId: string) {
    await prisma.larkWorkspaceConfig.deleteMany({
      where: { companyId },
    });
  }

  async listConfiguredCompanyIds() {
    const rows = await prisma.larkWorkspaceConfig.findMany({
      select: { companyId: true },
    });
    return rows.map((row) => row.companyId);
  }
}

export const larkWorkspaceConfigRepository = new LarkWorkspaceConfigRepository();
