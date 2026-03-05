const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/app';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173';
process.env.ZOHO_TOKEN_ENCRYPTION_KEY = process.env.ZOHO_TOKEN_ENCRYPTION_KEY || `base64:${Buffer.alloc(32, 9).toString('base64')}`;
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'client-secret';
process.env.ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI || 'http://localhost:5173/callback';

const { ZohoTokenService } = require('../dist/company/integrations/zoho/zoho-token.service');
const { ZohoIntegrationError } = require('../dist/company/integrations/zoho/zoho.errors');
const { encryptZohoSecret } = require('../dist/company/integrations/zoho/zoho-token.crypto');
const { prisma } = require('../dist/utils/prisma');

const withPatchedZohoConnection = async (patches, fn) => {
  const original = {
    findUnique: prisma.zohoConnection.findUnique,
    update: prisma.zohoConnection.update,
  };

  if (patches.findUnique) {
    prisma.zohoConnection.findUnique = patches.findUnique;
  }
  if (patches.update) {
    prisma.zohoConnection.update = patches.update;
  }

  try {
    await fn();
  } finally {
    prisma.zohoConnection.findUnique = original.findUnique;
    prisma.zohoConnection.update = original.update;
  }
};

test('ZohoTokenService.exchangeAuthorizationCode returns encrypted token state', async () => {
  const service = new ZohoTokenService({
    httpClient: {
      requestJson: async () => ({
        access_token: 'access-123',
        refresh_token: 'refresh-456',
        expires_in: 3600,
        refresh_token_expires_in: 7200,
        scope: 'ZohoCRM.modules.ALL,ZohoCRM.settings.ALL',
        api_domain: 'https://www.zohoapis.com',
        token_type: 'Bearer',
      }),
    },
    now: () => 1000,
  });

  const result = await service.exchangeAuthorizationCode({
    authorizationCode: 'code-123',
    scopes: ['ZohoCRM.modules.ALL'],
    environment: 'prod',
  });

  assert.ok(result.accessTokenEncrypted.startsWith('v1:'));
  assert.ok(result.refreshTokenEncrypted.startsWith('v1:'));
  assert.equal(result.tokenCipherVersion, 1);
  assert.equal(result.scopes.length, 2);
  assert.equal(result.accessTokenExpiresAt.toISOString(), new Date(1000 + 3600 * 1000).toISOString());
});

test('ZohoTokenService.getValidAccessToken returns decrypted non-expired token from storage', async () => {
  const encryptedAccess = encryptZohoSecret('plain-access-token');
  const futureExpiry = new Date(Date.now() + 60 * 60 * 1000);

  const service = new ZohoTokenService({
    httpClient: {
      requestJson: async () => {
        throw new Error('unexpected refresh');
      },
    },
  });

  await withPatchedZohoConnection(
    {
      findUnique: async () => ({
        id: 'conn-1',
        companyId: 'cmp-1',
        environment: 'prod',
        status: 'CONNECTED',
        scopes: [],
        connectedAt: new Date(),
        lastSyncAt: null,
        accessTokenEncrypted: encryptedAccess.cipherText,
        refreshTokenEncrypted: null,
        tokenCipherVersion: 1,
        accessTokenExpiresAt: futureExpiry,
        refreshTokenExpiresAt: null,
        tokenFailureCode: null,
        lastTokenRefreshAt: null,
        tokenMetadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      update: async () => {
        throw new Error('unexpected update');
      },
    },
    async () => {
      const token = await service.getValidAccessToken('cmp-1', 'prod');
      assert.equal(token, 'plain-access-token');
    },
  );
});

test('ZohoTokenService.forceRefresh refreshes token and updates persistence', async () => {
  const encryptedRefresh = encryptZohoSecret('refresh-token-1');
  const updates = [];

  const service = new ZohoTokenService({
    httpClient: {
      requestJson: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 1800,
        api_domain: 'https://www.zohoapis.com',
      }),
    },
    now: () => 1000,
  });

  await withPatchedZohoConnection(
    {
      findUnique: async () => ({
        id: 'conn-1',
        companyId: 'cmp-1',
        environment: 'prod',
        status: 'CONNECTED',
        scopes: ['ZohoCRM.modules.ALL'],
        connectedAt: new Date(),
        lastSyncAt: null,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: encryptedRefresh.cipherText,
        tokenCipherVersion: 1,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        tokenFailureCode: null,
        lastTokenRefreshAt: null,
        tokenMetadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      update: async (input) => {
        updates.push(input);
        return input;
      },
    },
    async () => {
      const token = await service.forceRefresh('cmp-1', 'prod');
      assert.equal(token, 'new-access-token');
      assert.equal(updates.length, 1);
      assert.ok(typeof updates[0].data.accessTokenEncrypted === 'string');
      assert.equal(updates[0].data.tokenFailureCode, null);
    },
  );
});

test('ZohoTokenService.exchangeAuthorizationCode surfaces auth_failed on missing access_token', async () => {
  const service = new ZohoTokenService({
    httpClient: {
      requestJson: async () => ({
        error: 'invalid_code',
        error_description: 'authorization code invalid',
      }),
    },
  });

  await assert.rejects(
    () =>
      service.exchangeAuthorizationCode({
        authorizationCode: 'bad-code',
        scopes: ['ZohoCRM.modules.ALL'],
        environment: 'prod',
      }),
    (error) => {
      assert.ok(error instanceof ZohoIntegrationError);
      assert.equal(error.code, 'auth_failed');
      return true;
    },
  );
});
