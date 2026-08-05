import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import {
  SHOPIFY_ERASURE_LOCK_NAMESPACE,
  shopifyErasureLockKey,
  shopifyErasureSourceId,
} from '../../application/shopify/shopify-erasure-fence';
import { err, ok, type Result } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { PrismaShopifyPrivacyRepository } from './shopify-privacy.repository';

export class ShopifyWebhookRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly privacy: Pick<
      PrismaShopifyPrivacyRepository,
      | 'createInTransaction'
      | 'findRedactionCompanyIdsInTransaction'
      | 'findShopCompanyIdsInTransaction'
      | 'redactInTransaction'
      | 'redactShopInTransaction'
    >,
  ) {}

  async process(input: {
    readonly webhookId: string;
    readonly topic: string;
    readonly shopDomain: string;
    readonly action: 'record_data_request' | 'purge_customer_traces' | 'revoke' | 'erase';
    readonly privacyRequest?: { readonly requestId?: string; readonly customerId?: string; readonly orderIds: readonly string[] };
  }): Promise<Result<{ readonly duplicate: boolean; readonly affectedConnections: number }, InfraError>> {
    try {
      const revokedConnections = await this.db.$transaction(async tx => {
        await tx.integrationWebhookReceipt.create({
          data: { provider: 'shopify', webhookId: input.webhookId, topic: input.topic, accountId: accountHash(input.shopDomain) },
        });
        const connections = await tx.$queryRaw<Array<{ id: string; companyId: string }>>(Prisma.sql`
          SELECT connection."id", connection."companyId"
          FROM "IntegrationConnection" AS connection
          WHERE connection."provider" = 'shopify'
            AND connection."externalAccountId" = ${input.shopDomain}
          ORDER BY connection."id"
          FOR UPDATE
        `);
        const connectionIds = connections.map(connection => connection.id);
        if (input.action === 'record_data_request') {
          if (!input.privacyRequest?.requestId) throw new Error('Shopify data request details are required.');
          for (const companyId of new Set(connections.map(connection => connection.companyId))) {
            const receivedAt = new Date();
            await this.privacy.createInTransaction(tx, {
              companyId,
              shopDomain: input.shopDomain,
              requestId: input.privacyRequest.requestId,
              ...(input.privacyRequest.customerId ? { customerId: input.privacyRequest.customerId } : {}),
              orderIds: input.privacyRequest.orderIds,
              state: 'ready',
              exportPayload: {
                schemaVersion: 1,
                generatedAt: receivedAt.toISOString(),
                retainedCustomerOrOrderRecords: [],
              },
              deadlineAt: new Date(receivedAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
              expiresAt: new Date(receivedAt.getTime() + 37 * 24 * 60 * 60 * 1_000),
            });
          }
          return 0;
        }
        if (input.action === 'purge_customer_traces') {
          if (!input.privacyRequest) throw new Error('Shopify customer redaction details are required.');
          const lifecycleCompanyIds = await this.privacy.findRedactionCompanyIdsInTransaction(tx, {
            shopDomain: input.shopDomain,
            ...(input.privacyRequest.requestId ? { requestId: input.privacyRequest.requestId } : {}),
            ...(input.privacyRequest.customerId ? { customerId: input.privacyRequest.customerId } : {}),
            orderIds: input.privacyRequest.orderIds,
          });
          const companyIds = new Set([
            ...connections.map(connection => connection.companyId),
            ...lifecycleCompanyIds,
          ]);
          for (const companyId of companyIds) {
            let page = 0;
            let hasMore = false;
            do {
              const redacted = await this.privacy.redactInTransaction(tx, {
                companyId,
                shopDomain: input.shopDomain,
                ...(input.privacyRequest.requestId ? { requestId: input.privacyRequest.requestId } : {}),
                ...(input.privacyRequest.customerId ? { customerId: input.privacyRequest.customerId } : {}),
                orderIds: input.privacyRequest.orderIds,
                limit: 100,
              });
              hasMore = redacted.hasMore;
              page += 1;
              if (hasMore && (redacted.affected === 0 || page >= 100)) {
                throw new Error('Shopify privacy redaction exceeded its bounded transaction budget.');
              }
            } while (hasMore);
          }
          await purgeShopDerivedData(
            tx,
            [...companyIds],
            input.shopDomain,
            connectionIds,
            ['shopifyOrders', 'shopifyCustomers'],
          );
          return 0;
        }
        if (input.action === 'erase') {
          const lifecycleCompanyIds = await this.privacy.findShopCompanyIdsInTransaction(tx, {
            shopDomain: input.shopDomain,
          });
          const provenanceCompanies = await tx.shopifyRunProvenance.findMany({
            where: { shopDomain: input.shopDomain },
            select: { companyId: true },
            distinct: ['companyId'],
          });
          const companyIds = new Set([
            ...connections.map(connection => connection.companyId),
            ...lifecycleCompanyIds,
            ...provenanceCompanies.map(row => row.companyId),
          ]);
          for (const companyId of companyIds) {
            let page = 0;
            let hasMore = false;
            do {
              const redacted = await this.privacy.redactShopInTransaction(tx, {
                companyId,
                shopDomain: input.shopDomain,
                limit: 100,
              });
              hasMore = redacted.hasMore;
              page += 1;
              if (hasMore && (redacted.affected === 0 || page >= 100)) {
                throw new Error('Shopify shop erasure exceeded its bounded transaction budget.');
              }
            } while (hasMore);
          }
          await tx.integrationOAuthAttempt.deleteMany({
            where: { provider: 'shopify', externalAccountId: input.shopDomain },
          });
          await tx.auditLog.deleteMany({
            where: { metadata: { path: ['shopDomain'], equals: input.shopDomain } },
          });
          await tx.auditLog.deleteMany({
            where: { metadata: { path: ['shopDomainHash'], equals: accountHash(input.shopDomain) } },
          });
          if (connectionIds.length > 0) {
            await tx.auditLog.deleteMany({
              where: {
                OR: connectionIds.map(connectionId => ({
                  metadata: { path: ['connectionId'], equals: connectionId },
                })),
              },
            });
          }
          await purgeShopDerivedData(
            tx,
            [...companyIds],
            input.shopDomain,
            connectionIds,
            ['shopifyAnalytics', 'shopifyOrders', 'shopifyCustomers'],
          );
          const removed = await tx.integrationConnection.deleteMany({
            where: { provider: 'shopify', externalAccountId: input.shopDomain },
          });
          return removed.count;
        }
        const updated = await tx.integrationConnection.updateMany({
          where: { provider: 'shopify', externalAccountId: input.shopDomain, revokedAt: null },
          data: {
            status: 'revoked',
            revokedAt: new Date(),
            accessTokenEncrypted: null,
            refreshTokenEncrypted: null,
            accessTokenExpiresAt: null,
            refreshTokenExpiresAt: null,
            refreshLeaseOwner: null,
            refreshLeaseExpiresAt: null,
          },
        });
        return updated.count;
      });
      return ok({ duplicate: false, affectedConnections: revokedConnections });
    } catch (error) {
      if (isUniqueConflict(error)) return ok({ duplicate: true, affectedConnections: 0 });
      return err(wrapInfra('prisma', 'ShopifyWebhookReceipt.process', error));
    }
  }
}

