import { createHash } from 'node:crypto';
import type { PrismaClient, CompanySerperConnection } from '../../generated/prisma';
import { decryptToken, encryptToken } from '../shared/token.crypto';

export const serperKeyFingerprint = (apiKey: string): string =>
  createHash('sha256').update(apiKey.trim()).digest('hex');

export interface SafeSerperConnection {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly priority: number;
  readonly lastTestedAt: Date | null;
  readonly lastSucceededAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastFailureCode: string | null;
  readonly lastUsedAt: Date | null;
  readonly successfulRequestCount: number;
  readonly creditsAtLastSync: number | null;
  readonly creditsSyncedAt: Date | null;
  readonly observedRequestsSinceCreditSync: number;
  readonly estimatedCreditsRemaining?: number;
  readonly unavailableUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type SerperConnectionUsageRow = Pick<CompanySerperConnection,
  'id' | 'label' | 'status' | 'priority' | 'lastTestedAt' | 'lastSucceededAt' |
  'lastFailureAt' | 'lastFailureCode' | 'lastUsedAt' | 'successfulRequestCount' |
  'creditsAtLastSync' | 'usageAtLastCreditSync' | 'creditsSyncedAt' |
  'unavailableUntil' | 'createdAt' | 'updatedAt'>;

export interface SerperConnectionUsage {
  readonly observedRequestsSinceCreditSync: number;
  readonly estimatedCreditsRemaining?: number;
}

/**
 * Credit figures are estimates based solely on a value an admin copied from
 * Serper and the successful requests Divo has observed since that snapshot.
 */
export const deriveSerperConnectionUsage = (row: Pick<SerperConnectionUsageRow,
  'successfulRequestCount' | 'creditsAtLastSync' | 'usageAtLastCreditSync'>,
): SerperConnectionUsage => {
  const observedRequestsSinceCreditSync = Math.max(0, row.successfulRequestCount - row.usageAtLastCreditSync);
  const estimatedCreditsRemaining = row.creditsAtLastSync === null
    ? undefined
    : Math.max(0, row.creditsAtLastSync - observedRequestsSinceCreditSync);
  return {
    observedRequestsSinceCreditSync,
    ...(estimatedCreditsRemaining === undefined ? {} : { estimatedCreditsRemaining }),
  };
};

const toSafeConnection = (row: SerperConnectionUsageRow): SafeSerperConnection => {
  const usage = deriveSerperConnectionUsage(row);
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    priority: row.priority,
    lastTestedAt: row.lastTestedAt,
    lastSucceededAt: row.lastSucceededAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureCode: row.lastFailureCode,
    lastUsedAt: row.lastUsedAt,
    successfulRequestCount: row.successfulRequestCount,
    creditsAtLastSync: row.creditsAtLastSync,
    creditsSyncedAt: row.creditsSyncedAt,
    observedRequestsSinceCreditSync: usage.observedRequestsSinceCreditSync,
    ...(usage.estimatedCreditsRemaining === undefined ? {} : { estimatedCreditsRemaining: usage.estimatedCreditsRemaining }),
    unavailableUntil: row.unavailableUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export class CompanySerperConnectionRepository {
  constructor(private readonly prisma: PrismaClient, private readonly encryptionKey: string) {}

  async list(companyId: string): Promise<SafeSerperConnection[]> {
    const rows = await this.prisma.companySerperConnection.findMany({
      where: { companyId, revokedAt: null },
      select: { id: true, label: true, status: true, priority: true, lastTestedAt: true, lastSucceededAt: true, lastFailureAt: true, lastFailureCode: true, lastUsedAt: true, successfulRequestCount: true, creditsAtLastSync: true, usageAtLastCreditSync: true, creditsSyncedAt: true, unavailableUntil: true, createdAt: true, updatedAt: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toSafeConnection);
  }

  async activeKeys(companyId: string): Promise<Array<{ id: string; apiKey: string }>> {
    const rows = await this.prisma.companySerperConnection.findMany({
      where: {
        companyId,
        status: 'connected',
        revokedAt: null,
        OR: [{ unavailableUntil: null }, { unavailableUntil: { lte: new Date() } }],
      },
      select: { id: true, apiKeyEncrypted: true, successfulRequestCount: true, creditsAtLastSync: true, usageAtLastCreditSync: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    return rows
      .filter(row => row.creditsAtLastSync === null || row.creditsAtLastSync > Math.max(0, row.successfulRequestCount - row.usageAtLastCreditSync))
      .map(row => ({ id: row.id, apiKey: decryptToken(row.apiKeyEncrypted, this.encryptionKey) }));
  }

  async hasConnection(companyId: string): Promise<boolean> {
    return (await this.prisma.companySerperConnection.count({
      where: { companyId, revokedAt: null },
    })) > 0;
  }

  async saveVerified(input: { companyId: string; userId: string; label: string; apiKey: string; remainingCredits?: number }): Promise<SafeSerperConnection> {
    const fingerprint = serperKeyFingerprint(input.apiKey);
    const existing = await this.prisma.companySerperConnection.findUnique({ where: { companyId_keyFingerprint: { companyId: input.companyId, keyFingerprint: fingerprint } } });
    const highest = await this.prisma.companySerperConnection.aggregate({ where: { companyId: input.companyId, revokedAt: null }, _max: { priority: true } });
    const now = new Date();
    const data = {
      label: input.label.trim(), apiKeyEncrypted: encryptToken(input.apiKey, this.encryptionKey).cipherText,
      status: 'connected', lastTestedAt: now, lastSucceededAt: now,
      lastFailureAt: null, lastFailureCode: null, unavailableUntil: null, revokedAt: null,
      ...(input.remainingCredits === undefined ? {} : {
        creditsAtLastSync: input.remainingCredits,
        usageAtLastCreditSync: existing?.successfulRequestCount ?? 0,
        creditsSyncedAt: now,
      }),
    };
    const row = existing
      ? await this.prisma.companySerperConnection.update({ where: { id: existing.id }, data })
      : await this.prisma.companySerperConnection.create({ data: { companyId: input.companyId, createdBy: input.userId, keyFingerprint: fingerprint, priority: (highest._max.priority ?? -1) + 1, ...data } });
    return toSafeConnection(row);
  }

  async setStatus(companyId: string, id: string, status: 'connected' | 'disabled'): Promise<SafeSerperConnection | null> {
    const found = await this.prisma.companySerperConnection.findFirst({ where: { id, companyId, revokedAt: null } });
    if (!found) return null;
    const row = await this.prisma.companySerperConnection.update({
      where: { id },
      data: { status, ...(status === 'connected' ? { unavailableUntil: null } : {}) },
    });
    return toSafeConnection(row);
  }

  async setRemainingCredits(companyId: string, id: string, remainingCredits: number): Promise<SafeSerperConnection | null> {
    const found = await this.prisma.companySerperConnection.findFirst({
      where: { id, companyId, revokedAt: null },
      select: { id: true, successfulRequestCount: true },
    });
    if (!found) return null;
    const row = await this.prisma.companySerperConnection.update({
      where: { id },
      data: {
        creditsAtLastSync: remainingCredits,
        usageAtLastCreditSync: found.successfulRequestCount,
        creditsSyncedAt: new Date(),
        ...(remainingCredits > 0 ? { unavailableUntil: null } : {}),
      },
    });
    return toSafeConnection(row);
  }

  async revoke(companyId: string, id: string): Promise<boolean> {
    const result = await this.prisma.companySerperConnection.updateMany({ where: { id, companyId, revokedAt: null }, data: { revokedAt: new Date(), status: 'revoked' } });
    return result.count === 1;
  }

  async markSuccess(id: string): Promise<void> {
    await this.prisma.companySerperConnection.update({
      where: { id },
      data: {
        successfulRequestCount: { increment: 1 },
        lastUsedAt: new Date(),
        lastFailureAt: null,
        lastFailureCode: null,
        unavailableUntil: null,
      },
    });
  }

  async markFailure(id: string, code: string, unavailableUntil: Date): Promise<void> {
    await this.prisma.companySerperConnection.update({
      where: { id },
      data: { lastFailureAt: new Date(), lastFailureCode: code, unavailableUntil },
    });
  }

  async markCreditsExhausted(id: string, code: string): Promise<void> {
    const now = new Date();
    await this.prisma.companySerperConnection.update({
      where: { id },
      data: {
        creditsAtLastSync: 0,
        creditsSyncedAt: now,
        lastFailureAt: now,
        lastFailureCode: code,
        unavailableUntil: null,
      },
    });
  }
}
