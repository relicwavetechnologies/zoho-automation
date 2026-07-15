import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@larksuiteoapi/node-sdk';
import { LarkApiError, LarkHttpClient } from '../../src/infrastructure/channels/lark/clients/lark-http.client.ts';

describe('LarkHttpClient SDK boundary', () => {
  it('delegates request shape to the official SDK and unwraps data', async () => {
    let request: unknown;
    let options: unknown;
    const sdkClient = {
      request: async (input: unknown, sdkOptions: unknown) => {
        request = input;
        options = sdkOptions;
        return { code: 0, data: { task_id: 'task-1' } };
      },
    } as unknown as Pick<Client, 'request'>;
    const client = new LarkHttpClient({ appId: 'app', appSecret: 'secret', sdkClient });

    const result = await client.request<{ task_id: string }>('POST', '/open-apis/task/v2/tasks', {
      query: { page_size: 10 },
      body: { summary: 'Prepare release' },
    });

    assert.deepEqual(request, {
      method: 'POST',
      url: '/open-apis/task/v2/tasks',
      params: { page_size: 10 },
      data: { summary: 'Prepare release' },
    });
    assert.equal(options, undefined, 'app-scoped calls let the SDK manage the tenant token');
    assert.deepEqual(result, { task_id: 'task-1' });
  });

  it('supplies a user-token SDK option only for a Divo-resolved OAuth connection', async () => {
    let options: unknown;
    const sdkClient = {
      request: async (_input: unknown, sdkOptions: unknown) => {
        options = sdkOptions;
        return { code: 0, data: {} };
      },
    } as unknown as Pick<Client, 'request'>;
    const client = new LarkHttpClient({
      appId: 'app',
      appSecret: 'secret',
      userToken: 'never-persisted-by-sdk',
      sdkClient,
    });

    await client.request('GET', '/open-apis/calendar/v4/calendars');

    assert.notEqual(options, undefined);
  });

  it('maps Lark API envelopes into a structured error', async () => {
    const sdkClient = {
      request: async () => ({ code: 99991663, msg: 'insufficient permissions' }),
    } as unknown as Pick<Client, 'request'>;
    const client = new LarkHttpClient({ appId: 'app', appSecret: 'secret', sdkClient });

    await assert.rejects(
      () => client.request('GET', '/open-apis/task/v2/tasks'),
      (error: unknown) => {
        assert.ok(error instanceof LarkApiError);
        assert.equal(error.code, 99991663);
        assert.equal(error.status, 200);
        assert.match(error.message, /insufficient permissions/);
        return true;
      },
    );
  });

  it('preserves SDK transport status and error code', async () => {
    const sdkClient = {
      request: async () => {
        throw {
          response: {
            status: 403,
            data: { code: 99991663, msg: 'permission denied' },
          },
        };
      },
    } as unknown as Pick<Client, 'request'>;
    const client = new LarkHttpClient({ appId: 'app', appSecret: 'secret', sdkClient });

    await assert.rejects(
      () => client.request('GET', '/open-apis/task/v2/tasks'),
      (error: unknown) => {
        assert.ok(error instanceof LarkApiError);
        assert.equal(error.status, 403);
        assert.equal(error.code, 99991663);
        assert.equal(error.message, 'permission denied');
        return true;
      },
    );
  });
});