const MAX_SHOP_ERASURE_RUNS = 10_000;
const MAX_SHOP_ERASURE_CONVERSATIONS = 10_000;
const MAX_SHOP_ERASURE_KNOWLEDGE_RESOURCES = 10_000;

/**
 * Erases only runs stamped by the backend against this exact tenant/shop.
 * A run and a conversation are the minimum safe units because summaries,
 * model events, and later turns can incorporate an earlier Shopify result.
 */
async function purgeShopDerivedData(
  tx: Prisma.TransactionClient,
  companyIds: readonly string[],
  shopDomain: string,
  connectionIds: readonly string[],
  toolIds: readonly string[],
): Promise<void> {
  if (companyIds.length === 0) return;
  const provenances = await tx.shopifyRunProvenance.findMany({
    where: {
      companyId: { in: [...companyIds] },
      shopDomain,
      toolId: { in: [...toolIds] },
    },
    select: {
      companyId: true,
      executionRunId: true,
      executionRun: { select: { requestId: true } },
    },
    take: MAX_SHOP_ERASURE_RUNS + 1,
  });
  const executionIds = [...new Set(provenances.map(row => row.executionRunId))];
  if (executionIds.length > MAX_SHOP_ERASURE_RUNS) {
    throw new Error('Shopify shop erasure exceeded its bounded run budget.');
  }
  const runIds = [...new Set(provenances.flatMap(row => row.executionRun.requestId
    ? [row.executionRun.requestId]
    : []))];
  const learningSources = provenances.flatMap(row => [
    {
      companyId: row.companyId,
      sourceId: shopifyErasureSourceId('desktop', row.executionRunId),
    },
    ...(row.executionRun.requestId ? [{
      companyId: row.companyId,
      sourceId: shopifyErasureSourceId('lark', row.executionRun.requestId),
    }] : []),
  ]);
  await fenceShopifySources(tx, learningSources);

  if (runIds.length > 0) {
    const contaminatedConversations = await tx.runtimeConversationMessage.findMany({
      where: {
        sourceRunId: { in: runIds },
        conversation: { companyId: { in: [...companyIds] } },
      },
      select: { conversationId: true },
      distinct: ['conversationId'],
      take: MAX_SHOP_ERASURE_CONVERSATIONS + 1,
    });
    if (contaminatedConversations.length > MAX_SHOP_ERASURE_CONVERSATIONS) {
      throw new Error('Shopify shop erasure exceeded its bounded conversation budget.');
    }
    const conversationIds = contaminatedConversations.map(row => row.conversationId);
    if (conversationIds.length > 0) {
      await tx.runtimeConversationMessage.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.runtimeConversation.updateMany({
        where: { id: { in: conversationIds }, companyId: { in: [...companyIds] } },
        data: {
          title: null,
          refsJson: Prisma.DbNull,
          summaryJson: Prisma.DbNull,
          summaryUpdatedAt: null,
          lastSummarizedSequence: 0,
          historyRevision: { increment: 1 },
        },
      });
    }

  }

  const learningSourceIds = [...new Set(learningSources.map(source => source.sourceId))];
  if (learningSourceIds.length > 0) {
    await lockAndDeleteLearningJobs(tx, companyIds, learningSourceIds);
    await tombstoneLearnedKnowledge(tx, companyIds, learningSourceIds, shopDomain);
  }

  if (executionIds.length > 0) {
    const contaminatedCandidates = await tx.personaLearningCandidate.findMany({
      where: {
        companyId: { in: [...companyIds] },
        evidence: { executionRunId: { in: executionIds } },
        promotedNodeId: { not: null },
      },
      select: { promotedNodeId: true },
    });
    const personaNodeIds = [...new Set(contaminatedCandidates.flatMap(candidate => candidate.promotedNodeId
      ? [candidate.promotedNodeId]
      : []))];
    if (personaNodeIds.length > 0) {
      // A promoted node can summarize multiple evidence rows. Once any source
      // is erased the canonical text cannot be reconstructed safely here, so
      // the contaminated node is removed as one indivisible derived record.
      await tx.managerPersonaNode.deleteMany({
        where: { id: { in: personaNodeIds }, companyId: { in: [...companyIds] } },
      });
    }
    await tx.personaLearningEvidence.deleteMany({
      where: {
        companyId: { in: [...companyIds] },
        executionRunId: { in: executionIds },
      },
    });
    await tx.aiTokenUsage.updateMany({
      where: { companyId: { in: [...companyIds] }, executionRunId: { in: executionIds } },
      data: { executionRunId: null },
    });
    await tx.executionRun.deleteMany({
      where: { id: { in: executionIds }, companyId: { in: [...companyIds] } },
    });
  }

  if (connectionIds.length > 0) {
    await purgeRuntimeTraces(tx, connectionIds, toolIds);
  }

  // LarkChatContext has no exact run relation. Clearing only the matched shop
  // would require guessing from rendered assistant text, so shop erasure uses
  // the explicit fail-safe boundary: all shared snapshots for affected tenant
  // companies are invalidated, while every other company remains untouched.
  await tx.larkChatContext.updateMany({
    where: { companyId: { in: [...companyIds] } },
    data: {
      recentMessagesJson: Prisma.DbNull,
      summaryJson: Prisma.DbNull,
      summaryUpdatedAt: null,
      taskStateJson: Prisma.DbNull,
      taskStateUpdatedAt: null,
      sourceMessageCount: 0,
      lastMessageAt: null,
    },
  });
}

