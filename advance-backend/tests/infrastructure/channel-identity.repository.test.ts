import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelIdentityRepository } from '../../src/infrastructure/persistence/channel-identity.repository';

function makeDb(overrides: Record<string, unknown>) {
  return {
    channelIdentity: {
      findFirst: async () => null,
    },
    larkUserAuthLink: {
      findFirst: async () => null,
    },
    userDepartmentPreference: {
      findUnique: async () => null,
    },
    user: {
      findUnique: async () => null,
      create: async () => ({ id: 'created-user' }),
    },
    ...overrides,
  };
}

describe('ChannelIdentityRepository.prepareLarkLogin', () => {
  it('returns null for an unknown Lark identity', async () => {
    const repo = new ChannelIdentityRepository(makeDb({}) as any);

    const result = await repo.prepareLarkLogin('ou_missing');

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value : undefined, null);
  });

  it('returns missing_email when the synced Lark contact has no email', async () => {
    const repo = new ChannelIdentityRepository(makeDb({
      channelIdentity: {
        findFirst: async () => ({
          aiRole: 'MEMBER',
          companyId: 'company-1',
          displayName: 'No Email',
          email: null,
          larkOpenId: 'ou_1',
        }),
      },
    }) as any);

    const result = await repo.prepareLarkLogin('ou_1');

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : undefined, {
      status: 'missing_email',
      companyId: 'company-1',
      aiRole: 'MEMBER',
      larkOpenId: 'ou_1',
      displayName: 'No Email',
    });
  });

  it('uses an existing Divo user matched by normalized email', async () => {
    const repo = new ChannelIdentityRepository(makeDb({
      channelIdentity: {
        findFirst: async () => ({
          aiRole: 'COMPANY_ADMIN',
          companyId: 'company-1',
          displayName: 'Shivam Bhateja',
          email: 'Shivam@EmiacTech.com ',
          larkOpenId: 'ou_shivam',
        }),
      },
      user: {
        findUnique: async (input: any) => {
          assert.deepEqual(input.where, { email: 'shivam@emiactech.com' });
          return { id: 'user-1' };
        },
        create: async () => {
          throw new Error('should not create user');
        },
      },
    }) as any);

    const result = await repo.prepareLarkLogin('ou_shivam');

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : undefined, {
      status: 'ready',
      userId: 'user-1',
      companyId: 'company-1',
      aiRole: 'COMPANY_ADMIN',
      larkOpenId: 'ou_shivam',
      displayName: 'Shivam Bhateja',
      email: 'shivam@emiactech.com',
      createdUser: false,
    });
  });

  it('creates a placeholder Divo user for a known Lark contact without one', async () => {
    let createInput: any;
    const repo = new ChannelIdentityRepository(makeDb({
      channelIdentity: {
        findFirst: async () => ({
          aiRole: 'MEMBER',
          companyId: 'company-1',
          displayName: 'New User',
          email: 'new@example.com',
          larkOpenId: 'ou_new',
        }),
      },
      user: {
        findUnique: async () => null,
        create: async (input: any) => {
          createInput = input;
          return { id: 'created-user' };
        },
      },
    }) as any);

    const result = await repo.prepareLarkLogin('ou_new');

    assert.equal(result.ok, true);
    assert.equal(createInput.data.email, 'new@example.com');
    assert.equal(createInput.data.name, 'New User');
    assert.match(createInput.data.password, /^lark-oauth-pending:/);
    assert.deepEqual(result.ok ? result.value : undefined, {
      status: 'ready',
      userId: 'created-user',
      companyId: 'company-1',
      aiRole: 'MEMBER',
      larkOpenId: 'ou_new',
      displayName: 'New User',
      email: 'new@example.com',
      createdUser: true,
    });
  });
});
