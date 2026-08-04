import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { IntegrationConnectionRepository } from '../../src/infrastructure/persistence/integration-connection.repository';
import { AuditService } from '../../src/application/observability/audit.service';
import { IntegrationOAuthAttemptRepository } from '../../src/infrastructure/persistence/integration-oauth-attempt.repository';
import { ShopifyWebhookRepository } from '../../src/infrastructure/persistence/shopify-webhook.repository';
import { PrismaShopifyPrivacyRepository } from '../../src/infrastructure/persistence/shopify-privacy.repository';

const enabled = process.env['RUN_DATABASE_INTEGRATION'] === '1' && Boolean(process.env['DATABASE_URL']);
const prisma = enabled ? new PrismaClient() : null;
const suffix = randomUUID();
let companyId = '';
let ownerId = '';
let colleagueId = '';
let departmentId = '';

before(async () => {
  if (!prisma) return;
  const [owner, colleague] = await Promise.all([
    prisma.user.create({ data: { email: `shopify-owner-${suffix}@example.test`, password: 'integration-only' } }),
    prisma.user.create({ data: { email: `shopify-colleague-${suffix}@example.test`, password: 'integration-only' } }),
  ]);
  const company = await prisma.company.create({ data: { name: `Shopify integration ${suffix}` } });
  const department = await prisma.department.create({
    data: { companyId: company.id, name: 'Commerce', slug: `commerce-${suffix}` },
  });
  const role = await prisma.departmentRole.create({
    data: { departmentId: department.id, name: 'Analyst', slug: `analyst-${suffix}` },
  });
  await prisma.adminMembership.createMany({
    data: [owner.id, colleague.id].map(userId => ({ userId, companyId: company.id, role: 'MEMBER', isActive: true })),
  });
  await prisma.departmentMembership.create({
    data: { departmentId: department.id, userId: colleague.id, roleId: role.id, status: 'active' },
  });
  companyId = company.id;
  ownerId = owner.id;
  colleagueId = colleague.id;
  departmentId = department.id;
});

after(async () => {
  if (!prisma) return;
  if (companyId) await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, colleagueId].filter(Boolean) } } });
  await prisma.$disconnect();
});