async function fenceShopifySources(
  tx: Prisma.TransactionClient,
  sources: readonly { readonly companyId: string; readonly sourceId: string }[],
): Promise<void> {
  const deduplicated = [...new Map(sources.map(source => [
    shopifyErasureLockKey(source.companyId, source.sourceId),
    source,
  ])).entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  if (deduplicated.length > MAX_SHOP_ERASURE_RUNS * 2) {
    throw new Error('Shopify shop erasure exceeded its bounded source-fence budget.');
  }
  if (deduplicated.length > 0) {
    const lockKeys = deduplicated.map(([lockKey]) => lockKey);
    await tx.$queryRaw(Prisma.sql`
      WITH ordered AS MATERIALIZED (
        SELECT unnest(ARRAY[${Prisma.join(lockKeys)}]::text[]) AS lock_key
        ORDER BY lock_key
      )
      SELECT pg_advisory_xact_lock(
        hashtext(${SHOPIFY_ERASURE_LOCK_NAMESPACE}),
        hashtext(ordered.lock_key)
      )::text AS lock_result
      FROM ordered
    `);
    await tx.shopifyRunErasureFence.createMany({
      data: deduplicated.map(([, source]) => source),
      skipDuplicates: true,
    });
  }
}

async function lockAndDeleteLearningJobs(
  tx: Prisma.TransactionClient,
  companyIds: readonly string[],
  sourceIds: readonly string[],
): Promise<void> {
  const jobs = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT job."id"
    FROM "KnowledgeLearningJob" AS job
    WHERE job."companyId" IN (${Prisma.join([...companyIds])})
      AND job."sourceId" IN (${Prisma.join([...sourceIds])})
    FOR UPDATE
  `);
  if (jobs.length > MAX_SHOP_ERASURE_KNOWLEDGE_RESOURCES) {
    throw new Error('Shopify shop erasure exceeded its bounded knowledge budget.');
  }
  if (jobs.length > 0) {
    await tx.knowledgeLearningJob.deleteMany({
      where: { id: { in: jobs.map(job => job.id) } },
    });
  }
}

async function tombstoneLearnedKnowledge(
  tx: Prisma.TransactionClient,
  companyIds: readonly string[],
  sourceIds: readonly string[],
  shopDomain: string,
): Promise<void> {
  const sourceMutations = await tx.knowledgeMutation.findMany({
    where: {
      companyId: { in: [...companyIds] },
      sourceType: 'automatic_learning',
      sourceRef: { in: [...sourceIds] },
    },
    select: { id: true, appliedVersionId: true },
    take: MAX_SHOP_ERASURE_KNOWLEDGE_RESOURCES + 1,
  });
  if (sourceMutations.length > MAX_SHOP_ERASURE_KNOWLEDGE_RESOURCES) {
    throw new Error('Shopify shop erasure exceeded its bounded knowledge budget.');
  }
  const sourceVersionIds = [...new Set(sourceMutations.flatMap(mutation => mutation.appliedVersionId
    ? [mutation.appliedVersionId]
    : []))];
  if (sourceVersionIds.length === 0) {
    await tx.knowledgeMutation.deleteMany({
      where: { id: { in: sourceMutations.map(mutation => mutation.id) } },
    });
    return;
  }

  const versions = await tx.knowledgeVersion.findMany({
    where: { id: { in: sourceVersionIds } },
    select: {
      id: true,
      resource: {
        select: {
          id: true,
          companyId: true,
          kind: true,
          scope: true,
          targetKey: true,
          ownerUserId: true,
          departmentId: true,
          logicalKey: true,
          currentVersion: true,
          status: true,
          createdById: true,
        },
      },
    },
  });
  const contaminatedResources = [...new Map(versions.map(version => [
    version.resource.id,
    version.resource,
  ])).values()];
  if (contaminatedResources.length > MAX_SHOP_ERASURE_KNOWLEDGE_RESOURCES) {
    throw new Error('Shopify shop erasure exceeded its bounded knowledge budget.');
  }
  const resourceIds = contaminatedResources.map(resource => resource.id);
  const [versionCount, mutationCount] = resourceIds.length > 0
    ? await Promise.all([
      tx.knowledgeVersion.count({ where: { resourceId: { in: resourceIds } } }),
      tx.knowledgeMutation.count({ where: { resourceId: { in: resourceIds } } }),
    ])
    : [0, 0];
  if (
    versionCount > MAX_SHOP_ERASURE_KNOWLEDGE_RESOURCES
    || mutationCount > MAX_SHOP_ERASURE_KNOWLEDGE_RESOURCES
  ) {
    throw new Error('Shopify shop erasure exceeded its bounded knowledge-history budget.');
  }

  const erasedAt = new Date();
  const shopHash = accountHash(shopDomain);
  const deletionMutationIds: string[] = [];
  for (const resource of contaminatedResources.filter(resource => resource.status !== 'deleted')) {
    const mutation = await tx.knowledgeMutation.create({
      data: {
        companyId: resource.companyId,
        resourceId: resource.id,
        kind: resource.kind,
        scope: resource.scope,
        targetKey: resource.targetKey,
        ownerUserId: resource.ownerUserId,
        departmentId: resource.departmentId,
        logicalKey: resource.logicalKey,
        action: 'delete',
        baseVersion: resource.currentVersion,
        sourceType: 'shopify_privacy_erasure',
        sourceRef: `shop:${shopHash}`,
        requesterId: resource.ownerUserId ?? resource.createdById,
        requesterReviewRequired: false,
        requiredAuthority: 'none',
        distinctApprover: false,
        policyId: 'shopify_privacy_erasure',
        policyVersion: 1,
        status: 'applied',
        idempotencyKey: `shopify-privacy:${shopHash}:${resource.id}:v${resource.currentVersion}`,
        decidedAt: erasedAt,
        appliedAt: erasedAt,
      },
    });
    await tx.knowledgeResource.update({
      where: { id: resource.id },
      data: { status: 'deleted' },
    });
    await tx.knowledgeOutbox.create({
      data: {
        mutationId: mutation.id,
        eventType: 'knowledge.resource.deleted',
        dedupeKey: `${mutation.id}:delete`,
        payloadJson: {
          contract: 1,
          mutationId: mutation.id,
          resourceId: resource.id,
          companyId: resource.companyId,
          kind: resource.kind,
          scope: resource.scope,
          targetKey: resource.targetKey,
          logicalKey: resource.logicalKey,
          version: resource.currentVersion,
        },
      },
    });
    deletionMutationIds.push(mutation.id);
  }

  // The resource is the minimum safe unit. A later version can copy facts from
  // a Shopify-derived version without retaining its sourceRef, so keeping any
  // old version or proposal could leave protected semantic content durable.
  await tx.knowledgeMutation.deleteMany({
    where: {
      id: { notIn: deletionMutationIds },
      OR: resourceIds.length > 0
        ? [
          { id: { in: sourceMutations.map(mutation => mutation.id) } },
          { resourceId: { in: resourceIds } },
        ]
        : [{ id: { in: sourceMutations.map(mutation => mutation.id) } }],
    },
  });
  if (resourceIds.length > 0) {
    await tx.knowledgeVersion.deleteMany({ where: { resourceId: { in: resourceIds } } });
  }
}

async function purgeRuntimeTraces(
  tx: Prisma.TransactionClient,
  connectionIds: readonly string[],
  toolIds: readonly string[],
): Promise<void> {
  const where: Prisma.RuntimeApprovalWhereInput = {
    toolId: { in: [...toolIds] },
    OR: connectionIds.map(connectionId => ({
      payloadJson: { path: ['args', 'connectionId'], equals: connectionId },
    })),
  };
  const approvals = await tx.runtimeApproval.findMany({ where, select: { conversationId: true } });
  const conversationIds = [...new Set(approvals.map(approval => approval.conversationId))];
  if (conversationIds.length > 0) {
    await tx.runtimeConversationMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await tx.runtimeConversation.updateMany({
      where: { id: { in: conversationIds } },
      data: {
        summaryJson: Prisma.DbNull,
        summaryUpdatedAt: null,
        lastSummarizedSequence: 0,
        historyRevision: { increment: 1 },
      },
    });
  }
  await tx.runtimeApproval.deleteMany({ where });
}

function accountHash(shopDomain: string): string {
  return createHash('sha256').update(shopDomain).digest('hex');
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 'P2002');
}
