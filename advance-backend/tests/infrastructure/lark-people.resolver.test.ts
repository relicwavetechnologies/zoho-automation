import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LarkPeopleResolver } from '../../src/infrastructure/channels/lark/lark-people.resolver.ts';

function prismaWithDirectory(rows: unknown[]) {
  return {
    channelIdentity: {
      findMany: async () => rows,
    },
  } as any;
}

describe('LarkPeopleResolver', () => {
  it('uses DB fuzzy matching first', async () => {
    const resolver = new LarkPeopleResolver(prismaWithDirectory([
      { larkOpenId: 'ou_anish', displayName: 'Anish Suman', email: 'anish@example.com' },
    ]));

    const result = await resolver.resolve('co_1', ['anish'], 'ou_requester');

    assert.equal(result.resolved[0]?.openId, 'ou_anish');
    assert.deepEqual(result.notFound, []);
  });

  it('falls back to live Lark search when DB lookup misses', async () => {
    const resolver = new LarkPeopleResolver(prismaWithDirectory([]), {
      async searchUsers(companyId, requesterOpenId, query) {
        assert.equal(companyId, 'co_1');
        assert.equal(requesterOpenId, 'ou_requester');
        assert.equal(query, 'new person');
        return [{ openId: 'ou_new', displayName: 'New Person', enterpriseEmail: 'new@example.com' }];
      },
    });

    const result = await resolver.resolve('co_1', ['new person'], 'ou_requester');

    assert.equal(result.resolved[0]?.openId, 'ou_new');
    assert.equal(result.resolved[0]?.email, 'new@example.com');
    assert.deepEqual(result.notFound, []);
  });

  it('returns live search ambiguity without guessing', async () => {
    const resolver = new LarkPeopleResolver(prismaWithDirectory([]), {
      async searchUsers() {
        return [
          { openId: 'ou_1', displayName: 'Rahul Sharma', department: 'Sales' },
          { openId: 'ou_2', displayName: 'Rahul Singh', department: 'Finance' },
        ];
      },
    });

    const result = await resolver.resolve('co_1', ['rahul'], 'ou_requester');

    assert.equal(result.resolved.length, 0);
    assert.equal(result.ambiguous[0]?.matches.length, 2);
    assert.equal(result.ambiguous[0]?.matches[0]?.department, 'Sales');
  });
});
