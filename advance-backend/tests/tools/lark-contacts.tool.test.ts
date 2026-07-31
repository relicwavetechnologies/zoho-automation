import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLarkContactsTool } from '../../src/application/tools/families/lark-contacts.tool.ts';
import { makeCtx } from './tool-test.helpers.ts';

const ctx = makeCtx('larkContacts', ['read'], { userExternalId: 'ou_requester' });

describe('larkContacts tool enriched presentation', () => {
  it('enriches resolved and ambiguous candidates once, deduplicates them, and nests internal routing IDs', async () => {
    let requestedOpenIds: string[] = [];
    const tool = createLarkContactsTool({
      peopleResolver: {
        resolve: async () => ({
          resolved: [
            { openId: 'ou_1', displayName: 'Anish', email: 'synced@old.test' },
            { openId: 'ou_1', displayName: 'Anish duplicate' },
          ],
          ambiguous: [{
            query: 'Divya',
            matches: [
              { openId: 'ou_2', displayName: 'Divya Rao' },
              { openId: 'ou_2', displayName: 'Divya duplicate' },
            ],
          }],
          notFound: [],
        }),
      },
      contactsClient: {
        searchDepartments: async () => [],
        listDepartmentMembers: async () => [],
        getUsers: async openIds => {
          requestedOpenIds = openIds;
          return [
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
              departmentNames: ['Operations'],
              organization: 'Acme India',
            },
          ];
        },
      },
    });

    const result = await tool.execute({ op: 'lookup', queries: ['Anish', 'Divya'] }, ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(requestedOpenIds, ['ou_1', 'ou_2']);
    const data = (result as any).value.data;
    assert.equal(data.directoryEnrichment, 'complete');
    assert.deepEqual(data.found, [{
      displayName: 'Anish Shah',
      email: 'anish@acme.test',
      jobTitle: 'Finance Manager',
      departmentNames: ['Finance'],
      organization: 'Acme India',
      internalRouting: { provider: 'lark', openId: 'ou_1' },
    }]);
    assert.equal(data.found[0].openId, undefined);
    assert.deepEqual(data.ambiguous[0].matches, [{
      displayName: 'Divya Rao',
      departmentNames: ['Operations'],
      organization: 'Acme India',
      internalRouting: { provider: 'lark', openId: 'ou_2' },
    }]);
    assert.equal(
      (result as any).value.message,
      'Returned 1 resolved contact(s). 1 ambiguous query. 0 not found',
    );
  });

  it('preserves truthful synced identity fields when upstream enrichment is unavailable', async () => {
    const tool = createLarkContactsTool({
      peopleResolver: {
        resolve: async () => ({
          resolved: [{ openId: 'ou_1', displayName: 'Anish Shah', email: 'anish@acme.test' }],
          ambiguous: [],
          notFound: [],
        }),
      },
      contactsClient: {
        searchDepartments: async () => [],
        listDepartmentMembers: async () => [],
        getUsers: async () => { throw new Error('directory field permission unavailable'); },
      },
    });

    const result = await tool.execute({ op: 'lookup', query: 'Anish' }, ctx);

    assert.equal(result.ok, true);
    const data = (result as any).value.data;
    assert.equal(data.directoryEnrichment, 'unavailable');
    assert.deepEqual(data.found, [{
      displayName: 'Anish Shah',
      email: 'anish@acme.test',
      internalRouting: { provider: 'lark', openId: 'ou_1' },
    }]);
  });

  it('shapes department members with governed presentation fields and internal-only routing', async () => {
    const tool = createLarkContactsTool({
      peopleResolver: { resolve: async () => ({ resolved: [], ambiguous: [], notFound: [] }) },
      contactsClient: {
        searchDepartments: async () => [{ departmentId: 'od_finance', name: 'Finance' }],
        getUsers: async () => [],
        listDepartmentMembers: async () => [{
          openId: 'ou_1',
          displayName: 'Anish Shah',
          jobTitle: 'Manager',
          departmentNames: ['Finance'],
          organization: 'Acme India',
        }],
      },
    });

    const result = await tool.execute({ op: 'list_department', department: 'Finance' }, ctx);

    assert.equal(result.ok, true);
    assert.deepEqual((result as any).value.data.members, [{
      displayName: 'Anish Shah',
      jobTitle: 'Manager',
      departmentNames: ['Finance'],
      organization: 'Acme India',
      internalRouting: { provider: 'lark', openId: 'ou_1' },
    }]);
  });
});
