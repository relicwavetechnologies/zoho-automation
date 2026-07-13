import { createHash } from 'node:crypto';
import type { PrismaClient, CompanySerperConnection } from '../../generated/prisma';
import { decryptToken, encryptToken } from '../shared/token.crypto';

export const serperKeyFingerprint = (apiKey: string): string =>
  createHash('sha256').update(apiKey.trim()).digest('hex');

export type SafeSerperConnection = Pick<CompanySerperConnection,
  'id' | 'label' | 'status' | 'priority' | 'lastTestedAt' | 'lastSucceededAt' |
  'lastFailureAt' | 'lastFailureCode' | 'lastUsedAt' | 'createdAt' | 'updatedAt'>;

export class CompanySerperConnectionRepository {
  constructor(private readonly prisma: PrismaClient, private readonly encryptionKey: string) {}

  async list(companyId: string): Promise<SafeSerperConnection[]> {
    return this.prisma.companySerperConnection.findMany({
      where: { companyId, revokedAt: null },
      select: { id: true, label: true, status: true, priority: true, lastTestedAt: true, lastSucceededAt: true, lastFailureAt: true, lastFailureCode: true, lastUsedAt: true, createdAt: true, updatedAt: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async activeKeys(companyId: string): Promise<Array<{ id: string; apiKey: string }>> {
    const rows = await this.prisma.companySerperConnection.findMany({
      where: { companyId, status: 'connected', revokedAt: null },
      select: { id: true, apiKeyEncrypted: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(row => ({ id: row.id, apiKey: decryptToken(row.apiKeyEncrypted, this.encryptionKey) }));
  }

  async saveVerified(input: { companyId: string; userId: string; label: string; apiKey: string }): Promise<SafeSerperConnection> {
    const fingerprint = serperKeyFingerprint(input.apiKey);
    const existing = await this.prisma.companySerperConnection.findUnique({ where: { companyId_keyFingerprint: { companyId: input.companyId, keyFingerprint: fingerprint } } });
    const highest = await this.prisma.companySerperConnection.aggregate({ where: { companyId: input.companyId, revokedAt: null }, _max: { priority: true } });
    const data = { label: input.label.trim(), apiKeyEncrypted: encryptToken(input.apiKey, this.encryptionKey).cipherText, status: 'connected', lastTestedAt: new Date(), lastSucceededAt: new Date(), lastFailureAt: null, lastFailureCode: null, revokedAt: null };
    const row = existing
      ? await this.prisma.companySerperConnection.update({ where: { id: existing.id }, data })
      : await this.prisma.companySerperConnection.create({ data: { companyId: input.companyId, createdBy: input.userId, keyFingerprint: fingerprint, priority: (highest._max.priority ?? -1) + 1, ...data } });
    return row;
  }

  async setStatus(companyId: string, id: string, status: 'connected' | 'disabled'): Promise<SafeSerperConnection | null> {
    const found = await this.prisma.companySerperConnection.findFirst({ where: { id, companyId, revokedAt: null } });
    return found ? this.prisma.companySerperConnection.update({ where: { id }, data: { status } }) : null;
  }

  async revoke(companyId: string, id: string): Promise<boolean> {
    const result = await this.prisma.companySerperConnection.updateMany({ where: { id, companyId, revokedAt: null }, data: { revokedAt: new Date(), status: 'revoked' } });
    return result.count === 1;
  }

  async markSuccess(id: string): Promise<void> { await this.prisma.companySerperConnection.update({ where: { id }, data: { lastUsedAt: new Date(), lastFailureAt: null, lastFailureCode: null } }); }
  async markFailure(id: string, code: string): Promise<void> { await this.prisma.companySerperConnection.update({ where: { id }, data: { lastFailureAt: new Date(), lastFailureCode: code } }); }
}
