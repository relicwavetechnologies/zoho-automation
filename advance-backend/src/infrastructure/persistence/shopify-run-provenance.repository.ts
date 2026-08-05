import { Prisma, type PrismaClient } from '../../generated/prisma';

const SHOPIFY_TOOL_IDS = new Set([
  'shopifyAnalytics',
  'shopifyOrders',
  'shopifyCustomers',
]);

/**
 * Persists only server-verifiable Shopify provenance. The connection lookup is
 * tenant-bound and the canonical shop domain comes from the credential record,
 * never from Pi, trace ingestion, or a webhook payload.
 */
export class ShopifyRunProvenanceRepository {
  constructor(private readonly db: PrismaClient) {}

  async record(input: {
    readonly companyId: string;
    readonly executionRunId: string;
    readonly connectionId: string;
    readonly toolId: string;
  }): Promise<void> {
    if (!SHOPIFY_TOOL_IDS.has(input.toolId)) {
      throw new Error('Unsupported Shopify provenance tool.');
    }

    await this.db.$transaction(async tx => {
      const connections = await tx.$queryRaw<Array<{ externalAccountId: string | null }>>(Prisma.sql`
        SELECT connection."externalAccountId"
        FROM "IntegrationConnection" AS connection
        WHERE connection."id" = ${input.connectionId}
          AND connection."companyId" = ${input.companyId}
          AND connection."provider" = 'shopify'
          AND connection."externalAccountId" IS NOT NULL
        FOR UPDATE
      `);
      const connection = connections[0];
      const execution = await tx.executionRun.findFirst({
        where: { id: input.executionRunId, companyId: input.companyId },
        select: { id: true },
      });
      if (!execution || !connection?.externalAccountId) {
        throw new Error('Shopify run provenance could not be verified.');
      }

      await tx.shopifyRunProvenance.upsert({
        where: {
          executionRunId_connectionId_toolId: {
            executionRunId: input.executionRunId,
            connectionId: input.connectionId,
            toolId: input.toolId,
          },
        },
        create: {
          companyId: input.companyId,
          executionRunId: input.executionRunId,
          connectionId: input.connectionId,
          shopDomain: connection.externalAccountId,
          toolId: input.toolId,
        },
        update: {},
      });
    });
  }
}
