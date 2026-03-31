import assert from 'node:assert/strict';

import { cacheRedisConnection } from '../src/company/queue/runtime/redis.connection';
import { GoogleOAuthService } from '../src/company/channels/google/google-oauth.service';
import { LarkTenantTokenService } from '../src/company/channels/lark/lark-tenant-token.service';
import { ZohoTokenService } from '../src/company/integrations/zoho/zoho-token.service';
import { encryptZohoSecret } from '../src/company/integrations/zoho/zoho-token.crypto';
import { prisma } from '../src/utils/prisma';
import { redisTokenCache } from '../src/utils/redis-token-cache';

class MockRedisClient {
  store = new Map<string, { value: string; expiresAtMs: number | null }>();

  private read(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs !== null && Date.now() >= entry.expiresAtMs) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    return this.read(key);
  }

  async set(
    key: string,
    value: string,
    mode?: 'EX',
    ttl?: number,
    nx?: 'NX',
  ): Promise<'OK' | null> {
    if (nx === 'NX' && this.read(key) !== null) {
      return null;
    }
    const expiresAtMs = mode === 'EX' && typeof ttl === 'number' ? Date.now() + ttl * 1000 : null;
    this.store.set(key, { value, expiresAtMs });
    return 'OK';
  }
}

async function run(): Promise<void> {
  const mockRedis = new MockRedisClient();
  const originalGetClient = cacheRedisConnection.getClient.bind(cacheRedisConnection);
  const originalZohoConnection = (prisma as any).zohoConnection;
  const originalZohoProfile = (prisma as any).zohoConnectionProfile;

  (cacheRedisConnection as any).getClient = () => mockRedis as any;

  try {
    let prismaCalls = 0;
    (prisma as any).zohoConnection = {
      findUnique: async () => {
        prismaCalls += 1;
        return null;
      },
      update: async () => ({}),
    };
    (prisma as any).zohoConnectionProfile = {
      findFirst: async () => null,
    };

    await redisTokenCache.set('zoho:token:company-hit:prod', 'zoho-cache-hit', Date.now() + 3600_000);
    const zohoCacheHitService = new ZohoTokenService();
    const zohoHit = await zohoCacheHitService.getValidAccessToken('company-hit', 'prod');
    assert.equal(zohoHit, 'zoho-cache-hit');
    assert.equal(prismaCalls, 0);

    const encryptedToken = encryptZohoSecret('zoho-db-token');
    prismaCalls = 0;
    (prisma as any).zohoConnection = {
      findUnique: async () => {
        prismaCalls += 1;
        return {
          status: 'CONNECTED',
          providerMode: 'rest',
          accessTokenEncrypted: encryptedToken.cipherText,
          accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        };
      },
      update: async () => ({}),
    };
    const zohoCacheMissService = new ZohoTokenService();
    const zohoMiss = await zohoCacheMissService.getValidAccessToken('company-miss', 'prod');
    const zohoRedis = await redisTokenCache.get('zoho:token:company-miss:prod');
    assert.equal(zohoMiss, 'zoho-db-token');
    assert.equal(prismaCalls, 1);
    assert.equal(zohoRedis?.token, 'zoho-db-token');

    let larkFetchCount = 0;
    const lark1 = new LarkTenantTokenService({
      appId: 'app_shared',
      appSecret: 'secret',
      apiBaseUrl: 'https://lark.test',
      fetchImpl: async () => {
        larkFetchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          ok: true,
          json: async () => ({
            code: 0,
            tenant_access_token: 'lark-redis-token',
            expire: 3600,
          }),
        } as Response;
      },
    });
    const lark2 = new LarkTenantTokenService({
      appId: 'app_shared',
      appSecret: 'secret',
      apiBaseUrl: 'https://lark.test',
      fetchImpl: async () => {
        throw new Error('second service should not fetch');
      },
    });
    const [larkToken1, larkToken2] = await Promise.all([
      lark1.getAccessToken(),
      lark2.getAccessToken(),
    ]);
    assert.equal(larkToken1, 'lark-redis-token');
    assert.equal(larkToken2, 'lark-redis-token');
    assert.equal(larkFetchCount, 1);

    const googleService = new GoogleOAuthService();
    await redisTokenCache.set('google:token:company-google:user-google', 'google-cache-hit', Date.now() + 3600_000);
    let googleRefreshCalls = 0;
    const originalRefresh = googleService.refreshAccessToken.bind(googleService);
    (googleService as any).refreshAccessToken = async () => {
      googleRefreshCalls += 1;
      return {
        accessToken: 'google-refresh-token',
        expiresIn: 3600,
      };
    };
    const googleHit = await googleService.getValidAccessToken('company-google', 'user-google', 'refresh-token');
    assert.equal(googleHit, 'google-cache-hit');
    assert.equal(googleRefreshCalls, 0);

    const googleMiss = await googleService.getValidAccessToken('company-google-miss', 'user-google-miss', 'refresh-token');
    const googleRedis = await redisTokenCache.get('google:token:company-google-miss:user-google-miss');
    assert.equal(googleMiss, 'google-refresh-token');
    assert.equal(googleRefreshCalls, 1);
    assert.equal(googleRedis?.token, 'google-refresh-token');
    (googleService as any).refreshAccessToken = originalRefresh;

    console.log('auth-cache-harness-ok');
  } finally {
    (cacheRedisConnection as any).getClient = originalGetClient;
    (prisma as any).zohoConnection = originalZohoConnection;
    (prisma as any).zohoConnectionProfile = originalZohoProfile;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
