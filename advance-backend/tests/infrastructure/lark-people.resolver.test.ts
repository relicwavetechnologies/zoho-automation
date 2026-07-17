import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkPeopleResolver } from '../../src/infrastructure/channels/lark/lark-people.resolver.ts';

describe('LarkPeopleResolver directory deduplication', () => {
  it('collapses historical identities with the same open ID before ambiguity matching', async () => {
    let query: Record<string, unknown> | undefined;
    const resolver = new LarkPeopleResolver({
      channelIdentity: {
        findMany: async (input: Record<string, unknown>) => {
          query = input;
          return [
            { larkOpenId: 'ou_1', externalUserId: 'legacy-1', displayName: 'Anish Shah', email: null },
            { larkOpenId: 'ou_1', externalUserId: 'legacy-2', displayName: 'Anish Shah', email: 'anish@acme.test' },
          ];
        },
      },
    } as any);

    const result = await resolver.resolve('co-test', ['Anish Shah'], 'ou_requester');

    assert.deepEqual(query?.orderBy, { updatedAt: 'desc' });
    assert.deepEqual(result, {
      resolved: [{ openId: 'ou_1', displayName: 'Anish Shah', email: 'anish@acme.test' }],
      ambiguous: [],
      notFound: [],
    });
  });

  it('returns tied one-letter name corrections as ambiguous instead of guessing a person', async () => {
    const resolver = new LarkPeopleResolver({
      channelIdentity: {
        findMany: async () => [
          { larkOpenId: 'ou_1', externalUserId: '1', displayName: 'Dushyant Gandotra', email: 'one@acme.test' },
          { larkOpenId: 'ou_2', externalUserId: '2', displayName: 'Dushyant Singh', email: 'two@acme.test' },
          { larkOpenId: 'ou_3', externalUserId: '3', displayName: 'Manish Singh', email: 'three@acme.test' },
        ],
      },
    } as any);

    const result = await resolver.resolve('co-test', ['Dushayant'], 'ou_requester');

    assert.deepEqual(result, {
      resolved: [],
      ambiguous: [{
        query: 'Dushayant',
        matches: [
          { openId: 'ou_1', displayName: 'Dushyant Gandotra', email: 'one@acme.test' },
          { openId: 'ou_2', displayName: 'Dushyant Singh', email: 'two@acme.test' },
        ],
      }],
      notFound: [],
    });
  });

  it('does not treat a different leading character as a safe typo correction', async () => {
    const resolver = new LarkPeopleResolver({
      channelIdentity: {
        findMany: async () => [
          { larkOpenId: 'ou_1', externalUserId: '1', displayName: 'Manish Singh', email: null },
        ],
      },
    } as any);

    const result = await resolver.resolve('co-test', ['Anish'], 'ou_requester');

    assert.deepEqual(result, { resolved: [], ambiguous: [], notFound: ['Anish'] });
  });
});
