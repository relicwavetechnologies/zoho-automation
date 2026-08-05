import 'dotenv/config';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { loadAndValidateEnv } from '../../src/config/env.ts';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';
import { ZohoConnectionRepository } from '../../src/infrastructure/zoho/zoho-connection.repository.ts';
import { ZohoTokenService } from '../../src/infrastructure/zoho/zoho-token.service.ts';
import { IntegrationConnectionRepository } from '../../src/infrastructure/persistence/integration-connection.repository.ts';

const enabled = process.env['RUN_ZOHO_CONNECTED_E2E'] === '1';
const db = new PrismaClient();

const cache = {
  async get() { return { ok: true as const, value: null }; },
  async set() { return { ok: true as const, value: undefined }; },
  async setNx() { return { ok: true as const, value: true }; },
  async del() { return { ok: true as const, value: undefined }; },
  async scanDel() { return { ok: true as const, value: 0 }; },
};

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

after(async () => {
  await db.$disconnect();
});

test('real governed Zoho Books connections enforce grants, resolve encrypted OAuth, and retrieve bounded data', {
  skip: !enabled ? 'Set RUN_ZOHO_CONNECTED_E2E=1 with a reachable configured database.' : false,
  timeout: 90_000,
}, async () => {
  const env = loadAndValidateEnv(process.env);
  const rows = await db.integrationConnection.findMany({
    where: {
      provider: 'zoho',
      status: 'connected',
      revokedAt: null,
      scopes: { has: 'ZohoBooks.fullaccess.READ' },
    },
    select: {
      id: true,
      companyId: true,
      ownerUserId: true,
      grants: {
        where: { revokedAt: null, granteeType: 'user' },
        select: { granteeId: true },
        take: 1,
      },
    },
  });
  assert.ok(rows.length > 0, 'at least one connected Zoho Books account is required');

  const integrationConnections = new IntegrationConnectionRepository(db, env);
  const tokens = new ZohoTokenService(
    new ZohoConnectionRepository(db, env),
    cache,
    env,
    logger,
    integrationConnections,
  );
  const books = new ZohoBooksPaginatedClient(tokens, env.ZOHO_API_BASE_URL);

  for (const row of rows) {
    const userId = row.ownerUserId ?? row.grants[0]?.granteeId;
    assert.ok(userId, 'a connected Zoho account needs an owning or granted user');

    const denied = await integrationConnections.findAccessibleZohoConnection({
      companyId: row.companyId,
      userId: `unauthorized-e2e-${process.pid}`,
      connectionId: row.id,
      minimumAccess: 'read_only',
    });
    assert.ok(denied.ok);
    assert.equal(denied.value, null, 'an unrelated user must not receive decrypted credentials');

    const organizations = await books.listOrganizations(row.companyId, {
      userId,
      connectionId: row.id,
      minimumAccess: 'read_only',
      signal: AbortSignal.timeout(45_000),
    });
    assert.ok(organizations.length > 0, 'the connected token must expose at least one organization');

    const invoices = await books.listRecords({
      companyId: row.companyId,
      userId,
      connectionId: row.id,
      moduleName: 'invoices',
      organizationId: organizations[0]!.organizationId,
      page: 1,
      perPage: 5,
      signal: AbortSignal.timeout(45_000),
    });
    assert.ok(invoices.items.length <= 5, 'the live read must honor its result bound');
    assert.equal(invoices.organizationId, organizations[0]!.organizationId);
  }
});
