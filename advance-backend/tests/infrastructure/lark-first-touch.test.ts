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
          getUser: async () => ({
            openId: 'ou_1', displayName: 'Abhishek Verma', email: 'abhishek@example.com',
          }),
        },
      },
      noopLogger,
    );

    assert.equal(result, true);
    assert.equal(upsertInput.create.companyId, 'company-1');
    assert.equal(upsertInput.create.externalTenantId, 'tenant-1');
    assert.equal(upsertInput.create.larkOpenId, 'ou_1');
    assert.equal(upsertInput.create.aiRole, 'MEMBER');
    assert.equal(upsertInput.create.email, 'abhishek@example.com');
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
          getUser: async () => ({ openId: 'ou_other', displayName: 'Other' }),
        },
      },
      noopLogger,
    );

    assert.equal(result, false);
    assert.equal(upsertCalled, false);
  });
});
