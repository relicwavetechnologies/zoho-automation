import { createHash } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import { err, ok, type Result } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';

export type ClaimedShopifyOAuthAttempt = {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly shopDomain: string;
  readonly requestedScopes: readonly string[];
  readonly returnTo?: string;
};

export class IntegrationOAuthAttemptRepository {
  constructor(private readonly db: PrismaClient) {}

  async createShopify(input: {
    readonly state: string;
    readonly companyId: string;
    readonly userId: string;
    readonly shopDomain: string;
    readonly requestedScopes: readonly string[];
    readonly returnTo?: string;
    readonly expiresAt: Date;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.$transaction(async tx => {
        await tx.integrationOAuthAttempt.deleteMany({
          where: { provider: 'shopify', expiresAt: { lt: new Date() } },
        });
        await tx.integrationOAuthAttempt.create({
          data: {
            stateHash: stateHash(input.state),
            provider: 'shopify',
            companyId: input.companyId,
            userId: input.userId,
            externalAccountId: input.shopDomain,
            requestedScopes: [...input.requestedScopes],
            ...(input.returnTo ? { returnTo: input.returnTo } : {}),
            expiresAt: input.expiresAt,
          },
        });
      });
      return ok(undefined);
    } catch (error) {
      return err(wrapInfra('prisma', 'IntegrationOAuthAttempt.createShopify', error));
    }
  }

  async claimShopify(input: {
    readonly state: string;
  }): Promise<Result<ClaimedShopifyOAuthAttempt | null, InfraError>> {
    try {
      const hash = stateHash(input.state);
      const claimed = await this.db.$transaction(async tx => {
        const update = await tx.integrationOAuthAttempt.updateMany({
          where: {
            stateHash: hash,
            provider: 'shopify',
            status: 'pending',
            claimedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: {
            status: 'exchanging',
            claimedAt: new Date(),
          },
        });
        if (update.count !== 1) return null;
        return tx.integrationOAuthAttempt.findUnique({ where: { stateHash: hash } });
      });
      if (!claimed) return ok(null);
      return ok({
        id: claimed.id,
        companyId: claimed.companyId,
        userId: claimed.userId,
        shopDomain: claimed.externalAccountId,
        requestedScopes: claimed.requestedScopes,
        ...(claimed.returnTo ? { returnTo: claimed.returnTo } : {}),
      });
    } catch (error) {
      return err(wrapInfra('prisma', 'IntegrationOAuthAttempt.claimShopify', error));
    }
  }

  async fail(id: string, failureCode: string): Promise<Result<void, InfraError>> {
    return this.finish(id, { status: 'failed', completedAt: new Date(), failureCode });
  }

  private async finish(id: string, data: Record<string, unknown>): Promise<Result<void, InfraError>> {
    try {
      const updated = await this.db.integrationOAuthAttempt.updateMany({
        where: { id, provider: 'shopify', status: 'exchanging' },
        data,
      });
      if (updated.count !== 1) throw new Error('OAuth attempt is not in an exchangeable state.');
      return ok(undefined);
    } catch (error) {
      return err(wrapInfra('prisma', 'IntegrationOAuthAttempt.finishShopify', error));
    }
  }
}

function stateHash(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}
