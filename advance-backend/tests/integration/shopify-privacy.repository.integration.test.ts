import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { hashProtectedIdentifier } from '../../src/application/shopify/shopify-privacy.lifecycle';
import { PrismaShopifyPrivacyRepository } from '../../src/infrastructure/persistence/shopify-privacy.repository';
import { ShopifyWebhookRepository } from '../../src/infrastructure/persistence/shopify-webhook.repository';
import { PrismaKnowledgeMutationStore } from '../../src/infrastructure/persistence/knowledge-mutation.repository';
import { ConversationRepository } from '../../src/infrastructure/persistence/conversation.repository';
import { KnowledgeLearningService } from '../../src/application/knowledge/knowledge-learning.service';
import { encryptToken } from '../../src/infrastructure/shared/token.crypto';

const enabled = process.env['RUN_DATABASE_INTEGRATION'] === '1' && Boolean(process.env['DATABASE_URL']);
const prisma = enabled ? new PrismaClient() : null;
const suffix = randomUUID();
const encryptionKey = 'shopify-privacy-integration-key';
const shopDomain = `privacy-${suffix}.myshopify.com`;
let companyId = '';

before(async () => {
  if (!prisma) return;
  const company = await prisma.company.create({ data: { name: `Shopify privacy ${suffix}` } });
  companyId = company.id;
  await prisma.integrationConnection.create({
    data: {
      companyId,
      provider: 'shopify',
      ownerType: 'company',
      label: 'Privacy test store',
      externalAccountId: shopDomain,
      dedupeKey: `shopify:${shopDomain}`,
      scopes: ['read_reports'],
    },
  });
});

after(async () => {
  if (!prisma) return;
  if (companyId) await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
  await prisma.$disconnect();
});

test('real Postgres: encrypted lifecycle, exact tenant access, transitions, redaction, sweep, and safe audit', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const repository = new PrismaShopifyPrivacyRepository(prisma!, encryptionKey);
  const now = new Date();
  const deadlineAt = new Date(now.getTime() + 30 * 86_400_000);
  const expiresAt = new Date(now.getTime() + 37 * 86_400_000);
  const customerId = `gid://shopify/Customer/${suffix}`;
  const orderId = `gid://shopify/Order/${suffix}`;
  const privateEmail = `private-${suffix}@example.test`;

  const received = await repository.create({
    companyId,
    shopDomain,
    requestId: `request-${suffix}`,
    customerId,
    orderIds: [orderId],
    state: 'received',
    deadlineAt,
    expiresAt,
  });
  assert.ok(received.ok && received.value.created);
  const ready = await repository.create({
    companyId,
    shopDomain,
    requestId: `request-${suffix}`,
    customerId,
    orderIds: [orderId],
    state: 'ready',
    exportPayload: { customer: { id: customerId, email: privateEmail }, orders: [{ id: orderId }] },
    deadlineAt: new Date(deadlineAt.getTime() + 1_000),
    expiresAt: new Date(expiresAt.getTime() + 1_000),
  });
  assert.ok(ready.ok);
  assert.equal(ready.value.created, false);
  assert.equal(ready.value.request.state, 'ready');

  const raw = await prisma!.shopifyPrivacyRequest.findUniqueOrThrow({ where: { id: ready.value.request.id } });
  assert.equal(raw.customerIdHash, hashProtectedIdentifier(customerId));
  assert.deepEqual(raw.orderIdHashes, [hashProtectedIdentifier(orderId)]);
  assert.notEqual(raw.exportPayloadEncrypted, null);
  assert.equal(JSON.stringify(raw).includes(customerId), false);
  assert.equal(JSON.stringify(raw).includes(orderId), false);
  assert.equal(JSON.stringify(raw).includes(privateEmail), false);

  const concurrentRequestId = `concurrent-${suffix}`;
  const concurrentCustomerId = `concurrent-customer-${suffix}`;
  const [concurrentReceived, concurrentReady] = await Promise.all([
    repository.create({
      companyId,
      shopDomain,
      requestId: concurrentRequestId,
      customerId: concurrentCustomerId,
      orderIds: [],
      state: 'received',
      deadlineAt,
      expiresAt,
    }),
    repository.create({
      companyId,
      shopDomain,
      requestId: concurrentRequestId,
      customerId: concurrentCustomerId,
      orderIds: [],
      state: 'ready',
      exportPayload: { retainedCustomerOrOrderRecords: [] },
      deadlineAt,
      expiresAt,
    }),
  ]);
  assert.ok(concurrentReceived.ok && concurrentReady.ok);
  assert.equal((await prisma!.shopifyPrivacyRequest.findFirstOrThrow({
    where: { companyId, shopDomain, requestId: concurrentRequestId },
  })).state, 'ready');

  const listed = await repository.list({ companyId, shopDomain, limit: 10 });
  assert.ok(listed.ok);
  assert.equal('exportPayload' in listed.value[0]!, false);
  const inaccessible = await repository.get({
    companyId: randomUUID(), shopDomain, id: raw.id, actorId: 'admin-other',
  });
  assert.ok(inaccessible.ok);
  assert.equal(inaccessible.value, null);
  const exact = await repository.get({ companyId, shopDomain, id: raw.id, actorId: 'admin-1' });
  assert.ok(exact.ok && exact.value);
  assert.equal((exact.value.exportPayload as any).customer.email, privateEmail);

  const deliveredAt = new Date();
  const delivered = await repository.markDelivered({
    companyId,
    shopDomain,
    id: raw.id,
    actorId: 'admin-1',
    deliveryEvidence: {
      channel: 'email',
      recipient: privateEmail,
      receiptId: `provider-receipt-${suffix}`,
      deliveredAt,
    },
  });
  assert.ok(delivered.ok && delivered.value);
  assert.equal((await repository.markDelivered({
    companyId,
    shopDomain,
    id: raw.id,
    actorId: 'admin-1',
    deliveryEvidence: {
      channel: 'email',
      recipient: privateEmail,
      receiptId: `provider-receipt-${suffix}`,
      deliveredAt,
    },
  })).value, false);
  const redacted = await repository.redact({ companyId, shopDomain, customerId, limit: 100 });
  assert.ok(redacted.ok);
  assert.equal(redacted.value.affected, 1);
  const scrubbed = await prisma!.shopifyPrivacyRequest.findUniqueOrThrow({ where: { id: raw.id } });
  assert.equal(scrubbed.state, 'redacted');
  assert.equal(scrubbed.exportPayloadEncrypted, null);

  const expiredDeadline = new Date(now.getTime() - 2 * 86_400_000);
  const expiredAt = new Date(now.getTime() - 86_400_000);
  const expiring = await repository.create({
    companyId,
    shopDomain,
    requestId: `expired-${suffix}`,
    customerId: `expired-customer-${suffix}`,
    orderIds: [],
    state: 'ready',
    exportPayload: { secret: privateEmail },
    deadlineAt: expiredDeadline,
    expiresAt: expiredAt,
  });
  assert.ok(expiring.ok);
  const failed = await repository.create({
    companyId,
    shopDomain,
    requestId: `failed-${suffix}`,
    orderIds: [`failed-order-${suffix}`],
    state: 'failed',
    failureCode: 'export.unavailable',
    deadlineAt: expiredDeadline,
    expiresAt: expiredAt,
  });
  assert.ok(failed.ok);
  const swept = await repository.sweep({ now, limit: 100 });
  assert.ok(swept.ok);
  assert.equal(swept.value.affected, 2);
  const expiredRows = await prisma!.shopifyPrivacyRequest.findMany({
    where: { id: { in: [expiring.value.request.id, failed.value.request.id] } },
  });
  assert.ok(expiredRows.every(row => row.state === 'expired' && row.exportPayloadEncrypted === null));

  const audits = await prisma!.auditLog.findMany({
    where: { companyId, action: { startsWith: 'shopify.privacy.' } },
  });
  assert.ok(audits.some(row => row.actorId === 'admin-1' && row.action === 'shopify.privacy.delivered'));
  const auditJson = JSON.stringify(audits.map(row => row.metadata));
  assert.equal(auditJson.includes(privateEmail), false);
  assert.equal(auditJson.includes(`provider-receipt-${suffix}`), false);
  assert.equal(auditJson.includes(hashProtectedIdentifier(privateEmail)), true);
  for (const protectedValue of [customerId, orderId, privateEmail]) {
    assert.equal(auditJson.includes(protectedValue), false);
  }
});

test('real Postgres: delivery acknowledgement uses server time and enforces ready chronology', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const repository = new PrismaShopifyPrivacyRepository(prisma!, encryptionKey);
  const now = new Date();
  const expired = await repository.create({
    companyId,
    shopDomain,
    requestId: `expired-delivery-${suffix}`,
    customerId: `expired-delivery-customer-${suffix}`,
    orderIds: [],
    state: 'ready',
    exportPayload: { retainedCustomerOrOrderRecords: [] },
    deadlineAt: new Date(now.getTime() - 2 * 86_400_000),
    expiresAt: new Date(now.getTime() - 86_400_000),
  });
  assert.ok(expired.ok);
  const expiredReadyAt = new Date(now.getTime() - 3 * 86_400_000);
  const historicalDeliveryAt = new Date(now.getTime() - 36 * 60 * 60 * 1_000);
  await prisma!.shopifyPrivacyRequest.update({
    where: { id: expired.value.request.id },
    data: { readyAt: expiredReadyAt },
  });
  const expiredAcknowledgement = await repository.markDelivered({
    companyId,
    shopDomain,
    id: expired.value.request.id,
    actorId: 'admin-expiry-test',
    deliveryEvidence: {
      channel: 'email',
      recipient: 'expired@example.test',
      receiptId: `expired-receipt-${suffix}`,
      deliveredAt: historicalDeliveryAt,
    },
  });
  assert.ok(expiredAcknowledgement.ok);
  assert.equal(expiredAcknowledgement.value, false);

  const chronological = await repository.create({
    companyId,
    shopDomain,
    requestId: `chronological-delivery-${suffix}`,
    customerId: `chronological-delivery-customer-${suffix}`,
    orderIds: [],
    state: 'ready',
    exportPayload: { retainedCustomerOrOrderRecords: [] },
    deadlineAt: new Date(now.getTime() + 30 * 86_400_000),
    expiresAt: new Date(now.getTime() + 37 * 86_400_000),
  });
  assert.ok(chronological.ok);
  const chronologicalRow = await prisma!.shopifyPrivacyRequest.findUniqueOrThrow({
    where: { id: chronological.value.request.id },
  });
  assert.ok(chronologicalRow.readyAt);
  const evidence = {
    channel: 'email' as const,
    recipient: 'chronological@example.test',
    receiptId: `chronological-receipt-${suffix}`,
  };
  const precedingReady = await repository.markDelivered({
    companyId,
    shopDomain,
    id: chronological.value.request.id,
    actorId: 'admin-chronology-test',
    deliveryEvidence: {
      ...evidence,
      deliveredAt: new Date(chronologicalRow.readyAt.getTime() - 1),
    },
  });
  assert.ok(precedingReady.ok);
  assert.equal(precedingReady.value, false);

  const future = await repository.markDelivered({
    companyId,
    shopDomain,
    id: chronological.value.request.id,
    actorId: 'admin-chronology-test',
    deliveryEvidence: { ...evidence, deliveredAt: new Date(Date.now() + 60_000) },
  });
  assert.ok(future.ok);
  assert.equal(future.value, false);

  const valid = await repository.markDelivered({
    companyId,
    shopDomain,
    id: chronological.value.request.id,
    actorId: 'admin-chronology-test',
    deliveryEvidence: { ...evidence, deliveredAt: new Date() },
  });
  assert.ok(valid.ok);
  assert.equal(valid.value, true);
});

