import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client as LarkSdkClient } from '@larksuiteoapi/node-sdk';
import { LARK_USER_OAUTH_SCOPES, LarkOAuthService } from '../../src/infrastructure/lark/lark-oauth.service';

const USER_INFO = {
  code: 0,
  data: {
    open_id: 'ou_123',
    user_id: 'u_123',
    name: 'Abhishek Verma',
    enterprise_email: 'vabhi.verma2678@gmail.com',
    en_name: 'Abhishek',
    tenant_key: 'tenant-1',
    avatar_url: 'https://example.com/avatar.png',
  },
};

function fakeSdk(overrides?: {
  userInfo?: { code: number; data: Record<string, string | undefined> };
  contactUser?: { code: number; data: { user: { enterprise_email?: string; email?: string } } };
}) {
  const calls: {
    exchange?: unknown;
    refresh?: unknown;
    userInfo?: unknown;
    contactUser?: { input: unknown; options: unknown };
  } = {};
  const client = {
    accessToken: {
      retrieveByAuthorizationCode: async (input: unknown) => {
        calls.exchange = input;
        return {
          accessToken: 'user-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
          expiresIn: 6900, refreshTokenExpiresIn: 2592000, scope: 'calendar:calendar',
        };
      },
      refresh: async (input: unknown) => {
        calls.refresh = input;
        return {
          accessToken: 'user-token-2', refreshToken: 'refresh-token-2', tokenType: 'Bearer',
          expiresIn: 6900, refreshTokenExpiresIn: 2592000, scope: 'calendar:calendar',
        };
      },
    },
    authen: {
      userInfo: {
        get: async (_input: unknown, options: unknown) => {
          calls.userInfo = options;
          return overrides?.userInfo ?? USER_INFO;
        },
      },
    },
    contact: {
      v3: {
        user: {
          get: async (input: unknown, options: unknown) => {
            calls.contactUser = { input, options };
            return overrides?.contactUser ?? { code: 0, data: { user: {} } };
          },
        },
      },
    },
  } as unknown as LarkSdkClient;
  return { client, calls };
}

describe('LarkOAuthService', () => {
  it('requests Divo’s explicit Lark user-consent scopes by default', () => {
    const { client } = fakeSdk();
    const service = new LarkOAuthService('cli_test', 'secret', 'https://example.com/callback', undefined, client);
    const url = new URL(service.getAuthorizeUrl('state-1'));

    assert.equal(url.origin, 'https://accounts.larksuite.com');
    assert.equal(url.pathname, '/open-apis/authen/v1/authorize');
    assert.equal(url.searchParams.get('client_id'), 'cli_test');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/callback');
    assert.equal(url.searchParams.get('state'), 'state-1');
    assert.deepEqual(LARK_USER_OAUTH_SCOPES, [
      'auth:user.id:read',
      'calendar:calendar.event:create',
      'calendar:calendar.event:delete',
      'calendar:calendar.event:read',
      'calendar:calendar.event:update',
      'calendar:calendar.free_busy:read',
      'calendar:calendar:read',
      'bitable:app',
      'contact:contact.base:readonly',
      'contact:user.base:readonly',
      'contact:user.email:readonly',
      'contact:user.employee:readonly',
      'contact:user:search',
      'docx:document',
      'drive:drive',
      'im:chat:read',
      'im:message',
      'im:message.group_msg:get_as_user',
      'im:message:get_as_user',
      'im:message.p2p_msg:get_as_user',
      'im:message.send_as_user',
      'im:message:readonly',
      'task:task:read',
      'task:task:write',
      'task:tasklist:read',
      'task:tasklist:write',
      'vc:meeting.search:read',
      'vc:meeting.meetingevent:read',
      'vc:record:readonly',
      'offline_access',
    ]);
    assert.equal(url.searchParams.get('scope'), LARK_USER_OAUTH_SCOPES.join(' '));
  });

  it('exchanges code through the SDK and enriches the Divo connection identity', async () => {
    const { client, calls } = fakeSdk();
    const service = new LarkOAuthService('cli_test', 'secret', 'https://example.com/callback', undefined, client);

    const tokens = await service.exchangeCode('auth-code');

    assert.deepEqual(calls.exchange, { code: 'auth-code', redirectUri: 'https://example.com/callback' });
    assert.notEqual(calls.userInfo, undefined, 'user info must be fetched with a user-token SDK option');
    assert.equal(tokens.accessToken, 'user-token');
    assert.equal(tokens.refreshToken, 'refresh-token');
    assert.equal(tokens.refreshTokenExpiresIn, 2592000);
    assert.equal(tokens.larkOpenId, 'ou_123');
    assert.equal(tokens.larkUserId, 'u_123');
    assert.equal(tokens.larkEmail, 'vabhi.verma2678@gmail.com');
    assert.equal(tokens.tenantKey, 'tenant-1');
    assert.equal(tokens.avatarUrl, 'https://example.com/avatar.png');
  });

  it('refreshes through the SDK before returning a replacement token set', async () => {
    const { client, calls } = fakeSdk();
    const service = new LarkOAuthService('cli_test', 'secret', 'https://example.com/callback', undefined, client);

    const refreshed = await service.refreshUserToken('refresh-token');

    assert.deepEqual(calls.refresh, { refreshToken: 'refresh-token' });
    assert.equal(refreshed.accessToken, 'user-token-2');
    assert.equal(refreshed.refreshToken, 'refresh-token-2');
  });

  it('falls back to the Contacts SDK endpoint when OAuth profile omits an email', async () => {
    const profileWithoutEmail = {
      ...USER_INFO,
      data: { ...USER_INFO.data, enterprise_email: undefined },
    };
    const { client, calls } = fakeSdk({
      userInfo: profileWithoutEmail,
      contactUser: { code: 0, data: { user: { enterprise_email: '', email: 'owner@example.com' } } },
    });
    const service = new LarkOAuthService('cli_test', 'secret', 'https://example.com/callback', undefined, client);

    const tokens = await service.exchangeCode('auth-code');

    assert.deepEqual(calls.contactUser?.input, {
      path: { user_id: 'ou_123' },
      params: { user_id_type: 'open_id' },
    });
    assert.notEqual(calls.contactUser?.options, undefined, 'Contacts fallback must use the delegated user token');
    assert.equal(tokens.larkEmail, 'owner@example.com');
  });

  it('uses email when Lark returns a blank enterprise_email field', async () => {
    const { client, calls } = fakeSdk({
      userInfo: {
        ...USER_INFO,
        data: {
          ...USER_INFO.data,
          enterprise_email: '',
          email: 'abhishek@emiactech.com',
        },
      },
    });
    const service = new LarkOAuthService('cli_test', 'secret', 'https://example.com/callback', undefined, client);

    const tokens = await service.exchangeCode('auth-code');

    assert.equal(tokens.larkEmail, 'abhishek@emiactech.com');
    assert.equal(calls.contactUser, undefined, 'Contacts fallback is unnecessary when OAuth profile has email');
  });

  it('maps an SDK user-info error before a connection can be persisted', async () => {
    const { client } = fakeSdk({ userInfo: { code: 99991663, data: USER_INFO.data } });
    const service = new LarkOAuthService('cli_test', 'secret', 'https://example.com/callback', undefined, client);

    await assert.rejects(() => service.exchangeCode('auth-code'), /Lark user info failed/);
  });
});
