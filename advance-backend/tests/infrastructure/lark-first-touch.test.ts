import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootstrapLarkFirstTouchIdentity } from '../../src/infrastructure/channels/lark/lark.webhook.routes.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function () { return this; },
} as any;

describe('Lark first-touch identity bootstrap', () => {
  it('binds an unknown verified sender only through the event tenant mapping', async () => {
    let upsertInput: any;
    const prisma = {
      larkTenantBinding: {
        findFirst: async (input: any) => {
          assert.deepEqual(input.where, { larkTenantKey: 'tenant-1', isActive: true });
          return { companyId: 'company-1' };
        },
      },
      channelIdentity: {
        upsert: async (input: any) => { upsertInput = input; return {}; },
      },
    };

    const result = await bootstrapLarkFirstTouchIdentity(
      'ou_1',
      { header: { tenant_key: 'tenant-1' } },
      {
        prisma: prisma as any,
        larkContactsClient: {
          getTenantKey: async () => 'tenant-1',
          getUser: async () => ({
            openId: 'ou_1', displayName: 'Abhishek Verma', email: 'abhishek@example.com',
          }),
        },
      },
      noopLogger,
    );

    assert.equal(result, true);
    assert.deepEqual(upsertInput.where, {
      channel_externalTenantId_externalUserId_companyId: {
        channel: 'lark',
        externalTenantId: 'tenant-1',
        externalUserId: 'ou_1',
        companyId: 'company-1',
      },
    });
    assert.equal(upsertInput.create.companyId, 'company-1');
    assert.equal(upsertInput.create.externalTenantId, 'tenant-1');
    assert.equal(upsertInput.create.larkOpenId, 'ou_1');
    assert.equal(upsertInput.create.aiRole, 'MEMBER');
    assert.equal(upsertInput.create.email, 'abhishek@example.com');
  });

  it('preserves separate identities when two company tenants reuse an open ID', async () => {
    const identities = new Map<string, unknown>();
    const prisma = {
      larkTenantBinding: {
        findFirst: async ({ where }: any) => ({ companyId: 'company-1', tenant: where.larkTenantKey }),
      },
      channelIdentity: {
        upsert: async (input: any) => {
          const key = input.where.channel_externalTenantId_externalUserId_companyId;
          identities.set(`${key.externalTenantId}:${key.externalUserId}:${key.companyId}`, input.create);
          return {};
        },
      },
    };
    const first = await bootstrapLarkFirstTouchIdentity(
      'ou_shared',
      { header: { tenant_key: 'tenant-1' } },
      {
        prisma: prisma as any,
        larkContactsClient: {
          getTenantKey: async () => 'tenant-1',
          getUser: async (openId: string) => ({ openId, displayName: 'Tenant 1 user' }),
        },
      },
      noopLogger,
    );
    const second = await bootstrapLarkFirstTouchIdentity(
      'ou_shared',
      { header: { tenant_key: 'tenant-2' } },
      {
        prisma: prisma as any,
        larkContactsClient: {
          getTenantKey: async () => 'tenant-2',
          getUser: async (openId: string) => ({ openId, displayName: 'Tenant 2 user' }),
        },
      },
      noopLogger,
    );

    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(identities.size, 2);
    assert.ok(identities.has('tenant-1:ou_shared:company-1'));
    assert.ok(identities.has('tenant-2:ou_shared:company-1'));
  });

  it('fails closed for an unbound tenant without calling the directory', async () => {
    let directoryCalled = false;
    const result = await bootstrapLarkFirstTouchIdentity(
      'ou_1',
      { header: { tenant_key: 'unknown-tenant' } },
      {
        prisma: {
          larkTenantBinding: { findFirst: async () => null },
        } as any,
        larkContactsClient: {
          getTenantKey: async () => 'unknown-tenant',
          getUser: async () => { directoryCalled = true; return null; },
        },
      },
      noopLogger,
    );

    assert.equal(result, false);
    assert.equal(directoryCalled, false);
  });

  it('rejects a directory response for a different open ID', async () => {
    let upsertCalled = false;
    const result = await bootstrapLarkFirstTouchIdentity(
      'ou_expected',
      { header: { tenant_key: 'tenant-1' } },
      {
        prisma: {
          larkTenantBinding: { findFirst: async () => ({ companyId: 'company-1' }) },
          channelIdentity: { upsert: async () => { upsertCalled = true; } },
        } as any,
        larkContactsClient: {
          getTenantKey: async () => 'tenant-1',
          getUser: async () => ({ openId: 'ou_other', displayName: 'Other' }),
        },
      },
      noopLogger,
    );

    assert.equal(result, false);
    assert.equal(upsertCalled, false);
  });
});