test('real Postgres: customer and shop redaction include orphaned lifecycle rows', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const orphanCompany = await prisma!.company.create({ data: { name: `Orphan privacy ${suffix}` } });
  const orphanShopDomain = `orphan-${suffix}.myshopify.com`;
  const privacy = new PrismaShopifyPrivacyRepository(prisma!, encryptionKey);
  const webhooks = new ShopifyWebhookRepository(prisma!, privacy);
  const now = new Date();
  try {
    const customerId = `orphan-customer-${suffix}`;
    const customerLifecycle = await privacy.create({
      companyId: orphanCompany.id,
      shopDomain: orphanShopDomain,
      requestId: `orphan-customer-request-${suffix}`,
      customerId,
      orderIds: [],
      state: 'ready',
      exportPayload: { protected: true },
      deadlineAt: new Date(now.getTime() + 30 * 86_400_000),
      expiresAt: new Date(now.getTime() + 37 * 86_400_000),
    });
    assert.ok(customerLifecycle.ok);
    assert.equal(await prisma!.integrationConnection.count({
      where: { companyId: orphanCompany.id, provider: 'shopify', externalAccountId: orphanShopDomain },
    }), 0);

    const customerRedaction = await webhooks.process({
      webhookId: `orphan-customer-redact-${suffix}`,
      topic: 'customers/redact',
      shopDomain: orphanShopDomain,
      action: 'purge_customer_traces',
      privacyRequest: { customerId, orderIds: [] },
    });
    assert.ok(customerRedaction.ok);
    assert.equal((await prisma!.shopifyPrivacyRequest.findUniqueOrThrow({
      where: { id: customerLifecycle.value.request.id },
    })).state, 'redacted');

    const shopLifecycle = await privacy.create({
      companyId: orphanCompany.id,
      shopDomain: orphanShopDomain,
      requestId: `orphan-shop-request-${suffix}`,
      customerId: `orphan-shop-customer-${suffix}`,
      orderIds: [],
      state: 'ready',
      exportPayload: { protected: true },
      deadlineAt: new Date(now.getTime() + 30 * 86_400_000),
      expiresAt: new Date(now.getTime() + 37 * 86_400_000),
    });
    assert.ok(shopLifecycle.ok);
    const shopRedaction = await webhooks.process({
      webhookId: `orphan-shop-redact-${suffix}`,
      topic: 'shop/redact',
      shopDomain: orphanShopDomain,
      action: 'erase',
    });
    assert.ok(shopRedaction.ok);
    assert.equal(shopRedaction.value.affectedConnections, 0);
    const redactedShopLifecycle = await prisma!.shopifyPrivacyRequest.findUniqueOrThrow({
      where: { id: shopLifecycle.value.request.id },
    });
    assert.equal(redactedShopLifecycle.state, 'redacted');
    assert.equal(redactedShopLifecycle.customerIdHash, null);
    assert.equal(redactedShopLifecycle.exportPayloadEncrypted, null);
  } finally {
    await prisma!.company.delete({ where: { id: orphanCompany.id } }).catch(() => undefined);
  }
});

test('real Postgres: customer redaction purges protected shop runs but preserves analytics and other tenants', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const targetCompany = await prisma!.company.create({ data: { name: `Customer erase target ${suffix}` } });
  const controlCompany = await prisma!.company.create({ data: { name: `Customer erase control ${suffix}` } });
  const targetUser = await prisma!.user.create({
    data: { email: `customer-erase-target-${suffix}@example.test`, password: 'integration-only' },
  });
  const controlUser = await prisma!.user.create({
    data: { email: `customer-erase-control-${suffix}@example.test`, password: 'integration-only' },
  });
  const targetShop = `customer-erase-${suffix}.myshopify.com`;
  const controlShop = `customer-control-${suffix}.myshopify.com`;
  try {
    const [targetConnection, controlConnection] = await Promise.all([
      prisma!.integrationConnection.create({
        data: {
          companyId: targetCompany.id,
          provider: 'shopify',
          ownerType: 'company',
          label: 'Customer redaction target',
          externalAccountId: targetShop,
          dedupeKey: `shopify:${targetShop}`,
          scopes: ['read_customers', 'read_orders', 'read_reports'],
        },
      }),
      prisma!.integrationConnection.create({
        data: {
          companyId: controlCompany.id,
          provider: 'shopify',
          ownerType: 'company',
          label: 'Customer redaction control',
          externalAccountId: controlShop,
          dedupeKey: `shopify:${controlShop}`,
          scopes: ['read_customers'],
        },
      }),
    ]);
    const protectedRunId = `customer-protected-${suffix}`;
    const orderRunId = `order-protected-${suffix}`;
    const analyticsRunId = `analytics-safe-${suffix}`;
    const controlRunId = `customer-control-${suffix}`;
    const [customerRun, orderRun, analyticsRun, controlRun] = await Promise.all([
      prisma!.executionRun.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          requestId: protectedRunId,
          channel: 'lark',
          entrypoint: 'pi',
        },
      }),
      prisma!.executionRun.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          requestId: orderRunId,
          channel: 'desktop',
          entrypoint: 'pi',
        },
      }),
      prisma!.executionRun.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          requestId: analyticsRunId,
          channel: 'lark',
          entrypoint: 'pi',
        },
      }),
      prisma!.executionRun.create({
        data: {
          companyId: controlCompany.id,
          userId: controlUser.id,
          requestId: controlRunId,
          channel: 'lark',
          entrypoint: 'pi',
        },
      }),
    ]);
    await prisma!.shopifyRunProvenance.createMany({
      data: [
        {
          companyId: targetCompany.id,
          executionRunId: customerRun.id,
          connectionId: targetConnection.id,
          shopDomain: targetShop,
          toolId: 'shopifyCustomers',
        },
        {
          companyId: targetCompany.id,
          executionRunId: orderRun.id,
          connectionId: targetConnection.id,
          shopDomain: targetShop,
          toolId: 'shopifyOrders',
        },
        {
          companyId: targetCompany.id,
          executionRunId: analyticsRun.id,
          connectionId: targetConnection.id,
          shopDomain: targetShop,
          toolId: 'shopifyAnalytics',
        },
        {
          companyId: controlCompany.id,
          executionRunId: controlRun.id,
          connectionId: controlConnection.id,
          shopDomain: controlShop,
          toolId: 'shopifyCustomers',
        },
      ],
    });
    const [customerLearning, orderLearning, analyticsLearning, controlLearning] = await Promise.all([
      prisma!.knowledgeLearningJob.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          sourceId: `lark:${protectedRunId}`,
          channel: 'lark',
          companyRole: 'MEMBER',
          userMessages: ['protected customer result'],
        },
      }),
      prisma!.knowledgeLearningJob.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          sourceId: `desktop:${orderRun.id}`,
          channel: 'desktop',
          companyRole: 'MEMBER',
          userMessages: ['protected order result'],
        },
      }),
      prisma!.knowledgeLearningJob.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          sourceId: `lark:${analyticsRunId}`,
          channel: 'lark',
          companyRole: 'MEMBER',
          userMessages: ['analytics remains'],
        },
      }),
      prisma!.knowledgeLearningJob.create({
        data: {
          companyId: controlCompany.id,
          userId: controlUser.id,
          sourceId: `lark:${controlRunId}`,
          channel: 'lark',
          companyRole: 'MEMBER',
          userMessages: ['same shaped source in another tenant'],
        },
      }),
    ]);
    const [protectedConversation, analyticsConversation, controlConversation] = await Promise.all([
      prisma!.runtimeConversation.create({
        data: {
          companyId: targetCompany.id,
          channel: 'lark',
          channelConversationKey: `customer-protected-conversation-${suffix}`,
          rawChannelKey: `customer-protected-conversation-${suffix}`,
          lastMessageSequence: 1,
        },
      }),
      prisma!.runtimeConversation.create({
        data: {
          companyId: targetCompany.id,
          channel: 'lark',
          channelConversationKey: `analytics-safe-conversation-${suffix}`,
          rawChannelKey: `analytics-safe-conversation-${suffix}`,
          lastMessageSequence: 1,
        },
      }),
      prisma!.runtimeConversation.create({
        data: {
          companyId: controlCompany.id,
          channel: 'lark',
          channelConversationKey: `customer-control-conversation-${suffix}`,
          rawChannelKey: `customer-control-conversation-${suffix}`,
          lastMessageSequence: 1,
        },
      }),
    ]);
    const [protectedMessage, analyticsMessage, controlMessage] = await prisma!.$transaction([
      prisma!.runtimeConversationMessage.create({
        data: {
          conversationId: protectedConversation.id,
          sequence: 1,
          role: 'assistant',
          messageKind: 'text',
          sourceChannel: 'lark',
          sourceRunId: protectedRunId,
          contentText: 'protected customer result',
        },
      }),
      prisma!.runtimeConversationMessage.create({
        data: {
          conversationId: analyticsConversation.id,
          sequence: 1,
          role: 'assistant',
          messageKind: 'text',
          sourceChannel: 'lark',
          sourceRunId: analyticsRunId,
          contentText: 'analytics result remains',
        },
      }),
      prisma!.runtimeConversationMessage.create({
        data: {
          conversationId: controlConversation.id,
          sequence: 1,
          role: 'assistant',
          messageKind: 'text',
          sourceChannel: 'lark',
          sourceRunId: controlRunId,
          contentText: 'other tenant remains',
        },
      }),
    ]);
    const [targetContext, controlContext] = await Promise.all([
      prisma!.larkChatContext.create({
        data: {
          companyId: targetCompany.id,
          chatId: `customer-target-context-${suffix}`,
          channel: 'lark',
          recentMessagesJson: [{ protected: true }],
          sourceMessageCount: 1,
        },
      }),
      prisma!.larkChatContext.create({
        data: {
          companyId: controlCompany.id,
          chatId: `customer-control-context-${suffix}`,
          channel: 'lark',
          recentMessagesJson: [{ retained: true }],
          sourceMessageCount: 1,
        },
      }),
    ]);
    const customerId = `customer-redact-${suffix}`;
    const privacy = new PrismaShopifyPrivacyRepository(prisma!, encryptionKey);
    const lifecycle = await privacy.create({
      companyId: targetCompany.id,
      shopDomain: targetShop,
      requestId: `customer-redact-request-${suffix}`,
      customerId,
      orderIds: [],
      state: 'ready',
      exportPayload: { protected: true },
      deadlineAt: new Date(Date.now() + 30 * 86_400_000),
      expiresAt: new Date(Date.now() + 37 * 86_400_000),
    });
    assert.ok(lifecycle.ok);

    const result = await new ShopifyWebhookRepository(prisma!, privacy).process({
      webhookId: `complete-customer-erase-${suffix}`,
      topic: 'customers/redact',
      shopDomain: targetShop,
      action: 'purge_customer_traces',
      privacyRequest: { customerId, orderIds: [] },
    });
    assert.ok(result.ok);
    assert.equal(result.value.affectedConnections, 0);

    assert.equal(await prisma!.executionRun.findUnique({ where: { id: customerRun.id } }), null);
    assert.equal(await prisma!.executionRun.findUnique({ where: { id: orderRun.id } }), null);
    assert.ok(await prisma!.executionRun.findUnique({ where: { id: analyticsRun.id } }));
    assert.ok(await prisma!.executionRun.findUnique({ where: { id: controlRun.id } }));
    assert.equal(await prisma!.knowledgeLearningJob.findUnique({ where: { id: customerLearning.id } }), null);
    assert.equal(await prisma!.knowledgeLearningJob.findUnique({ where: { id: orderLearning.id } }), null);
    assert.ok(await prisma!.knowledgeLearningJob.findUnique({ where: { id: analyticsLearning.id } }));
    assert.ok(await prisma!.knowledgeLearningJob.findUnique({ where: { id: controlLearning.id } }));
    assert.equal(await prisma!.runtimeConversationMessage.findUnique({ where: { id: protectedMessage.id } }), null);
    assert.ok(await prisma!.runtimeConversationMessage.findUnique({ where: { id: analyticsMessage.id } }));
    assert.ok(await prisma!.runtimeConversationMessage.findUnique({ where: { id: controlMessage.id } }));
    assert.equal((await prisma!.runtimeConversation.findUniqueOrThrow({
      where: { id: protectedConversation.id },
    })).historyRevision, 1);
    const postErasureTurn = await new ConversationRepository(prisma!).appendTurn(
      protectedConversation.channelConversationKey,
      { role: 'assistant', content: 'must not reappear', timestamp: new Date().toISOString() },
      { companyId: targetCompany.id, channel: 'lark' },
      { sourceRunId: protectedRunId },
    );
    assert.equal(postErasureTurn.ok, false);
    assert.equal(await prisma!.runtimeConversationMessage.count({
      where: { conversationId: protectedConversation.id },
    }), 0);
    assert.equal((await prisma!.larkChatContext.findUniqueOrThrow({ where: { id: targetContext.id } })).recentMessagesJson, null);
    assert.notEqual((await prisma!.larkChatContext.findUniqueOrThrow({ where: { id: controlContext.id } })).recentMessagesJson, null);
    assert.ok(await prisma!.integrationConnection.findUnique({ where: { id: targetConnection.id } }));
    assert.ok(await prisma!.integrationConnection.findUnique({ where: { id: controlConnection.id } }));
    assert.equal((await prisma!.shopifyPrivacyRequest.findUniqueOrThrow({
      where: { id: lifecycle.value.request.id },
    })).state, 'redacted');
  } finally {
    await prisma!.company.delete({ where: { id: targetCompany.id } }).catch(() => undefined);
    await prisma!.company.delete({ where: { id: controlCompany.id } }).catch(() => undefined);
    await prisma!.user.delete({ where: { id: targetUser.id } }).catch(() => undefined);
    await prisma!.user.delete({ where: { id: controlUser.id } }).catch(() => undefined);
  }
});

