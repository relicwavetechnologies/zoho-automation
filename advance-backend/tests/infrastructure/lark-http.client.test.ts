import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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

  it('serializes array query params in the repeated-key format required by Lark batch APIs', async () => {
    let request: any;
    const sdkClient = {
      request: async (input: unknown) => {
        request = input;
        return { code: 0, data: {} };
      },
    } as unknown as Pick<Client, 'request'>;
    const client = new LarkHttpClient({ appId: 'app', appSecret: 'secret', sdkClient });

    await client.request('GET', '/open-apis/contact/v3/users/batch', {
      query: { user_ids: ['ou_1', 'ou_2'], user_id_type: 'open_id' },
    });

    assert.equal(
      request.paramsSerializer(request.params),
      'user_ids=ou_1&user_ids=ou_2&user_id_type=open_id',
    );
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

  it('does not let SDK transport failures print OAuth credentials', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 99991663, msg: 'permission denied' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const calls: unknown[][] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => { calls.push(args); };
    console.warn = (...args: unknown[]) => { calls.push(args); };
    console.error = (...args: unknown[]) => { calls.push(args); };

    try {
      const client = new LarkHttpClient({
        appId: 'app',
        appSecret: 'secret',
        userToken: 'sensitive-user-access-token',
        apiBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      await assert.rejects(
        () => client.request('GET', '/open-apis/calendar/v4/calendars/primary/events'),
        LarkApiError,
      );
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }

    assert.deepEqual(calls, []);
  });
});
