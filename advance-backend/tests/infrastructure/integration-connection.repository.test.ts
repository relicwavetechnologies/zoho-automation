import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IntegrationConnectionRepository } from '../../src/infrastructure/persistence/integration-connection.repository.ts';

const now = new Date();

function makeConnection(id: string, dedupeKey: string, tenantKey: string) {
  return {
    id,
    companyId: 'company-1',
    provider: 'lark',
    ownerType: 'user',
    ownerUserId: 'user-1',
    label: 'Lark connection',
    accountEmail: 'user@example.com',
    accountName: 'User',
    externalAccountId: 'ou_same',
    dedupeKey,
    status: 'connected',
    scopes: [],
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    tokenType: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    tokenMetadata: { larkOpenId: 'ou_same', larkTenantKey: tenantKey },
    connectedAt: now,
    lastUsedAt: null,
    revokedAt: null,
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
  };
}

function makeDb() {
  const rows: any[] = [];
  const tx = {
    larkTenantBinding: {
      findFirst: async ({ where }: any) => where.isActive
        ? { id: `binding-${where.larkTenantKey}` }
        : null,
    },
    channelIdentity: {
      findFirst: async ({ where }: any) => ({
        id: `identity-${where.externalTenantId}`,
      }),
    },
    adminMembership: {
      findFirst: async () => ({ id: 'membership-1' }),
    },
    integrationConnection: {
      findUnique: async ({ where }: any) => rows.find(
        row => row.companyId === where.companyId_dedupeKey.companyId
          && row.dedupeKey === where.companyId_dedupeKey.dedupeKey,
      ) ?? null,
      findFirst: async ({ where }: any) => rows.find(
        row => row.companyId === where.companyId
          && row.externalAccountId === where.externalAccountId
          && row.tokenMetadata.larkTenantKey === where.tokenMetadata.equals,
      ) ?? null,
      create: async ({ data }: any) => {
        const row = makeConnection(`connection-${rows.length + 1}`, data.dedupeKey, data.tokenMetadata.larkTenantKey);
        Object.assign(row, data);
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find(candidate => candidate.id === where.id);
        assert.ok(row);
        Object.assign(row, data);
        return row;
      },
    },
    integrationConnectionGrant: {
      upsert: async () => ({}),
    },
  };
  return {
    rows,
    db: {
      ...tx,
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
}

describe('IntegrationConnectionRepository.upsertLarkConnection', () => {
  it('keeps identical open IDs isolated by tenant and upgrades legacy rows in place', async () => {
    const fixture = makeDb();
    fixture.rows.push(makeConnection('legacy-1', 'lark:user:user-1:ou_same', 'tenant-1'));
    const repo = new IntegrationConnectionRepository(fixture.db as any, {
      ZOHO_TOKEN_ENCRYPTION_KEY: 'test-key',
    } as any);
    const base = {
      companyId: 'company-1',
      ownerType: 'user' as const,
      ownerUserId: 'user-1',
      createdBy: 'user-1',
      larkOpenId: 'ou_same',
      larkEmail: 'user@example.com',
      larkName: 'User',
      accessToken: 'token',
      scopes: [],
    };

    const first = await repo.upsertLarkConnection({ ...base, larkTenantKey: 'tenant-1' });
    const second = await repo.upsertLarkConnection({ ...base, larkTenantKey: 'tenant-2' });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(fixture.rows.length, 2);
    assert.equal(fixture.rows[0].id, 'legacy-1');
    assert.notEqual(fixture.rows[0].dedupeKey, fixture.rows[1].dedupeKey);
    assert.deepEqual(
      fixture.rows.map(row => row.tokenMetadata.larkTenantKey).sort(),
      ['tenant-1', 'tenant-2'],
    );
  });

  it('fails before persistence when the active tenant binding disappears', async () => {
    const fixture = makeDb();
    fixture.db.larkTenantBinding.findFirst = async () => null;
    const repo = new IntegrationConnectionRepository(fixture.db as any, {
      ZOHO_TOKEN_ENCRYPTION_KEY: 'test-key',
    } as any);

    const result = await repo.upsertLarkConnection({
      companyId: 'company-1',
      ownerType: 'user',
      ownerUserId: 'user-1',
      createdBy: 'user-1',
      larkOpenId: 'ou_same',
      larkTenantKey: 'tenant-1',
      accessToken: 'token',
      scopes: [],
    });

    assert.equal(result.ok, false);
    assert.equal(fixture.rows.length, 0);
  });
});

describe('IntegrationConnectionRepository.findCompanyGoogleExportConnection', () => {
  it('queries only a connected company-owned Google connection', async () => {
    let where: unknown;
    const repo = new IntegrationConnectionRepository({
      integrationConnection: {
        findFirst: async (input: { where: unknown }) => {
          where = input.where;
          return null;
        },
      },
    } as any, {
      ZOHO_TOKEN_ENCRYPTION_KEY: 'test-key',
    } as any);

    const result = await repo.findCompanyGoogleExportConnection({
      companyId: 'company-1',
      connectionId: 'connection-1',
    });

    assert.deepEqual(result, { ok: true, value: null });
    assert.deepEqual(where, {
      id: 'connection-1',
      companyId: 'company-1',
      provider: 'google_workspace',
      ownerType: 'company',
      revokedAt: null,
      status: 'connected',
    });
  });
});

describe('IntegrationConnectionRepository.findLarkConnectionOwner', () => {
  it('scopes an owner lookup by Lark tenant when open IDs are identical', async () => {
    const fixture = makeDb();
    const first = makeConnection('connection-1', 'lark:user:user-1:ou_same', 'tenant-1');
    const second = makeConnection('connection-2', 'lark:user:user-2:ou_same', 'tenant-2');
    first.ownerUserId = 'user-1';
    second.ownerUserId = 'user-2';
    fixture.rows.push(first, second);
    const repo = new IntegrationConnectionRepository(fixture.db as any, {
      ZOHO_TOKEN_ENCRYPTION_KEY: 'test-key',
    } as any);

    const result = await repo.findLarkConnectionOwner({
      companyId: 'company-1',
      larkOpenId: 'ou_same',
      larkTenantKey: 'tenant-2',
    });

    assert.deepEqual(result, { ok: true, value: { userId: 'user-2' } });
  });
});