test('real Postgres: customer redaction rolls back protected stores and receipt on late failure', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const company = await prisma!.company.create({ data: { name: `Customer rollback ${suffix}` } });
  const user = await prisma!.user.create({
    data: { email: `customer-rollback-${suffix}@example.test`, password: 'integration-only' },
  });
  const domain = `customer-rollback-${suffix}.myshopify.com`;
  const triggerSuffix = suffix.replace(/-/g, '_');
  const functionName = `shopify_customer_fail_${triggerSuffix}`;
  const triggerName = `shopify_customer_trigger_${triggerSuffix}`;
  try {
    const connection = await prisma!.integrationConnection.create({
      data: {
        companyId: company.id,
        provider: 'shopify',
        ownerType: 'company',
        label: 'Customer rollback shop',
        externalAccountId: domain,
        dedupeKey: `shopify:${domain}`,
        scopes: ['read_customers'],
      },
    });
    const runId = `customer-rollback-run-${suffix}`;
    const execution = await prisma!.executionRun.create({
      data: {
        companyId: company.id,
        userId: user.id,
        requestId: runId,
        channel: 'lark',
        entrypoint: 'pi',
      },
    });
    const provenance = await prisma!.shopifyRunProvenance.create({
      data: {
        companyId: company.id,
        executionRunId: execution.id,
        connectionId: connection.id,
        shopDomain: domain,
        toolId: 'shopifyCustomers',
      },
    });
    const learning = await prisma!.knowledgeLearningJob.create({
      data: {
        companyId: company.id,
        userId: user.id,
        sourceId: `lark:${runId}`,
        channel: 'lark',
        companyRole: 'MEMBER',
        userMessages: ['must roll back'],
      },
    });
    const conversation = await prisma!.runtimeConversation.create({
      data: {
        companyId: company.id,
        channel: 'lark',
        channelConversationKey: `customer-rollback-conversation-${suffix}`,
        rawChannelKey: `customer-rollback-conversation-${suffix}`,
        summaryJson: { retained: true },
        lastMessageSequence: 1,
      },
    });
    const message = await prisma!.runtimeConversationMessage.create({
      data: {
        conversationId: conversation.id,
        sequence: 1,
        role: 'assistant',
        messageKind: 'text',
        sourceChannel: 'lark',
        sourceRunId: runId,
        contentText: 'must roll back',
      },
    });
    const context = await prisma!.larkChatContext.create({
      data: {
        companyId: company.id,
        chatId: `customer-rollback-context-${suffix}`,
        channel: 'lark',
        recentMessagesJson: [{ retained: true }],
        sourceMessageCount: 1,
      },
    });
    const customerId = `customer-rollback-id-${suffix}`;
    const privacy = new PrismaShopifyPrivacyRepository(prisma!, encryptionKey);
    const lifecycle = await privacy.create({
      companyId: company.id,
      shopDomain: domain,
      requestId: `customer-rollback-request-${suffix}`,
      customerId,
      orderIds: [],
      state: 'ready',
      exportPayload: { retained: true },
      deadlineAt: new Date(Date.now() + 30 * 86_400_000),
      expiresAt: new Date(Date.now() + 37 * 86_400_000),
    });
    assert.ok(lifecycle.ok);
    await prisma!.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF OLD."id" = '${execution.id}' THEN
          RAISE EXCEPTION 'forced late customer redaction failure';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma!.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE DELETE ON "ExecutionRun"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);

    const webhookId = `rollback-customer-erase-${suffix}`;
    const result = await new ShopifyWebhookRepository(prisma!, privacy).process({
      webhookId,
      topic: 'customers/redact',
      shopDomain: domain,
      action: 'purge_customer_traces',
      privacyRequest: { customerId, orderIds: [] },
    });
    assert.equal(result.ok, false);
    assert.equal(await prisma!.integrationWebhookReceipt.findUnique({
      where: { provider_webhookId: { provider: 'shopify', webhookId } },
    }), null);
    assert.ok(await prisma!.executionRun.findUnique({ where: { id: execution.id } }));
    assert.ok(await prisma!.shopifyRunProvenance.findUnique({ where: { id: provenance.id } }));
    assert.ok(await prisma!.knowledgeLearningJob.findUnique({ where: { id: learning.id } }));
    assert.ok(await prisma!.runtimeConversationMessage.findUnique({ where: { id: message.id } }));
    assert.equal((await prisma!.runtimeConversation.findUniqueOrThrow({ where: { id: conversation.id } })).historyRevision, 0);
    assert.notEqual((await prisma!.larkChatContext.findUniqueOrThrow({ where: { id: context.id } })).recentMessagesJson, null);
    assert.equal((await prisma!.shopifyPrivacyRequest.findUniqueOrThrow({
      where: { id: lifecycle.value.request.id },
    })).state, 'ready');
    assert.ok(await prisma!.integrationConnection.findUnique({ where: { id: connection.id } }));
  } finally {
    await prisma!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "ExecutionRun"`).catch(() => undefined);
    await prisma!.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => undefined);
    await prisma!.company.delete({ where: { id: company.id } }).catch(() => undefined);
    await prisma!.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test('real Postgres: signed redaction drains more than 100 lifecycle rows and admission rolls back on failure', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const customerId = `bulk-customer-${suffix}`;
  const encrypted = encryptToken(JSON.stringify({ retainedCustomerOrOrderRecords: [] }), encryptionKey);
  const now = new Date();
  await prisma!.shopifyPrivacyRequest.createMany({
    data: Array.from({ length: 101 }, (_, index) => ({
      companyId,
      shopDomain,
      requestId: `bulk-${index}-${suffix}`,
      customerIdHash: hashProtectedIdentifier(customerId),
      orderIdHashes: [],
      state: 'ready' as const,
      exportPayloadEncrypted: encrypted.cipherText,
      exportCipherVersion: encrypted.version,
      deadlineAt: new Date(now.getTime() + 30 * 86_400_000),
      expiresAt: new Date(now.getTime() + 37 * 86_400_000),
      readyAt: now,
    })),
  });
  const privacy = new PrismaShopifyPrivacyRepository(prisma!, encryptionKey);
  const webhooks = new ShopifyWebhookRepository(prisma!, privacy);
  const result = await webhooks.process({
    webhookId: `bulk-redact-${suffix}`,
    topic: 'customers/redact',
    shopDomain,
    action: 'purge_customer_traces',
    privacyRequest: { customerId, orderIds: [] },
  });
  assert.ok(result.ok);
  assert.equal(await prisma!.shopifyPrivacyRequest.count({
    where: { companyId, shopDomain, customerIdHash: hashProtectedIdentifier(customerId), state: { not: 'redacted' } },
  }), 0);

  const failing = new ShopifyWebhookRepository(prisma!, {
    createInTransaction: async () => { throw new Error('lifecycle unavailable'); },
    findRedactionCompanyIdsInTransaction: async () => [],
    findShopCompanyIdsInTransaction: async () => [],
    redactInTransaction: async () => ({ affected: 0, hasMore: false }),
    redactShopInTransaction: async () => ({ affected: 0, hasMore: false }),
  });
  const webhookId = `atomic-failure-${suffix}`;
  const failed = await failing.process({
    webhookId,
    topic: 'customers/data_request',
    shopDomain,
    action: 'record_data_request',
    privacyRequest: { requestId: `atomic-${suffix}`, customerId, orderIds: [] },
  });
  assert.equal(failed.ok, false);
  assert.equal(await prisma!.integrationWebhookReceipt.findUnique({
    where: { provider_webhookId: { provider: 'shopify', webhookId } },
  }), null);

  const shopEraseLifecycle = await privacy.create({
    companyId,
    shopDomain,
    requestId: `shop-erase-${suffix}`,
    customerId: `shop-erase-customer-${suffix}`,
    orderIds: [],
    state: 'ready',
    exportPayload: { protected: `shop-erase-secret-${suffix}` },
    deadlineAt: new Date(now.getTime() + 30 * 86_400_000),
    expiresAt: new Date(now.getTime() + 37 * 86_400_000),
  });
  assert.ok(shopEraseLifecycle.ok);
  const erased = await webhooks.process({
    webhookId: `shop-erase-${suffix}`,
    topic: 'shop/redact',
    shopDomain,
    action: 'erase',
  });
  assert.ok(erased.ok);
  assert.equal(erased.value.affectedConnections, 1);
  const erasedLifecycle = await prisma!.shopifyPrivacyRequest.findUniqueOrThrow({
    where: { id: shopEraseLifecycle.value.request.id },
  });
  assert.equal(erasedLifecycle.state, 'redacted');
  assert.equal(erasedLifecycle.customerIdHash, null);
  assert.equal(erasedLifecycle.exportPayloadEncrypted, null);
  assert.equal(await prisma!.integrationConnection.count({
    where: { provider: 'shopify', externalAccountId: shopDomain },
  }), 0);
});

test('real Postgres: shop erasure removes every proven durable derivative and preserves unrelated controls', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const targetCompany = await prisma!.company.create({ data: { name: `Provenance target ${suffix}` } });
  const controlCompany = await prisma!.company.create({ data: { name: `Provenance control ${suffix}` } });
  const targetShop = `erase-${suffix}.myshopify.com`;
  const siblingShop = `sibling-${suffix}.myshopify.com`;
  const controlShop = `control-${suffix}.myshopify.com`;
  const targetUser = await prisma!.user.create({
    data: { email: `erase-target-${suffix}@example.test`, password: 'integration-only' },
  });
  const controlUser = await prisma!.user.create({
    data: { email: `erase-control-${suffix}@example.test`, password: 'integration-only' },
  });
  try {
    const [targetConnection, siblingConnection, controlConnection] = await Promise.all([
      prisma!.integrationConnection.create({
        data: {
          companyId: targetCompany.id,
          provider: 'shopify',
          ownerType: 'company',
          label: 'Target shop',
          externalAccountId: targetShop,
          dedupeKey: `shopify:${targetShop}`,
          scopes: ['read_reports'],
        },
      }),
      prisma!.integrationConnection.create({
        data: {
          companyId: targetCompany.id,
          provider: 'shopify',
          ownerType: 'company',
          label: 'Sibling shop',
          externalAccountId: siblingShop,
          dedupeKey: `shopify:${siblingShop}`,
          scopes: ['read_reports'],
        },
      }),
      prisma!.integrationConnection.create({
        data: {
          companyId: controlCompany.id,
          provider: 'shopify',
          ownerType: 'company',
          label: 'Other tenant shop',
          externalAccountId: controlShop,
          dedupeKey: `shopify:${controlShop}`,
          scopes: ['read_reports'],
        },
      }),
    ]);
    const department = await prisma!.department.create({
      data: { companyId: targetCompany.id, name: 'Erasure department', slug: `erase-${suffix}` },
    });
    const targetRunId = `erase-run-${suffix}`;
    const siblingRunId = `sibling-run-${suffix}`;
    const [targetExecution, siblingExecution] = await Promise.all([
      prisma!.executionRun.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          requestId: targetRunId,
          channel: 'lark',
          entrypoint: 'pi',
          latestSummary: `target summary ${suffix}`,
        },
      }),
      prisma!.executionRun.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          requestId: siblingRunId,
          channel: 'desktop',
          entrypoint: 'pi',
          latestSummary: `sibling summary ${suffix}`,
        },
      }),
    ]);
    await prisma!.shopifyRunProvenance.createMany({
      data: [
        {
          companyId: targetCompany.id,
          executionRunId: targetExecution.id,
          connectionId: targetConnection.id,
          shopDomain: targetShop,
          toolId: 'shopifyAnalytics',
        },
        {
          companyId: targetCompany.id,
          executionRunId: siblingExecution.id,
          connectionId: siblingConnection.id,
          shopDomain: siblingShop,
          toolId: 'shopifyAnalytics',
        },
      ],
    });
    const targetEvent = await prisma!.executionEvent.create({
      data: {
        executionId: targetExecution.id,
        sequence: 1,
        phase: 'execute',
        eventType: 'tool_result',
        actorType: 'tool',
        title: 'Shopify analytics',
        payload: { secret: `target-event-${suffix}` },
      },
    });
    const targetStep = await prisma!.stepResult.create({
      data: {
        executionId: targetExecution.id,
        sequence: 1,
        toolName: 'divo_gateway',
        success: true,
        rawOutput: { secret: `target-step-${suffix}` },
      },
    });
    const siblingEvent = await prisma!.executionEvent.create({
      data: {
        executionId: siblingExecution.id,
        sequence: 1,
        phase: 'execute',
        eventType: 'tool_result',
        actorType: 'tool',
        title: 'Sibling analytics',
        payload: { safe: true },
      },
    });
    const siblingStep = await prisma!.stepResult.create({
      data: {
        executionId: siblingExecution.id,
        sequence: 1,
        toolName: 'divo_gateway',
        success: true,
        rawOutput: { safe: true },
      },
    });

    const tree = await prisma!.managerPersonaTree.create({
      data: {
        companyId: targetCompany.id,
        managerId: targetUser.id,
        departmentId: department.id,
      },
    });
    const targetNode = await prisma!.managerPersonaNode.create({
      data: {
        treeId: tree.id,
        companyId: targetCompany.id,
        managerId: targetUser.id,
        departmentId: department.id,
        kind: 'preference',
        scopeKey: 'shopify-target',
        ruleKey: `shopify-target-${suffix}`,
        instruction: `derived target ${suffix}`,
        confidence: 0.9,
        evidenceCount: 1,
        firstEvidenceAt: new Date(),
        lastEvidenceAt: new Date(),
      },
    });
    const siblingNode = await prisma!.managerPersonaNode.create({
      data: {
        treeId: tree.id,
        companyId: targetCompany.id,
        managerId: targetUser.id,
        departmentId: department.id,
        kind: 'workflow',
        scopeKey: 'shopify-sibling',
        ruleKey: `shopify-sibling-${suffix}`,
        instruction: `unrelated sibling ${suffix}`,
        confidence: 0.9,
        evidenceCount: 1,
        firstEvidenceAt: new Date(),
        lastEvidenceAt: new Date(),
      },
    });
    const targetEvidence = await prisma!.personaLearningEvidence.create({
      data: {
        companyId: targetCompany.id,
        managerId: targetUser.id,
        departmentId: department.id,
        executionRunId: targetExecution.id,
        threadId: `thread-${suffix}`,
        status: 'eligible',
        contextJson: { secret: `target-persona-${suffix}` },
        toolSummaryJson: [{ toolId: 'shopifyAnalytics' }],
      },
    });
    const siblingEvidence = await prisma!.personaLearningEvidence.create({
      data: {
        companyId: targetCompany.id,
        managerId: targetUser.id,
        departmentId: department.id,
        executionRunId: siblingExecution.id,
        threadId: `sibling-thread-${suffix}`,
        status: 'eligible',
        contextJson: { safe: true },
        toolSummaryJson: [{ toolId: 'shopifyAnalytics' }],
      },
    });
    const targetPersonaJob = await prisma!.personaLearningJob.create({
      data: { evidenceId: targetEvidence.id, idempotencyKey: `target-persona-${suffix}` },
    });
    const siblingPersonaJob = await prisma!.personaLearningJob.create({
      data: { evidenceId: siblingEvidence.id, idempotencyKey: `sibling-persona-${suffix}` },
    });
    const targetCandidate = await prisma!.personaLearningCandidate.create({
      data: {
        companyId: targetCompany.id,
        managerId: targetUser.id,
        departmentId: department.id,
        evidenceId: targetEvidence.id,
        jobId: targetPersonaJob.id,
        ordinal: 0,
        kind: 'preference',
        scopeKey: 'target',
        ruleKey: `target-${suffix}`,
        claim: 'target',
        rationale: 'target',
        evidenceStrength: 'explicit',
        status: 'active',
        promotedNodeId: targetNode.id,
        promotedAt: new Date(),
      },
    });
    const siblingCandidate = await prisma!.personaLearningCandidate.create({
      data: {
        companyId: targetCompany.id,
        managerId: targetUser.id,
        departmentId: department.id,
        evidenceId: siblingEvidence.id,
        jobId: siblingPersonaJob.id,
        ordinal: 0,
        kind: 'workflow',
        scopeKey: 'sibling',
        ruleKey: `sibling-${suffix}`,
        claim: 'sibling',
        rationale: 'sibling',
        evidenceStrength: 'explicit',
        status: 'active',
        promotedNodeId: siblingNode.id,
        promotedAt: new Date(),
      },
    });
    const [desktopLearning, larkLearning, siblingLearning] = await Promise.all([
      prisma!.knowledgeLearningJob.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          sourceId: `desktop:${targetExecution.id}`,
          channel: 'desktop',
          companyRole: 'MEMBER',
          userMessages: [`target desktop ${suffix}`],
        },
      }),
      prisma!.knowledgeLearningJob.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          sourceId: `lark:${targetRunId}`,
          channel: 'lark',
          companyRole: 'MEMBER',
          userMessages: [`target lark ${suffix}`],
        },
      }),
      prisma!.knowledgeLearningJob.create({
        data: {
          companyId: targetCompany.id,
          userId: targetUser.id,
          sourceId: `desktop:${siblingExecution.id}`,
          channel: 'desktop',
          companyRole: 'MEMBER',
          userMessages: ['safe sibling'],
        },
      }),
    ]);
    const targetResource = await prisma!.knowledgeResource.create({
      data: {
        companyId: targetCompany.id,
        kind: 'memory',
        scope: 'personal',
        targetKey: `personal:${targetUser.id}`,
        ownerUserId: targetUser.id,
        logicalKey: `shopify-derived-${suffix}`,
        status: 'active',
        createdById: targetUser.id,
      },
    });
    const targetVersion = await prisma!.knowledgeVersion.create({
      data: {
        resourceId: targetResource.id,
        version: 1,
        contentJson: { facts: [`shopify derived ${suffix}`] },
        contentHash: createHash('sha256').update(`target-version-${suffix}`).digest('hex'),
        sourceType: 'automatic_learning',
        sourceRef: `lark:${targetRunId}`,
        createdById: targetUser.id,
      },
    });
    await prisma!.knowledgeResource.update({
      where: { id: targetResource.id },
      data: { currentVersion: 1 },
    });
    const targetLearningMutation = await prisma!.knowledgeMutation.create({
      data: {
        companyId: targetCompany.id,
        resourceId: targetResource.id,
        kind: 'memory',
        scope: 'personal',
        targetKey: `personal:${targetUser.id}`,
        ownerUserId: targetUser.id,
        logicalKey: targetResource.logicalKey,
        action: 'create',
        proposedContentJson: { facts: [`shopify derived ${suffix}`] },
        proposedContentHash: targetVersion.contentHash,
        sourceType: 'automatic_learning',
        sourceRef: `lark:${targetRunId}`,
        requesterId: targetUser.id,
        requesterReviewRequired: false,
        requiredAuthority: 'none',
        distinctApprover: false,
        policyId: 'integration-automatic-learning',
        policyVersion: 1,
        appliedVersionId: targetVersion.id,
        status: 'applied',
        idempotencyKey: `target-learning-mutation-${suffix}`,
        decidedAt: new Date(),
        appliedAt: new Date(),
      },
    });
    await prisma!.knowledgeOutbox.create({
      data: {
        mutationId: targetLearningMutation.id,
        eventType: 'knowledge.version.applied',
        payloadJson: { resourceId: targetResource.id, version: 1 },
        dedupeKey: `${targetLearningMutation.id}:version:1`,
        status: 'completed',
        completedAt: new Date(),
      },
    });
    const targetLaterVersion = await prisma!.knowledgeVersion.create({
      data: {
        resourceId: targetResource.id,
        version: 2,
        contentJson: { facts: [`shopify derived ${suffix}`, 'later copied fact'] },
        contentHash: createHash('sha256').update(`target-later-version-${suffix}`).digest('hex'),
        sourceType: 'manual',
        sourceRef: `manual:${suffix}`,
        createdById: targetUser.id,
      },
    });
    await prisma!.knowledgeResource.update({
      where: { id: targetResource.id },
      data: { currentVersion: 2 },
    });
    const targetLaterMutation = await prisma!.knowledgeMutation.create({
      data: {
        companyId: targetCompany.id,
        resourceId: targetResource.id,
        kind: 'memory',
        scope: 'personal',
        targetKey: `personal:${targetUser.id}`,
        ownerUserId: targetUser.id,
        logicalKey: targetResource.logicalKey,
        action: 'update',
        baseVersion: 1,
        proposedContentJson: { facts: [`shopify derived ${suffix}`, 'later copied fact'] },
        proposedContentHash: targetLaterVersion.contentHash,
        sourceType: 'manual',
        sourceRef: `manual:${suffix}`,
        requesterId: targetUser.id,
        requesterReviewRequired: false,
        requiredAuthority: 'none',
        distinctApprover: false,
        policyId: 'integration-manual-update',
        policyVersion: 1,
        appliedVersionId: targetLaterVersion.id,
        status: 'applied',
        idempotencyKey: `target-later-mutation-${suffix}`,
        decidedAt: new Date(),
        appliedAt: new Date(),
      },
    });
    const siblingResource = await prisma!.knowledgeResource.create({
      data: {
        companyId: targetCompany.id,
        kind: 'memory',
        scope: 'personal',
        targetKey: `personal:${targetUser.id}`,
        ownerUserId: targetUser.id,
        logicalKey: `sibling-derived-${suffix}`,
        status: 'active',
        createdById: targetUser.id,
      },
    });
    const siblingVersion = await prisma!.knowledgeVersion.create({
      data: {
        resourceId: siblingResource.id,
        version: 1,
        contentJson: { facts: ['sibling data remains'] },
        contentHash: createHash('sha256').update(`sibling-version-${suffix}`).digest('hex'),
        sourceType: 'automatic_learning',
        sourceRef: `desktop:${siblingExecution.id}`,
        createdById: targetUser.id,
      },
    });
    await prisma!.knowledgeResource.update({
      where: { id: siblingResource.id },
      data: { currentVersion: 1 },
    });
    await prisma!.knowledgeMutation.create({
      data: {
        companyId: targetCompany.id,
        resourceId: siblingResource.id,
        kind: 'memory',
        scope: 'personal',
        targetKey: `personal:${targetUser.id}`,
        ownerUserId: targetUser.id,
        logicalKey: siblingResource.logicalKey,
        action: 'create',
        proposedContentJson: { facts: ['sibling data remains'] },
        proposedContentHash: siblingVersion.contentHash,
        sourceType: 'automatic_learning',
        sourceRef: `desktop:${siblingExecution.id}`,
        requesterId: targetUser.id,
        requesterReviewRequired: false,
        requiredAuthority: 'none',
        distinctApprover: false,
        policyId: 'integration-automatic-learning',
        policyVersion: 1,
        appliedVersionId: siblingVersion.id,
        status: 'applied',
        idempotencyKey: `sibling-learning-mutation-${suffix}`,
        decidedAt: new Date(),
        appliedAt: new Date(),
      },
    });
    const contaminatedConversation = await prisma!.runtimeConversation.create({
      data: {
        companyId: targetCompany.id,
        channel: 'lark',
        channelConversationKey: `target-conversation-${suffix}`,
        rawChannelKey: `target-conversation-${suffix}`,
        title: `target title ${suffix}`,
        refsJson: { target: true },
        summaryJson: { target: true },
        summaryUpdatedAt: new Date(),
        lastSummarizedSequence: 2,
        lastMessageSequence: 2,
      },
    });
    await prisma!.runtimeConversationMessage.createMany({
      data: [
        {
          conversationId: contaminatedConversation.id,
          sequence: 1,
          role: 'assistant',
          messageKind: 'text',
          sourceChannel: 'lark',
          sourceRunId: targetRunId,
          contentText: `target answer ${suffix}`,
        },
        {
          conversationId: contaminatedConversation.id,
          sequence: 2,
          role: 'user',
          messageKind: 'text',
          sourceChannel: 'lark',
          sourceRunId: `later-run-${suffix}`,
          contentText: 'later unrelated turn in contaminated conversation',
        },
      ],
    });
    const controlConversation = await prisma!.runtimeConversation.create({
      data: {
        companyId: controlCompany.id,
        channel: 'lark',
        channelConversationKey: `control-conversation-${suffix}`,
        rawChannelKey: `control-conversation-${suffix}`,
        lastMessageSequence: 1,
      },
    });
    const controlMessage = await prisma!.runtimeConversationMessage.create({
      data: {
        conversationId: controlConversation.id,
        sequence: 1,
        role: 'assistant',
        messageKind: 'text',
        sourceChannel: 'lark',
        sourceRunId: targetRunId,
        contentText: 'same run-shaped string in another tenant',
      },
    });
    const [targetContext, siblingContext, controlContext] = await Promise.all([
      prisma!.larkChatContext.create({
        data: {
          companyId: targetCompany.id,
          chatId: `target-context-${suffix}`,
          channel: 'lark',
          recentMessagesJson: [{ text: `target analytics ${suffix}` }],
          summaryJson: { target: true },
          taskStateJson: { target: true },
          sourceMessageCount: 1,
          lastMessageAt: new Date(),
        },
      }),
      prisma!.larkChatContext.create({
        data: {
          companyId: targetCompany.id,
          chatId: `sibling-context-${suffix}`,
          channel: 'lark',
          recentMessagesJson: [{ text: 'same tenant fail-safe control' }],
          sourceMessageCount: 1,
          lastMessageAt: new Date(),
        },
      }),
      prisma!.larkChatContext.create({
        data: {
          companyId: controlCompany.id,
          chatId: `control-context-${suffix}`,
          channel: 'lark',
          recentMessagesJson: [{ text: 'other tenant remains' }],
          sourceMessageCount: 1,
          lastMessageAt: new Date(),
        },
      }),
    ]);
    assert.ok(controlConnection.id);

    const privacy = new PrismaShopifyPrivacyRepository(prisma!, encryptionKey);
    const result = await new ShopifyWebhookRepository(prisma!, privacy).process({
      webhookId: `complete-shop-erase-${suffix}`,
      topic: 'shop/redact',
      shopDomain: targetShop,
      action: 'erase',
    });
    assert.ok(result.ok);
    assert.equal(result.value.affectedConnections, 1);

    assert.equal(await prisma!.integrationConnection.findUnique({ where: { id: targetConnection.id } }), null);
    assert.ok(await prisma!.integrationConnection.findUnique({ where: { id: siblingConnection.id } }));
    assert.ok(await prisma!.integrationConnection.findUnique({ where: { id: controlConnection.id } }));
    assert.equal(await prisma!.executionRun.findUnique({ where: { id: targetExecution.id } }), null);
    assert.ok(await prisma!.executionRun.findUnique({ where: { id: siblingExecution.id } }));
    assert.equal(await prisma!.executionEvent.findUnique({ where: { id: targetEvent.id } }), null);
    assert.equal(await prisma!.stepResult.findUnique({ where: { id: targetStep.id } }), null);
    assert.ok(await prisma!.executionEvent.findUnique({ where: { id: siblingEvent.id } }));
    assert.ok(await prisma!.stepResult.findUnique({ where: { id: siblingStep.id } }));
    for (const id of [targetEvidence.id, targetPersonaJob.id, targetCandidate.id, targetNode.id]) {
      const counts = await Promise.all([
        prisma!.personaLearningEvidence.count({ where: { id } }),
        prisma!.personaLearningJob.count({ where: { id } }),
        prisma!.personaLearningCandidate.count({ where: { id } }),
        prisma!.managerPersonaNode.count({ where: { id } }),
      ]);
      assert.equal(counts.reduce((sum, count) => sum + count, 0), 0);
    }
    assert.ok(await prisma!.personaLearningEvidence.findUnique({ where: { id: siblingEvidence.id } }));
    assert.ok(await prisma!.personaLearningJob.findUnique({ where: { id: siblingPersonaJob.id } }));
    assert.ok(await prisma!.personaLearningCandidate.findUnique({ where: { id: siblingCandidate.id } }));
    assert.ok(await prisma!.managerPersonaNode.findUnique({ where: { id: siblingNode.id } }));
    assert.equal(await prisma!.knowledgeLearningJob.findUnique({ where: { id: desktopLearning.id } }), null);
    assert.equal(await prisma!.knowledgeLearningJob.findUnique({ where: { id: larkLearning.id } }), null);
    assert.ok(await prisma!.knowledgeLearningJob.findUnique({ where: { id: siblingLearning.id } }));
    assert.equal((await prisma!.knowledgeResource.findUniqueOrThrow({
      where: { id: targetResource.id },
    })).status, 'deleted');
    assert.equal(await prisma!.knowledgeVersion.findUnique({ where: { id: targetVersion.id } }), null);
    assert.equal(await prisma!.knowledgeVersion.findUnique({ where: { id: targetLaterVersion.id } }), null);
    assert.equal(await prisma!.knowledgeMutation.findUnique({ where: { id: targetLearningMutation.id } }), null);
    assert.equal(await prisma!.knowledgeMutation.findUnique({ where: { id: targetLaterMutation.id } }), null);
    const deletionMutation = await prisma!.knowledgeMutation.findFirstOrThrow({
      where: {
        resourceId: targetResource.id,
        sourceType: 'shopify_privacy_erasure',
        status: 'applied',
      },
    });
    const deletionOutbox = await prisma!.knowledgeOutbox.findFirstOrThrow({
      where: { mutationId: deletionMutation.id, eventType: 'knowledge.resource.deleted' },
    });
    assert.equal(deletionOutbox.status, 'pending');
    assert.equal((await prisma!.knowledgeResource.findUniqueOrThrow({
      where: { id: siblingResource.id },
    })).status, 'active');
    assert.ok(await prisma!.knowledgeVersion.findUnique({ where: { id: siblingVersion.id } }));
    assert.equal(await prisma!.runtimeConversationMessage.count({
      where: { conversationId: contaminatedConversation.id },
    }), 0);
    const clearedConversation = await prisma!.runtimeConversation.findUniqueOrThrow({
      where: { id: contaminatedConversation.id },
    });
    assert.equal(clearedConversation.historyRevision, 1);
    assert.equal(clearedConversation.title, null);
    assert.equal(clearedConversation.refsJson, null);
    assert.equal(clearedConversation.summaryJson, null);
    assert.ok(await prisma!.runtimeConversationMessage.findUnique({ where: { id: controlMessage.id } }));
    assert.equal(await prisma!.shopifyRunProvenance.count({
      where: { companyId: targetCompany.id, shopDomain: targetShop },
    }), 0);
    assert.equal(await prisma!.shopifyRunProvenance.count({
      where: { companyId: targetCompany.id, shopDomain: siblingShop },
    }), 1);
    for (const id of [targetContext.id, siblingContext.id]) {
      const cleared = await prisma!.larkChatContext.findUniqueOrThrow({ where: { id } });
      assert.equal(cleared.recentMessagesJson, null);
      assert.equal(cleared.summaryJson, null);
      assert.equal(cleared.taskStateJson, null);
      assert.equal(cleared.sourceMessageCount, 0);
    }
    assert.notEqual((await prisma!.larkChatContext.findUniqueOrThrow({
      where: { id: controlContext.id },
    })).recentMessagesJson, null);
  } finally {
    await prisma!.company.delete({ where: { id: targetCompany.id } }).catch(() => undefined);
    await prisma!.company.delete({ where: { id: controlCompany.id } }).catch(() => undefined);
    await prisma!.user.delete({ where: { id: targetUser.id } }).catch(() => undefined);
    await prisma!.user.delete({ where: { id: controlUser.id } }).catch(() => undefined);
  }
});

test('real Postgres: shop erasure rolls back traces, learning, context, provenance, and receipt on late failure', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const company = await prisma!.company.create({ data: { name: `Rollback target ${suffix}` } });
  const user = await prisma!.user.create({
    data: { email: `erase-rollback-${suffix}@example.test`, password: 'integration-only' },
  });
  const domain = `rollback-${suffix}.myshopify.com`;
  const triggerSuffix = suffix.replace(/-/g, '_');
  const functionName = `shopify_erase_fail_${triggerSuffix}`;
  const triggerName = `shopify_erase_trigger_${triggerSuffix}`;
  try {
    const connection = await prisma!.integrationConnection.create({
      data: {
        companyId: company.id,
        provider: 'shopify',
        ownerType: 'company',
        label: 'Rollback shop',
        externalAccountId: domain,
        dedupeKey: `shopify:${domain}`,
        scopes: ['read_reports'],
      },
    });
    const execution = await prisma!.executionRun.create({
      data: {
        companyId: company.id,
        userId: user.id,
        requestId: `rollback-run-${suffix}`,
        channel: 'lark',
        entrypoint: 'pi',
        latestSummary: 'must survive rollback',
      },
    });
    const provenance = await prisma!.shopifyRunProvenance.create({
      data: {
        companyId: company.id,
        executionRunId: execution.id,
        connectionId: connection.id,
        shopDomain: domain,
        toolId: 'shopifyAnalytics',
      },
    });
    const event = await prisma!.executionEvent.create({
      data: {
        executionId: execution.id,
        sequence: 1,
        phase: 'execute',
        eventType: 'tool_result',
        actorType: 'tool',
        title: 'rollback event',
      },
    });
    const learning = await prisma!.knowledgeLearningJob.create({
      data: {
        companyId: company.id,
        userId: user.id,
        sourceId: `lark:rollback-run-${suffix}`,
        channel: 'lark',
        companyRole: 'MEMBER',
        userMessages: ['must survive rollback'],
      },
    });
    const resource = await prisma!.knowledgeResource.create({
      data: {
        companyId: company.id,
        kind: 'memory',
        scope: 'personal',
        targetKey: `personal:${user.id}`,
        ownerUserId: user.id,
        logicalKey: `rollback-learning-${suffix}`,
        status: 'active',
        createdById: user.id,
      },
    });
    const version = await prisma!.knowledgeVersion.create({
      data: {
        resourceId: resource.id,
        version: 1,
        contentJson: { facts: ['must survive rollback'] },
        contentHash: createHash('sha256').update(`rollback-version-${suffix}`).digest('hex'),
        sourceType: 'automatic_learning',
        sourceRef: `lark:rollback-run-${suffix}`,
        createdById: user.id,
      },
    });
    await prisma!.knowledgeResource.update({
      where: { id: resource.id },
      data: { currentVersion: 1 },
    });
    const learningMutation = await prisma!.knowledgeMutation.create({
      data: {
        companyId: company.id,
        resourceId: resource.id,
        kind: 'memory',
        scope: 'personal',
        targetKey: `personal:${user.id}`,
        ownerUserId: user.id,
        logicalKey: resource.logicalKey,
        action: 'create',
        proposedContentJson: { facts: ['must survive rollback'] },
        proposedContentHash: version.contentHash,
        sourceType: 'automatic_learning',
        sourceRef: `lark:rollback-run-${suffix}`,
        requesterId: user.id,
        requesterReviewRequired: false,
        requiredAuthority: 'none',
        distinctApprover: false,
        policyId: 'integration-automatic-learning',
        policyVersion: 1,
        appliedVersionId: version.id,
        status: 'applied',
        idempotencyKey: `rollback-learning-mutation-${suffix}`,
        decidedAt: new Date(),
        appliedAt: new Date(),
      },
    });
    const conversation = await prisma!.runtimeConversation.create({
      data: {
        companyId: company.id,
        channel: 'lark',
        channelConversationKey: `rollback-conversation-${suffix}`,
        rawChannelKey: `rollback-conversation-${suffix}`,
        summaryJson: { retained: true },
        lastMessageSequence: 1,
      },
    });
    const message = await prisma!.runtimeConversationMessage.create({
      data: {
        conversationId: conversation.id,
        sequence: 1,
        role: 'assistant',
        messageKind: 'text',
        sourceChannel: 'lark',
        sourceRunId: `rollback-run-${suffix}`,
        contentText: 'must survive rollback',
      },
    });
    const context = await prisma!.larkChatContext.create({
      data: {
        companyId: company.id,
        chatId: `rollback-context-${suffix}`,
        channel: 'lark',
        recentMessagesJson: [{ retained: true }],
        sourceMessageCount: 1,
      },
    });
    const privacy = new PrismaShopifyPrivacyRepository(prisma!, encryptionKey);
    const lifecycle = await privacy.create({
      companyId: company.id,
      shopDomain: domain,
      requestId: `rollback-lifecycle-${suffix}`,
      customerId: `rollback-customer-${suffix}`,
      orderIds: [],
      state: 'ready',
      exportPayload: { retained: true },
      deadlineAt: new Date(Date.now() + 30 * 86_400_000),
      expiresAt: new Date(Date.now() + 37 * 86_400_000),
    });
    assert.ok(lifecycle.ok);

    await prisma!.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF OLD."id" = '${connection.id}' THEN
          RAISE EXCEPTION 'forced late shop erasure failure';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma!.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE DELETE ON "IntegrationConnection"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);

    const webhookId = `rollback-shop-erase-${suffix}`;
    const result = await new ShopifyWebhookRepository(prisma!, privacy).process({
      webhookId,
      topic: 'shop/redact',
      shopDomain: domain,
      action: 'erase',
    });
    assert.equal(result.ok, false);
    assert.equal(await prisma!.integrationWebhookReceipt.findUnique({
      where: { provider_webhookId: { provider: 'shopify', webhookId } },
    }), null);
    assert.ok(await prisma!.integrationConnection.findUnique({ where: { id: connection.id } }));
    assert.ok(await prisma!.shopifyRunProvenance.findUnique({ where: { id: provenance.id } }));
    assert.ok(await prisma!.executionEvent.findUnique({ where: { id: event.id } }));
    assert.ok(await prisma!.knowledgeLearningJob.findUnique({ where: { id: learning.id } }));
    assert.equal((await prisma!.knowledgeResource.findUniqueOrThrow({ where: { id: resource.id } })).status, 'active');
    assert.ok(await prisma!.knowledgeVersion.findUnique({ where: { id: version.id } }));
    assert.ok(await prisma!.knowledgeMutation.findUnique({ where: { id: learningMutation.id } }));
    assert.equal(await prisma!.knowledgeMutation.count({
      where: { resourceId: resource.id, sourceType: 'shopify_privacy_erasure' },
    }), 0);
    assert.ok(await prisma!.runtimeConversationMessage.findUnique({ where: { id: message.id } }));
    assert.equal((await prisma!.runtimeConversation.findUniqueOrThrow({
      where: { id: conversation.id },
    })).historyRevision, 0);
    assert.notEqual((await prisma!.larkChatContext.findUniqueOrThrow({
      where: { id: context.id },
    })).recentMessagesJson, null);
    assert.equal((await prisma!.shopifyPrivacyRequest.findUniqueOrThrow({
      where: { id: lifecycle.value.request.id },
    })).state, 'ready');
  } finally {
    await prisma!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "IntegrationConnection"`).catch(() => undefined);
    await prisma!.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => undefined);
    await prisma!.company.delete({ where: { id: company.id } }).catch(() => undefined);
    await prisma!.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test('real Postgres: shop erasure fences concurrent automatic learning in both commit orders', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const company = await prisma!.company.create({ data: { name: `Learning fence ${suffix}` } });
  const user = await prisma!.user.create({
    data: { email: `learning-fence-${suffix}@example.test`, password: 'integration-only' },
  });
  const domain = `learning-fence-${suffix}.myshopify.com`;
  const sourceRunId = `learning-fence-run-${suffix}`;
  const sourceId = `lark:${sourceRunId}`;
  const workerPrisma = new PrismaClient();
  let releaseWorker!: () => void;
  let reportWorkerLocked!: () => void;
  const workerLocked = new Promise<void>(resolveLocked => { reportWorkerLocked = resolveLocked; });
  const workerRelease = new Promise<void>(resolveRelease => { releaseWorker = resolveRelease; });
  let policyId: string | null = null;
  try {
    await prisma!.adminMembership.create({
      data: { companyId: company.id, userId: user.id, role: 'MEMBER', isActive: true },
    });
    const policy = await prisma!.knowledgePolicy.create({
      data: {
        tenantKey: company.id,
        kind: 'memory',
        scope: 'personal',
        action: 'create',
        requesterReviewRequired: false,
        requiredAuthority: 'none',
        distinctApprover: false,
      },
    });
    policyId = policy.id;
    const connection = await prisma!.integrationConnection.create({
      data: {
        companyId: company.id,
        provider: 'shopify',
        ownerType: 'company',
        label: 'Learning fence shop',
        externalAccountId: domain,
        dedupeKey: `shopify:${domain}`,
        scopes: ['read_reports'],
      },
    });
    const execution = await prisma!.executionRun.create({
      data: {
        companyId: company.id,
        userId: user.id,
        requestId: sourceRunId,
        channel: 'lark',
        entrypoint: 'pi',
      },
    });
    await prisma!.shopifyRunProvenance.create({
      data: {
        companyId: company.id,
        executionRunId: execution.id,
        connectionId: connection.id,
        shopDomain: domain,
        toolId: 'shopifyAnalytics',
      },
    });
    const job = await prisma!.knowledgeLearningJob.create({
      data: {
        companyId: company.id,
        userId: user.id,
        sourceId,
        channel: 'lark',
        companyRole: 'MEMBER',
        userMessages: ['concurrent automatic learning'],
        status: 'processing',
      },
    });

    const worker = workerPrisma.$transaction(async tx => {
      await tx.$queryRaw`
        SELECT job."id"
        FROM "KnowledgeLearningJob" AS job
        WHERE job."id" = ${job.id}
        FOR UPDATE
      `;
      reportWorkerLocked();
      await workerRelease;
      const resource = await tx.knowledgeResource.create({
        data: {
          companyId: company.id,
          kind: 'memory',
          scope: 'personal',
          targetKey: `personal:${user.id}`,
          ownerUserId: user.id,
          logicalKey: `concurrent-derived-${suffix}`,
          status: 'active',
          createdById: user.id,
        },
      });
      const version = await tx.knowledgeVersion.create({
        data: {
          resourceId: resource.id,
          version: 1,
          contentJson: { facts: ['concurrent derived content'] },
          contentHash: createHash('sha256').update(`concurrent-version-${suffix}`).digest('hex'),
          sourceType: 'automatic_learning',
          sourceRef: sourceId,
          createdById: user.id,
        },
      });
      await tx.knowledgeResource.update({
        where: { id: resource.id },
        data: { currentVersion: 1 },
      });
      const mutation = await tx.knowledgeMutation.create({
        data: {
          companyId: company.id,
          resourceId: resource.id,
          kind: 'memory',
          scope: 'personal',
          targetKey: `personal:${user.id}`,
          ownerUserId: user.id,
          logicalKey: resource.logicalKey,
          action: 'create',
          proposedContentJson: { facts: ['concurrent derived content'] },
          proposedContentHash: version.contentHash,
          sourceType: 'automatic_learning',
          sourceRef: sourceId,
          requesterId: user.id,
          requesterReviewRequired: false,
          requiredAuthority: 'none',
          distinctApprover: false,
          policyId: policy.id,
          policyVersion: policy.version,
          appliedVersionId: version.id,
          status: 'applied',
          idempotencyKey: `concurrent-learning-${suffix}`,
          decidedAt: new Date(),
          appliedAt: new Date(),
        },
      });
      return { resourceId: resource.id, versionId: version.id, mutationId: mutation.id };
    }, { timeout: 20_000 });

    await workerLocked;
    const privacy = new PrismaShopifyPrivacyRepository(prisma!, encryptionKey);
    const erasure = new ShopifyWebhookRepository(prisma!, privacy).process({
      webhookId: `learning-fence-erase-${suffix}`,
      topic: 'shop/redact',
      shopDomain: domain,
      action: 'erase',
    });
    releaseWorker();
    const [workerResult, erased] = await Promise.all([worker, erasure]);
    assert.ok(erased.ok);
    assert.equal(await prisma!.knowledgeLearningJob.findUnique({ where: { id: job.id } }), null);
    assert.equal((await prisma!.knowledgeResource.findUniqueOrThrow({
      where: { id: workerResult.resourceId },
    })).status, 'deleted');
    assert.equal(await prisma!.knowledgeVersion.findUnique({ where: { id: workerResult.versionId } }), null);
    assert.equal(await prisma!.knowledgeMutation.findUnique({ where: { id: workerResult.mutationId } }), null);
    assert.ok(await prisma!.knowledgeOutbox.findFirst({
      where: {
        mutation: { resourceId: workerResult.resourceId, sourceType: 'shopify_privacy_erasure' },
        eventType: 'knowledge.resource.deleted',
      },
    }));

    const store = new PrismaKnowledgeMutationStore(prisma!, { requireThreatScan: false });
    await assert.rejects(
      store.createProposal({
        companyId: company.id,
        scope: 'personal',
        targetKey: `personal:${user.id}`,
        ownerUserId: user.id,
        departmentId: null,
        kind: 'memory',
        logicalKey: `post-erasure-${suffix}`,
        action: 'create',
        baseVersion: null,
        proposedContent: { facts: ['must not persist'] },
        proposedContentHash: createHash('sha256').update(`post-erasure-${suffix}`).digest('hex'),
        fileAssetId: null,
        evidence: { learningJobId: job.id },
        sourceType: 'automatic_learning',
        sourceRef: sourceId,
        requesterId: user.id,
        policy: {
          id: policy.id,
          tenantKey: company.id,
          kind: 'memory',
          scope: 'personal',
          action: 'create',
          requesterReviewRequired: false,
          requiredAuthority: 'none',
          distinctApprover: false,
          enabled: true,
          version: policy.version,
        },
        initialStatus: 'approved',
        idempotencyKey: `post-erasure-${suffix}`,
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && (error as { code: unknown }).code === 'invalid_state',
    );
    assert.equal(await prisma!.knowledgeMutation.count({
      where: { idempotencyKey: `post-erasure-${suffix}` },
    }), 0);
    let enqueued = 0;
    const learning = new KnowledgeLearningService({
      prisma: prisma!,
      queue: { enqueue: async () => { enqueued += 1; return 'unexpected'; } },
      extractor: {
        provider: 'test',
        modelId: 'test',
        extract: async () => ({ schemaVersion: 1, observations: [] }),
      },
      personalMemoryCommands: {} as never,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child() { return this; },
      },
      options: {
        immediateConfidence: 0.9,
        repeatedConfidence: 0.75,
        repeatedEvidenceCount: 3,
      },
    });
    await learning.captureCompletedTurn({
      sourceId,
      companyId: company.id,
      userId: user.id,
      companyRole: 'MEMBER',
      channel: 'lark',
      userMessages: ['must not recreate a post-erasure job'],
      assistantText: 'must not be learned',
    });
    assert.equal(enqueued, 0);
    assert.equal(await prisma!.knowledgeLearningJob.count({ where: { companyId: company.id, sourceId } }), 0);
  } finally {
    releaseWorker?.();
    await workerPrisma.$disconnect();
    if (policyId) await prisma!.knowledgePolicy.delete({ where: { id: policyId } }).catch(() => undefined);
    await prisma!.company.delete({ where: { id: company.id } }).catch(() => undefined);
    await prisma!.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test('real Postgres: one-time migration cleanup removes protected traces and derived learning only', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const user = await prisma!.user.create({
    data: { email: `privacy-cleanup-${suffix}@example.test`, password: 'integration-only' },
  });
  try {
    const department = await prisma!.department.create({
      data: { companyId, name: 'Privacy cleanup', slug: `privacy-cleanup-${suffix}` },
    });
    const execution = await prisma!.executionRun.create({
      data: {
        companyId,
        userId: user.id,
        channel: 'desktop',
        entrypoint: 'privacy-cleanup-test',
        threadId: `thread-${suffix}`,
        latestSummary: `protected summary ${suffix}`,
      },
    });
    const protectedEnvelope = {
      input: { payload: { toolId: 'shopifyCustomers', args: { customerId: `private-${suffix}` } } },
    };
    const safeEnvelope = { input: { payload: { toolId: 'shopifyAnalytics' } } };
    const protectedStep = await prisma!.stepResult.create({
      data: { executionId: execution.id, sequence: 1, toolName: 'divo', success: true, rawOutput: protectedEnvelope },
    });
    const safeStep = await prisma!.stepResult.create({
      data: { executionId: execution.id, sequence: 2, toolName: 'divo', success: true, rawOutput: safeEnvelope },
    });
    const protectedEvent = await prisma!.executionEvent.create({
      data: {
        executionId: execution.id,
        sequence: 1,
        phase: 'tool',
        eventType: 'tool_result',
        actorType: 'tool',
        title: 'Protected Shopify result',
        payload: protectedEnvelope,
      },
    });
    const safeEvent = await prisma!.executionEvent.create({
      data: {
        executionId: execution.id,
        sequence: 2,
        phase: 'tool',
        eventType: 'tool_result',
        actorType: 'tool',
        title: 'Shopify analytics',
        payload: safeEnvelope,
      },
    });
    const evidence = await prisma!.personaLearningEvidence.create({
      data: {
        companyId,
        managerId: user.id,
        departmentId: department.id,
        executionRunId: execution.id,
        threadId: `thread-${suffix}`,
        status: 'eligible',
        contextJson: { protected: true },
        toolSummaryJson: { toolId: 'shopifyCustomers' },
      },
    });
    const personaJob = await prisma!.personaLearningJob.create({
      data: { evidenceId: evidence.id, idempotencyKey: `privacy-cleanup-${suffix}` },
    });
    const candidate = await prisma!.personaLearningCandidate.create({
      data: {
        companyId,
        managerId: user.id,
        departmentId: department.id,
        evidenceId: evidence.id,
        jobId: personaJob.id,
        ordinal: 0,
        kind: 'preference',
        scopeKey: 'privacy-test',
        ruleKey: `privacy-test-${suffix}`,
        claim: 'protected',
        rationale: 'protected',
        evidenceStrength: 'explicit',
      },
    });
    const knowledgeJob = await prisma!.knowledgeLearningJob.create({
      data: {
        companyId,
        userId: user.id,
        sourceId: `desktop:${execution.id}`,
        channel: 'desktop',
        companyRole: 'MEMBER',
        userMessages: ['protected'],
      },
    });
    const conversation = await prisma!.runtimeConversation.create({
      data: {
        companyId,
        channel: 'lark',
        channelConversationKey: `privacy-cleanup-${suffix}`,
        rawChannelKey: `privacy-cleanup-${suffix}`,
        summaryJson: { protected: true },
        summaryUpdatedAt: new Date(),
        lastSummarizedSequence: 1,
      },
    });
    const run = await prisma!.runtimeRun.create({
      data: { conversationId: conversation.id, channel: 'lark', entrypoint: 'privacy-cleanup-test' },
    });
    await prisma!.runtimeConversationMessage.create({
      data: {
        conversationId: conversation.id,
        runId: run.id,
        sequence: 1,
        role: 'assistant',
        messageKind: 'final',
        sourceChannel: 'lark',
        contentText: `protected ${suffix}`,
      },
    });
    const approval = await prisma!.runtimeApproval.create({
      data: {
        conversationId: conversation.id,
        runId: run.id,
        toolId: 'shopifyOrders',
        actionGroup: 'read',
        kind: 'tool_action',
        summary: 'Protected order lookup',
        payloadJson: { private: suffix },
        channel: 'lark',
      },
    });
    const larkContext = await prisma!.larkChatContext.create({
      data: {
        companyId,
        chatId: `privacy-cleanup-room-${suffix}`,
        channel: 'lark',
        recentMessagesJson: [{ role: 'assistant', content: `protected ${suffix}` }],
        summaryJson: { protected: true },
        summaryUpdatedAt: new Date(),
        taskStateJson: { protected: true },
        taskStateUpdatedAt: new Date(),
        sourceMessageCount: 1,
        lastMessageAt: new Date(),
      },
    });

    const migration = readFileSync(resolve(
      process.cwd(),
      'prisma/migrations/20260803_shopify_privacy_lifecycle/migration.sql',
    ), 'utf8');
    const cleanup = migration
      .split('-- ONE-TIME SHOPIFY PROTECTED-DATA CLEANUP (begin)')[1]
      ?.split('-- ONE-TIME SHOPIFY PROTECTED-DATA CLEANUP (end)')[0];
    assert.ok(cleanup);
    const statements = cleanup.split(';').map(statement => statement.trim()).filter(Boolean);
    await prisma!.$transaction(async tx => {
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    });
    const contextMigration = readFileSync(resolve(
      process.cwd(),
      'prisma/migrations/20260803_shopify_protected_context_cleanup/migration.sql',
    ), 'utf8');
    const contextCleanup = contextMigration
      .split('-- ONE-TIME SHOPIFY LARK CONTEXT CLEANUP (begin)')[1]
      ?.split('-- ONE-TIME SHOPIFY LARK CONTEXT CLEANUP (end)')[0];
    assert.ok(contextCleanup);
    const contextStatements = contextCleanup.split(';')
      .map(statement => statement.trim())
      .filter(Boolean);
    await prisma!.$transaction(async tx => {
      for (const statement of contextStatements) await tx.$executeRawUnsafe(statement);
    });

    assert.equal(await prisma!.personaLearningEvidence.findUnique({ where: { id: evidence.id } }), null);
    assert.equal(await prisma!.personaLearningJob.findUnique({ where: { id: personaJob.id } }), null);
    assert.equal(await prisma!.personaLearningCandidate.findUnique({ where: { id: candidate.id } }), null);
    assert.equal(await prisma!.knowledgeLearningJob.findUnique({ where: { id: knowledgeJob.id } }), null);
    assert.equal(await prisma!.stepResult.findUnique({ where: { id: protectedStep.id } }), null);
    assert.ok(await prisma!.stepResult.findUnique({ where: { id: safeStep.id } }));
    assert.equal(await prisma!.executionEvent.findUnique({ where: { id: protectedEvent.id } }), null);
    assert.ok(await prisma!.executionEvent.findUnique({ where: { id: safeEvent.id } }));
    assert.equal((await prisma!.executionRun.findUniqueOrThrow({ where: { id: execution.id } })).latestSummary, null);
    assert.equal(await prisma!.runtimeConversationMessage.count({ where: { conversationId: conversation.id } }), 0);
    const clearedConversation = await prisma!.runtimeConversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(clearedConversation.summaryJson, null);
    assert.equal(clearedConversation.summaryUpdatedAt, null);
    assert.equal(clearedConversation.lastSummarizedSequence, 0);
    assert.equal(await prisma!.runtimeApproval.findUnique({ where: { id: approval.id } }), null);
    const clearedLarkContext = await prisma!.larkChatContext.findUniqueOrThrow({
      where: { id: larkContext.id },
    });
    assert.equal(clearedLarkContext.recentMessagesJson, null);
    assert.equal(clearedLarkContext.summaryJson, null);
    assert.equal(clearedLarkContext.taskStateJson, null);
    assert.equal(clearedLarkContext.sourceMessageCount, 0);
    assert.equal(clearedLarkContext.lastMessageAt, null);
  } finally {
    await prisma!.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});
