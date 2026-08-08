import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IntegrationConnectionRepository } from '../../src/infrastructure/persistence/integration-connection.repository';

const encryptionKey = 'shopify-repository-test-key';

describe('IntegrationConnectionRepository Shopify credentials', () => {
  it('encrypts the rotating token pair and atomically creates the owner grant', async () => {
    const fixture = makeFixture();
    const repository = new IntegrationConnectionRepository(fixture.db as never, {
      ZOHO_TOKEN_ENCRYPTION_KEY: encryptionKey,
    } as never);

    const saved = await repository.upsertShopifyConnection({
      companyId: 'company-1',
      ownerType: 'company',
      createdBy: 'user-1',
      shopDomain: 'Test-Store.myshopify.com',
      shopName: 'Test Store',
      shopGraphqlId: 'gid://shopify/Shop/1',
      accessToken: 'plain-access-token',
      refreshToken: 'plain-refresh-token',
      accessTokenExpiresAt: new Date('2026-08-02T13:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-11-02T12:00:00.000Z'),
      scopes: ['read_reports', 'read_orders'],
      apiVersion: '2026-07',
    });

    assert.ok(saved.ok);
    assert.equal(saved.value.accessToken, 'plain-access-token');
    assert.equal(saved.value.refreshToken, 'plain-refresh-token');
    assert.equal(saved.value.externalAccountId, 'test-store.myshopify.com');
    assert.notEqual(fixture.row?.accessTokenEncrypted, 'plain-access-token');
    assert.notEqual(fixture.row?.refreshTokenEncrypted, 'plain-refresh-token');
    assert.deepEqual(fixture.grant, {
      companyId: 'company-1',
      connectionId: 'connection-1',
      granteeType: 'user',
      granteeId: 'user-1',
      access: 'read_only',
      grantedBy: 'user-1',
    });
  });

  it('persists token rotation only for the expected version and never stores plaintext', async () => {
    const fixture = makeFixture();
    const repository = new IntegrationConnectionRepository(fixture.db as never, {
      ZOHO_TOKEN_ENCRYPTION_KEY: encryptionKey,
    } as never);

    const swapped = await repository.compareAndSwapShopifyTokens({
      companyId: 'company-1',
      connectionId: 'connection-1',
      expectedTokenVersion: 7,
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      accessTokenExpiresAt: new Date('2026-08-02T13:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-11-02T12:00:00.000Z'),
      scopes: ['read_reports'],
    });

    assert.ok(swapped.ok);
    assert.equal(swapped.value, true);
    assert.equal(fixture.updateMany?.where.tokenVersion, 7);
    assert.deepEqual(fixture.updateMany?.data.tokenVersion, { increment: 1 });
    assert.notEqual(fixture.updateMany?.data.accessTokenEncrypted, 'new-access');
    assert.notEqual(fixture.updateMany?.data.refreshTokenEncrypted, 'new-refresh');
  });

  it('encrypts Shopify client credentials for server-side token renewal', async () => {
    const fixture = makeFixture();
    const repository = new IntegrationConnectionRepository(fixture.db as never, {
      ZOHO_TOKEN_ENCRYPTION_KEY: encryptionKey,
    } as never);

    const saved = await repository.upsertShopifyConnection({
      companyId: 'company-1',
      ownerType: 'company',
      createdBy: 'user-1',
      shopDomain: 'test-store.myshopify.com',
      shopName: 'Test Store',
      shopGraphqlId: 'gid://shopify/Shop/1',
      accessToken: 'plain-access-token',
      accessTokenExpiresAt: new Date('2026-08-02T13:00:00.000Z'),
      scopes: ['read_reports'],
      apiVersion: '2026-07',
      clientCredentials: {
        clientId: 'client-id',
        clientSecret: 'plain-client-secret',
      },
    });

    assert.ok(saved.ok);
    assert.equal(saved.value.tokenType, 'client_credentials');
    assert.equal(saved.value.shopifyClientCredentials?.clientId, 'client-id');
    assert.equal(saved.value.shopifyClientCredentials?.clientSecret, 'plain-client-secret');
    assert.equal(fixture.row?.refreshTokenEncrypted, null);
    const metadata = fixture.row?.tokenMetadata as Record<string, any>;
    assert.equal(metadata.authMethod, 'client_credentials');
    assert.equal(metadata.shopifyClientCredentials.clientId, 'client-id');
    assert.notEqual(metadata.shopifyClientCredentials.clientSecretEncrypted, 'plain-client-secret');
  });

  it('rejects a malformed shop domain before any persistence call', async () => {
    const fixture = makeFixture();
    const repository = new IntegrationConnectionRepository(fixture.db as never, {
      ZOHO_TOKEN_ENCRYPTION_KEY: encryptionKey,
    } as never);

    const result = await repository.upsertShopifyConnection({
      companyId: 'company-1',
      ownerType: 'company',
      accessToken: 'access',
      scopes: ['read_reports'],
      apiVersion: '2026-07',
      shopDomain: 'https://evil.example',
    });

    assert.equal(result.ok, false);
    assert.equal(fixture.row, undefined);
  });
});

function makeFixture() {
  const fixture: {
    row?: Record<string, any>;
    grant?: Record<string, unknown>;
    updateMany?: { where: Record<string, any>; data: Record<string, any> };
    db?: unknown;
  } = {};
  const integrationConnection = {
    upsert: async ({ create }: { create: Record<string, any> }) => {
      fixture.row = {
        id: 'connection-1',
        ...create,
        tokenVersion: 0,
        connectedAt: create.connectedAt ?? new Date(),
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return fixture.row;
    },
    updateMany: async (input: { where: Record<string, any>; data: Record<string, any> }) => {
      fixture.updateMany = input;
      return { count: 1 };
    },
  };
  const tx = {
    integrationConnection,
    integrationConnectionGrant: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        fixture.grant = create;
        return create;
      },
    },
  };
  fixture.db = {
    integrationConnection,
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return fixture as typeof fixture & { db: NonNullable<typeof fixture.db> };
}