test('real Postgres: encrypted Shopify connection, sharing isolation, token CAS, and required audit', {
  skip: !enabled ? 'Set RUN_DATABASE_INTEGRATION=1 with DATABASE_URL to run.' : false,
  timeout: 30_000,
}, async () => {
  const repository = new IntegrationConnectionRepository(prisma!, {
    ZOHO_TOKEN_ENCRYPTION_KEY: 'real-shopify-integration-key',
    INTEGRATION_TOKEN_ENCRYPTION_KEY: 'real-neutral-integration-key',
  } as never);
  const attempts = new IntegrationOAuthAttemptRepository(prisma!);
  await attempts.createShopify({
    state: `state-${suffix}`,
    companyId,
    userId: ownerId,
    shopDomain: 'integration-store.myshopify.com',
    requestedScopes: ['read_reports'],
    expiresAt: new Date(Date.now() + 60_000),
  });
  const [claimA, claimB] = await Promise.all([
    attempts.claimShopify({ state: `state-${suffix}` }),
    attempts.claimShopify({ state: `state-${suffix}` }),
  ]);
  assert.ok(claimA.ok && claimB.ok);
  assert.equal([claimA.value, claimB.value].filter(Boolean).length, 1);
  const claimedAttempt = claimA.value ?? claimB.value;
  assert.ok(claimedAttempt);
  const attemptRow = await prisma!.integrationOAuthAttempt.findFirstOrThrow({ where: { companyId } });
  assert.equal(attemptRow.status, 'exchanging');
  const created = await repository.upsertShopifyConnection({
    companyId,
    ownerType: 'company',
    createdBy: ownerId,
    shopDomain: 'integration-store.myshopify.com',
    shopName: 'Integration Store',
    shopGraphqlId: 'gid://shopify/Shop/1',
    accessToken: 'access-v1-secret',
    refreshToken: 'refresh-v1-secret',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    scopes: ['read_reports', 'read_orders', 'read_customers'],
    apiVersion: '2026-07',
    authorizationAttemptId: claimedAttempt.id,
  });
  assert.ok(created.ok);
  const completedAttempt = await prisma!.integrationOAuthAttempt.findUniqueOrThrow({ where: { id: claimedAttempt.id } });
  assert.equal(completedAttempt.status, 'completed');
  const connectionAudit = await prisma!.auditLog.findFirstOrThrow({
    where: { companyId, action: 'shopify.connection.created' },
  });
  assert.equal((connectionAudit.metadata as Record<string, unknown>)['connectionId'], created.value.id);
  assert.equal(JSON.stringify(connectionAudit.metadata).includes('integration-store.myshopify.com'), false);
  const ghost = await repository.upsertShopifyConnection({
    companyId,
    ownerType: 'company',
    createdBy: ownerId,
    shopDomain: 'ghost-store.myshopify.com',
    shopName: 'Ghost Store',
    accessToken: 'must-rollback',
    scopes: ['read_reports'],
    apiVersion: '2026-07',
    authorizationAttemptId: randomUUID(),
  });
  assert.equal(ghost.ok, false);
  assert.equal(await prisma!.integrationConnection.findFirst({
    where: { companyId, provider: 'shopify', externalAccountId: 'ghost-store.myshopify.com' },
  }), null);

  const raw = await prisma!.integrationConnection.findUniqueOrThrow({ where: { id: created.value.id } });
  assert.notEqual(raw.accessTokenEncrypted, 'access-v1-secret');
  assert.notEqual(raw.refreshTokenEncrypted, 'refresh-v1-secret');
  assert.equal(raw.tokenVersion, 0);

  const manageable = await repository.listManageableShopifyConnections({ companyId });
  assert.ok(manageable.ok);
  assert.deepEqual(manageable.value.map(connection => ({
    connectionId: connection.connectionId,
    shopDomain: connection.shopDomain,
    status: connection.status,
  })), [{
    connectionId: created.value.id,
    shopDomain: 'integration-store.myshopify.com',
    status: 'connected',
  }]);
  const crossCompanyReconnect = await repository.findShopifyConnectionForReconnect({
    companyId: randomUUID(),
    connectionId: created.value.id,
  });
  assert.ok(crossCompanyReconnect.ok);
  assert.equal(crossCompanyReconnect.value, null);

  const ownerConnections = await repository.listAccessibleShopifyConnections({ companyId, userId: ownerId });
  const isolatedConnections = await repository.listAccessibleShopifyConnections({ companyId, userId: colleagueId });
  assert.ok(ownerConnections.ok);
  assert.equal(ownerConnections.value.length, 1);
  assert.ok(isolatedConnections.ok);
  assert.equal(isolatedConnections.value.length, 0);

  const rejectedWriteGrant = await repository.grantConnection({
    companyId,
    connectionId: created.value.id,
    granteeType: 'department',
    granteeId: departmentId,
    access: 'read_write',
    grantedBy: ownerId,
  });
  assert.equal(rejectedWriteGrant.ok, false);
  const granted = await repository.grantConnection({
    companyId,
    connectionId: created.value.id,
    granteeType: 'department',
    granteeId: departmentId,
    access: 'read_only',
    grantedBy: ownerId,
  });
  assert.equal(granted.ok, true);
  const sharedConnections = await repository.listAccessibleShopifyConnections({ companyId, userId: colleagueId });
  assert.ok(sharedConnections.ok);
  assert.equal(sharedConnections.value[0]?.connectionId, created.value.id);
  assert.equal(sharedConnections.value[0]?.access, 'read_only');
  const departmentGrant = await prisma!.integrationConnectionGrant.findFirstOrThrow({
    where: { connectionId: created.value.id, granteeType: 'department', granteeId: departmentId, revokedAt: null },
  });
  const revokedGrant = await repository.revokeConnectionGrant({
    companyId, connectionId: created.value.id, grantId: departmentGrant.id, actorId: ownerId,
  });
  assert.ok(revokedGrant.ok);
  assert.equal((await repository.listAccessibleShopifyConnections({ companyId, userId: colleagueId })).value.length, 0);
  assert.ok(await prisma!.auditLog.findFirst({ where: { companyId, actorId: ownerId, action: 'connection.grant.revoked' } }));
  assert.ok((await repository.grantConnection({
    companyId,
    connectionId: created.value.id,
    granteeType: 'department',
    granteeId: departmentId,
    access: 'read_only',
    grantedBy: ownerId,
  })).ok);

  const rotation = {
    companyId,
    connectionId: created.value.id,
    expectedTokenVersion: 0,
    accessToken: 'access-v2-secret',
    refreshToken: 'refresh-v2-secret',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    scopes: ['read_reports', 'read_orders', 'read_customers'],
  };
  const [left, right] = await Promise.all([
    repository.compareAndSwapShopifyTokens(rotation),
    repository.compareAndSwapShopifyTokens(rotation),
  ]);
  assert.ok(left.ok && right.ok);
  assert.deepEqual([left.value, right.value].sort(), [false, true]);

  const rotated = await prisma!.integrationConnection.findUniqueOrThrow({ where: { id: created.value.id } });
  assert.equal(rotated.tokenVersion, 1);
  assert.notEqual(rotated.accessTokenEncrypted, 'access-v2-secret');
  assert.notEqual(rotated.refreshTokenEncrypted, 'refresh-v2-secret');

  const disconnected = await repository.revokeConnection({
    companyId, connectionId: created.value.id, provider: 'shopify', actorId: ownerId,
  });
  assert.ok(disconnected.ok);
  assert.equal(disconnected.value, true);
  assert.ok(await prisma!.auditLog.findFirst({ where: { companyId, actorId: ownerId, action: 'connection.disconnected' } }));
  const reconnected = await repository.upsertShopifyConnection({
    companyId,
    ownerType: 'company',
    createdBy: ownerId,
    shopDomain: 'integration-store.myshopify.com',
    shopName: 'Integration Store',
    shopGraphqlId: 'gid://shopify/Shop/1',
    accessToken: 'access-v3-secret',
    refreshToken: 'refresh-v3-secret',
    scopes: ['read_reports', 'read_orders', 'read_customers'],
    apiVersion: '2026-07',
  });
  assert.ok(reconnected.ok);

  const webhooks = new ShopifyWebhookRepository(
    prisma!,
    new PrismaShopifyPrivacyRepository(prisma!, 'real-shopify-privacy-key'),
  );
  const conversation = await prisma!.runtimeConversation.create({
    data: {
      companyId,
      channel: 'lark',
      channelConversationKey: `shopify-privacy-${suffix}`,
      rawChannelKey: `shopify-privacy-${suffix}`,
      summaryJson: { protected: true },
      summaryUpdatedAt: new Date(),
      lastSummarizedSequence: 1,
    },
  });
  const run = await prisma!.runtimeRun.create({
    data: { conversationId: conversation.id, channel: 'lark', entrypoint: 'integration-test' },
  });
  const customerApproval = await prisma!.runtimeApproval.create({
    data: {
      conversationId: conversation.id,
      runId: run.id,
      toolId: 'shopifyCustomers',
      actionGroup: 'read',
      kind: 'tool_action',
      summary: 'Customer lookup',
      payloadJson: {
        toolId: 'shopifyCustomers',
        action: 'read',
        args: { connectionId: created.value.id, operation: 'search_customers', search: { field: 'email', value: 'private@example.test' } },
      },
      executionResultJson: { data: [{ id: 'gid://shopify/Customer/1', tags: ['private'] }] },
      channel: 'lark',
    },
  });
  await prisma!.runtimeConversationMessage.create({
    data: {
      conversationId: conversation.id,
      runId: run.id,
      sequence: 1,
      role: 'assistant',
      messageKind: 'final',
      sourceChannel: 'lark',
      contentText: 'Protected Shopify customer response',
    },
  });
  const dataRequest = await webhooks.process({
    webhookId: `customer-data-request-${suffix}`,
    topic: 'customers/data_request',
    shopDomain: 'integration-store.myshopify.com',
    action: 'record_data_request',
    privacyRequest: { requestId: `request-${suffix}`, customerId: '1', orderIds: [] },
  });
  assert.ok(dataRequest.ok);
  const privacyLifecycle = await prisma!.shopifyPrivacyRequest.findFirst({
    where: { companyId, requestId: `request-${suffix}` },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(privacyLifecycle);
  assert.equal(privacyLifecycle.customerIdHash?.length, 64);
  assert.equal(JSON.stringify(privacyLifecycle).includes('"customerId":"1"'), false);
  assert.ok(await prisma!.runtimeApproval.findUnique({ where: { id: customerApproval.id } }));
  const customerPurged = await webhooks.process({
    webhookId: `customer-redact-${suffix}`,
    topic: 'customers/redact',
    shopDomain: 'integration-store.myshopify.com',
    action: 'purge_customer_traces',
    privacyRequest: { customerId: '1', orderIds: [] },
  });
  assert.ok(customerPurged.ok);
  assert.equal(await prisma!.runtimeApproval.findUnique({ where: { id: customerApproval.id } }), null);
  assert.equal(await prisma!.runtimeConversationMessage.count({ where: { conversationId: conversation.id } }), 0);
  assert.equal((await prisma!.runtimeConversation.findUniqueOrThrow({ where: { id: conversation.id } })).summaryJson, null);
  assert.equal((await prisma!.shopifyPrivacyRequest.findUniqueOrThrow({ where: { id: privacyLifecycle.id } })).state, 'redacted');

  const orderApproval = await prisma!.runtimeApproval.create({
    data: {
      conversationId: conversation.id,
      runId: run.id,
      toolId: 'shopifyOrders',
      actionGroup: 'read',
      kind: 'tool_action',
      summary: 'Order lookup',
      payloadJson: { toolId: 'shopifyOrders', action: 'read', args: { connectionId: created.value.id, operation: 'list_orders' } },
      executionResultJson: { data: [{ id: 'gid://shopify/Order/1' }] },
      channel: 'lark',
    },
  });
  const lifecycle = {
    webhookId: `uninstall-${suffix}`,
    topic: 'app/uninstalled',
    shopDomain: 'integration-store.myshopify.com',
    action: 'revoke',
  } as const;
  const processed = await webhooks.process(lifecycle);
  const duplicate = await webhooks.process(lifecycle);
  assert.ok(processed.ok && duplicate.ok);
  assert.equal(processed.value.duplicate, false);
  assert.equal(processed.value.affectedConnections, 1);
  assert.equal(duplicate.value.duplicate, true);
  const revoked = await prisma!.integrationConnection.findUniqueOrThrow({ where: { id: created.value.id } });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.accessTokenEncrypted, null);
  assert.equal(revoked.refreshTokenEncrypted, null);
  const revokedNotManageable = await repository.listManageableShopifyConnections({ companyId });
  assert.ok(revokedNotManageable.ok);
  assert.equal(revokedNotManageable.value.length, 0);

  const erased = await webhooks.process({
    webhookId: `redact-${suffix}`,
    topic: 'shop/redact',
    shopDomain: 'integration-store.myshopify.com',
    action: 'erase',
  });
  assert.ok(erased.ok);
  assert.equal(erased.value.affectedConnections, 1);
  assert.equal(await prisma!.integrationConnection.findUnique({ where: { id: created.value.id } }), null);
  assert.equal(await prisma!.runtimeApproval.findUnique({ where: { id: orderApproval.id } }), null);

  const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never;
  const audit = new AuditService(prisma!, logger);
  await audit.recordRequired({
    actorId: colleagueId,
    companyId,
    action: 'shopify.shopifyCustomers.read',
    outcome: 'success',
    metadata: { connectionId: created.value.id, accessToken: 'must-not-persist', operation: 'count_customers' },
  });
  const auditRow = await prisma!.auditLog.findFirstOrThrow({
    where: { companyId, actorId: colleagueId, action: 'shopify.shopifyCustomers.read' },
    orderBy: { createdAt: 'desc' },
  });
  assert.deepEqual(auditRow.metadata, {
    connectionId: created.value.id,
    accessToken: '[REDACTED]',
    operation: 'count_customers',
  });
});
