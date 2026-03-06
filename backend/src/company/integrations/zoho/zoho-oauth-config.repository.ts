import { prisma } from '../../../utils/prisma';
import { decryptZohoSecret, encryptZohoSecret } from './zoho-token.crypto';

export type ZohoOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accountsBaseUrl: string;
  apiBaseUrl: string;
};

class ZohoOAuthConfigRepository {
  private getModel() {
    const model = (prisma as unknown as { zohoOAuthConfig?: typeof prisma.zohoOAuthConfig }).zohoOAuthConfig;
    return model;
  }

  async upsert(
    companyId: string,
    input: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      accountsBaseUrl?: string;
      apiBaseUrl?: string;
    },
  ) {
    const model = this.getModel();
    if (!model) {
      throw new Error('zohoOAuthConfig model is not available in Prisma client');
    }
    const encrypted = encryptZohoSecret(input.clientSecret);
    const data = {
      clientId: input.clientId.trim(),
      clientSecretEncrypted: encrypted.cipherText,
      redirectUri: input.redirectUri.trim(),
      accountsBaseUrl: (input.accountsBaseUrl?.trim() || 'https://accounts.zoho.com'),
      apiBaseUrl: (input.apiBaseUrl?.trim() || 'https://www.zohoapis.com'),
    };

    return model.upsert({
      where: { companyId },
      create: { companyId, ...data },
      update: data,
    });
  }

  async findByCompanyId(companyId: string) {
    const model = this.getModel();
    if (!model) {
      return null;
    }
    return model.findUnique({ where: { companyId } });
  }

  async getCredentials(companyId: string): Promise<ZohoOAuthCredentials | null> {
    const record = await this.findByCompanyId(companyId);
    if (!record) return null;
    return {
      clientId: record.clientId,
      clientSecret: decryptZohoSecret(record.clientSecretEncrypted),
      redirectUri: record.redirectUri,
      accountsBaseUrl: record.accountsBaseUrl,
      apiBaseUrl: record.apiBaseUrl,
    };
  }

  async getStatus(companyId: string) {
    const record = await this.findByCompanyId(companyId);
    if (!record) return null;
    return {
      configured: true,
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      accountsBaseUrl: record.accountsBaseUrl,
      apiBaseUrl: record.apiBaseUrl,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async delete(companyId: string) {
    const model = this.getModel();
    if (!model) {
      throw new Error('zohoOAuthConfig model is not available in Prisma client');
    }
    return model.delete({ where: { companyId } });
  }
}

export const zohoOAuthConfigRepository = new ZohoOAuthConfigRepository();
