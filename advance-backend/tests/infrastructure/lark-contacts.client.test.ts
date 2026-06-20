import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LarkContactsClient } from '../../src/infrastructure/channels/lark/clients/lark-contacts.client.ts';
import { TOKEN_RESPONSE, buildMockFetch } from '../helpers/mock-fetch.ts';

const DEPS = { appId: 'app1', appSecret: 'secret1' };
const TOKEN_HANDLER = { match: (url: string) => url.includes('tenant_access_token'), response: TOKEN_RESPONSE };

describe('LarkContactsClient', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  describe('searchUsers', () => {
    it('POSTs to /contact/v3/users/search with query and filters', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, method) => method === 'POST' && url.includes('/contact/v3/users/search'),
          response: {
            code: 0,
            data: {
              users: [{
                open_id: 'ou_1',
                localized_name: 'Anish Suman',
                enterprise_email: 'anish@example.com',
                department: 'Engineering',
                p2p_chat_id: 'oc_p2p',
                is_activated: true,
                is_cross_tenant: false,
              }],
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkContactsClient(DEPS);
      const users = await client.searchUsers({
        query: 'anish',
        limit: 30,
        hasChatted: true,
        hasEnterpriseEmail: true,
        excludeExternalUsers: true,
      });

      assert.equal(users[0]?.openId, 'ou_1');
      assert.equal(users[0]?.displayName, 'Anish Suman');
      assert.equal(users[0]?.enterpriseEmail, 'anish@example.com');
      assert.equal(users[0]?.department, 'Engineering');
      assert.equal(users[0]?.p2pChatId, 'oc_p2p');

      const apiCall = calls.find(c => c.method === 'POST' && c.url.includes('/contact/v3/users/search'));
      assert.ok(apiCall?.url.includes('page_size=30'));
      assert.deepEqual(apiCall?.body, {
        query: 'anish',
        filter: {
          has_chatted: true,
          has_enterprise_email: true,
          exclude_external_users: true,
        },
      });
    });

    it('looks up known open_ids through the search filter', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, method) => method === 'POST' && url.includes('/contact/v3/users/search'),
          response: { code: 0, data: { users: [{ open_id: 'ou_known', localized_name: 'Known User' }] } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkContactsClient(DEPS);
      const users = await client.searchUsers({ userIds: ['ou_known'] });

      assert.equal(users[0]?.openId, 'ou_known');
      const apiCall = calls.find(c => c.method === 'POST' && c.url.includes('/contact/v3/users/search'));
      assert.deepEqual(apiCall?.body, { filter: { user_ids: ['ou_known'] } });
    });
  });
});
