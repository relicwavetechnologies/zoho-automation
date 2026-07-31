import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@larksuiteoapi/node-sdk';
import { LarkContactsClient } from '../../src/infrastructure/channels/lark/clients/lark-contacts.client.ts';

type SdkRequest = {
  method: string;
  url: string;
  params?: Record<string, unknown>;
  paramsSerializer?: (params: Record<string, unknown>) => string;
};

function makeClient(request: (input: SdkRequest) => Promise<unknown>) {
  return new LarkContactsClient({
    appId: 'app',
    appSecret: 'secret',
    sdkClient: { request } as unknown as Pick<Client, 'request'>,
  });
}

describe('LarkContactsClient directory enrichment', () => {
  it('batch-loads users and departments, deduplicates IDs, and caches truthful tenant organization', async () => {
    const requests: SdkRequest[] = [];
    const client = makeClient(async input => {
      requests.push(input);
      if (input.url.endsWith('/users/batch')) {
        return {
          code: 0,
          data: {
            items: [
              {
                open_id: 'ou_1',
                name: 'Anish Shah',
                email: 'old@example.com',
                enterprise_email: 'anish@acme.test',
                job_title: 'Finance Manager',
                department_ids: ['od_finance'],
              },
              {
                open_id: 'ou_2',
                name: 'Divya Rao',
                department_ids: ['od_finance', 'od_ops'],
              },
            ],
          },
        };
      }
      if (input.url.endsWith('/departments/batch')) {
        return {
          code: 0,
          data: {
            items: [
              { open_department_id: 'od_finance', name: 'Finance' },
              { open_department_id: 'od_ops', name: 'Operations' },
            ],
          },
        };
      }
      if (input.url.endsWith('/tenant/query')) {
        return { code: 0, data: { tenant: { name: 'Acme India' } } };
      }
      throw new Error(`unexpected request: ${input.url}`);
    });

    const first = await client.getUsers(['ou_1', 'ou_1', 'ou_2']);
    const second = await client.getUsers(['ou_2']);

    assert.deepEqual(first, [
      {
        openId: 'ou_1',
        displayName: 'Anish Shah',
        email: 'anish@acme.test',
        jobTitle: 'Finance Manager',
        departmentNames: ['Finance'],
        organization: 'Acme India',
      },
      {
        openId: 'ou_2',
        displayName: 'Divya Rao',
        departmentNames: ['Finance', 'Operations'],
        organization: 'Acme India',
      },
    ]);
    assert.equal(second[0]?.organization, 'Acme India');

    const userRequests = requests.filter(request => request.url.endsWith('/users/batch'));
    assert.deepEqual(userRequests[0]?.params?.user_ids, ['ou_1', 'ou_2']);
    assert.equal(
      userRequests[0]?.paramsSerializer?.(userRequests[0].params ?? {}),
      'user_ids=ou_1&user_ids=ou_2&user_id_type=open_id&department_id_type=open_department_id',
    );
    assert.equal(requests.filter(request => request.url.endsWith('/tenant/query')).length, 1);
  });

  it('omits organization and falls back to user-provided department paths when optional APIs are unavailable', async () => {
    const client = makeClient(async input => {
      if (input.url.endsWith('/users/batch')) {
        return {
          code: 0,
          data: {
            items: [{
              open_id: 'ou_1',
              name: 'Anish Shah',
              department_ids: ['od_finance'],
              department_path: [{ department_name: { name: 'Finance' } }],
            }],
          },
        };
      }
      return { code: 99991663, msg: 'field not visible' };
    });

    const people = await client.getUsers(['ou_1']);

    assert.deepEqual(people, [{
      openId: 'ou_1',
      displayName: 'Anish Shah',
      departmentNames: ['Finance'],
    }]);
    assert.equal(people[0]?.organization, undefined);
  });

  it('enriches department-list members without paging beyond the requested limit', async () => {
    let listCalls = 0;
    const client = makeClient(async input => {
      if (input.url.endsWith('/contact/v3/users')) {
        listCalls += 1;
        return {
          code: 0,
          data: {
            items: [{ open_id: 'ou_1', name: 'Anish Shah', job_title: 'Manager' }],
            has_more: true,
            page_token: 'next',
          },
        };
      }
      if (input.url.endsWith('/tenant/query')) {
        return { code: 0, data: { tenant: { name: 'Acme India' } } };
      }
      throw new Error(`unexpected request: ${input.url}`);
    });

    const people = await client.listDepartmentMembers('od_finance', 1);

    assert.equal(listCalls, 1);
    assert.deepEqual(people, [{
      openId: 'ou_1',
      displayName: 'Anish Shah',
      jobTitle: 'Manager',
      organization: 'Acme India',
    }]);
  });
});
