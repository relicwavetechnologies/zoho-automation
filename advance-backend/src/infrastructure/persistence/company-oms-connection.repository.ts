import { createHash } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import { decryptToken, encryptToken } from '../shared/token.crypto';

export const omsKeyFingerprint = (apiKey: string): string => createHash('sha256').update(apiKey.trim()).digest('hex');

export interface SafeOmsConnection {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly lastTestedAt: Date | null;
  readonly lastSucceededAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastFailureCode: string | null;
  readonly lastUsedAt: Date | null;
  readonly unavailableUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OmsConnectionSecret extends SafeOmsConnection {
  readonly apiKey: string;
}

/** Company-owned OMS webhook keys. Raw credentials never leave this repository. */
export class CompanyOmsConnectionRepository {
  constructor(private readonly prisma: PrismaClient, private readonly encryptionKey: string) {}

  async list(companyId: string): Promise<SafeOmsConnection[]> {
    const rows = await this.prisma.companyOmsConnection.findMany({
      where: { companyId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toSafeConnection);
  }

  async saveVerified(input: { companyId: string; userId: string; label: string; apiKey: string }): Promise<SafeOmsConnection> {
    const fingerprint = omsKeyFingerprint(input.apiKey);
    const now = new Date();
    const data = {
      label: input.label.trim(),
      apiKeyEncrypted: encryptToken(input.apiKey, this.encryptionKey).cipherText,
      status: 'connected',
      lastTestedAt: now,
      lastSucceededAt: now,
      lastFailureAt: null,
      lastFailureCode: null,
      unavailableUntil: null,
      revokedAt: null,
    };
    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.companyOmsConnection.upsert({
        where: { companyId_keyFingerprint: { companyId: input.companyId, keyFingerprint: fingerprint } },
        create: { companyId: input.companyId, createdBy: input.userId, keyFingerprint: fingerprint, ...data },
        update: data,
      });
      // Exactly one active key is permitted. This makes disable/revoke a real
      // company kill switch and avoids silent fallback to an older credential.
      await tx.companyOmsConnection.updateMany({
        where: { companyId: input.companyId, id: { not: saved.id }, revokedAt: null, status: 'connected' },
        data: { status: 'disabled' },
      });
      return saved;
    });
    return toSafeConnection(row);
  }

  async setStatus(companyId: string, id: string, status: 'connected' | 'disabled'): Promise<SafeOmsConnection | null> {
    const existing = await this.prisma.companyOmsConnection.findFirst({ where: { id, companyId, revokedAt: null } });
    if (!existing) return null;
    const row = await this.prisma.companyOmsConnection.update({
      where: { id },
      data: { status, ...(status === 'connected' ? { unavailableUntil: null } : {}) },
    });
    return toSafeConnection(row);
  }

  async revoke(companyId: string, id: string): Promise<boolean> {
    const result = await this.prisma.companyOmsConnection.updateMany({
      where: { id, companyId, revokedAt: null },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    return result.count === 1;
  }

  async findActive(companyId: string): Promise<OmsConnectionSecret | null> {
    const row = await this.prisma.companyOmsConnection.findFirst({
      where: {
        companyId,
        status: 'connected',
        revokedAt: null,
        OR: [{ unavailableUntil: null }, { unavailableUntil: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!row) return null;
    return { ...toSafeConnection(row), apiKey: decryptToken(row.apiKeyEncrypted, this.encryptionKey) };
  }

  async hasConfiguredConnection(companyId: string): Promise<boolean> {
    const row = await this.prisma.companyOmsConnection.findFirst({
      where: { companyId, revokedAt: null },
      select: { id: true },
    });
    return Boolean(row);
  }

  async markSuccess(connectionId: string): Promise<void> {
    await this.prisma.companyOmsConnection.update({
      where: { id: connectionId },
      data: { lastUsedAt: new Date(), lastSucceededAt: new Date(), lastFailureAt: null, lastFailureCode: null, unavailableUntil: null },
    });
  }

  async markFailure(connectionId: string, code: string, unavailableUntil?: Date): Promise<void> {
    await this.prisma.companyOmsConnection.update({
      where: { id: connectionId },
      data: { lastFailureAt: new Date(), lastFailureCode: code, ...(unavailableUntil ? { unavailableUntil } : {}) },
    });
  }
}

function toSafeConnection(row: {
  id: string; label: string; status: string; lastTestedAt: Date | null; lastSucceededAt: Date | null;
  lastFailureAt: Date | null; lastFailureCode: string | null; lastUsedAt: Date | null; unavailableUntil: Date | null; createdAt: Date; updatedAt: Date;
}): SafeOmsConnection {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    lastTestedAt: row.lastTestedAt,
    lastSucceededAt: row.lastSucceededAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureCode: row.lastFailureCode,
    lastUsedAt: row.lastUsedAt,
    unavailableUntil: row.unavailableUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
