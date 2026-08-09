import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AirtableContractBootstrapService,
  suggestedAirtableNativeTools,
} from '../../src/application/gateway/airtable-contract-bootstrap.service.ts';
import { CompositeWorkContractBootstrap } from '../../src/application/gateway/composite-contract-bootstrap.service.ts';
import type { WorkContractBootstrapPort } from '../../src/application/gateway/work-contract-bootstrap.port.ts';

const member = { companyId: 'company-1', userId: 'member-1' };

const connection = {
  connectionId: '5c1c6b1f-9c2c-4c7a-9d0e-6a2b7c8d9e01',
  provider: 'airtable' as const,
  label: 'MENHOOD Airtable',
  accountEmail: 'ops@example.com',
  ownerType: 'company' as const,
  ownerUserId: null,
  access: 'read_write' as const,
  scopes: [],
  connectedAt: new Date('2026-07-01T00:00:00.000Z'),
};

const LIST_RECORDS_SCHEMA = {
  type: 'object',
  properties: { filters: { type: 'object' } },
} as const;

function resolverReturning(describeTool: (name: string) => Promise<unknown>) {
  return async () => ({
    status: 'resolved' as const,
    connection: { connectionId: connection.connectionId, client: { describeTool, callTool: async () => null } },
  });
}

describe('Airtable work-contract bootstrap', () => {
  it('preloads the record read contracts without needing a read verb in the query', () => {
    // The live regression arrived as Hinglish with no read verb at all. A
    // keyword gate would have skipped the one schema the run actually needed.
    assert.deepEqual(
      suggestedAirtableNativeTools('menhood grooming trimmer 1.0 ki july month me kitni sale h', ['airtableRecords']),
      [
        { toolId: 'airtableRecords', nativeTool: 'search_bases' },
        { toolId: 'airtableRecords', nativeTool: 'list_tables_for_base' },
        { toolId: 'airtableRecords', nativeTool: 'get_table_schema' },
        { toolId: 'airtableRecords', nativeTool: 'list_records_for_table' },
      ],
    );
  });

  it('earns the search and write contracts from wording, and skips non-record tools', () => {
    const searched = suggestedAirtableNativeTools('search the CRM for matching leads', ['airtableBase']);
    assert.equal(searched.some(item => item.nativeTool === 'search_records'), true);
    assert.equal(searched.some(item => item.nativeTool === 'create_records_for_table'), false);

    const written = suggestedAirtableNativeTools('update the delivery status on those rows', ['airtableRecords']);
    assert.deepEqual(
      written.filter(item => item.nativeTool.endsWith('_records_for_table')).map(item => item.nativeTool),
      ['list_records_for_table', 'create_records_for_table', 'update_records_for_table'],
    );

    assert.deepEqual(suggestedAirtableNativeTools('add a field to the table', ['airtableSchema']), []);
    assert.deepEqual(suggestedAirtableNativeTools('count the July orders', ['googleSheets']), []);
  });

  it('returns the described schemas for a resolved connection', async () => {
    const service = new AirtableContractBootstrapService(resolverReturning(async (name) =>
      name === 'list_records_for_table'
        ? { name, description: 'List records', inputSchema: LIST_RECORDS_SCHEMA }
        : { name, inputSchema: { type: 'object' } }));

    const result = await service.load({
      member,
      query: 'how many July orders',
      toolIds: ['airtableRecords'],
      connections: [connection],
    });

    assert.deepEqual(result.unavailableNativeTools, []);
    const listRecords = result.contracts.find(contract => contract.nativeTool === 'list_records_for_table');
    assert.deepEqual(listRecords, {
      toolId: 'airtableRecords',
      nativeTool: 'list_records_for_table',
      description: 'List records',
      inputSchema: LIST_RECORDS_SCHEMA,
    });
  });

  it('reports operations as unavailable rather than inventing a schema', async () => {
    const noConnection = new AirtableContractBootstrapService(resolverReturning(async () => null));
    const withoutAccount = await noConnection.load({
      member,
      query: 'how many July orders',
      toolIds: ['airtableRecords'],
      connections: [],
    });
    assert.deepEqual(withoutAccount.contracts, []);
    assert.deepEqual(withoutAccount.unavailableNativeTools, [
      'search_bases',
      'list_tables_for_base',
      'get_table_schema',
      'list_records_for_table',
    ]);

    const failing = new AirtableContractBootstrapService(async () => {
      throw new Error('token refresh failed');
    });
    const unresolved = await failing.load({
      member,
      query: 'how many July orders',
      toolIds: ['airtableRecords'],
      connections: [connection],
    });
    assert.deepEqual(unresolved.contracts, []);
    assert.equal(unresolved.unavailableNativeTools.length, 4);
  });
});

describe('Composite work-contract bootstrap', () => {
  const google: WorkContractBootstrapPort = {
    load: async () => ({
      contracts: [{ toolId: 'googleSheets', nativeTool: 'read_sheet_values', inputSchema: {} }],
      unavailableNativeTools: ['create_spreadsheet'],
    }),
  };
  const airtable: WorkContractBootstrapPort = {
    load: async () => ({
      contracts: [{ toolId: 'airtableRecords', nativeTool: 'list_records_for_table', inputSchema: {} }],
      unavailableNativeTools: [],
    }),
  };

  it('merges every provider and de-duplicates repeated operations', async () => {
    const composite = new CompositeWorkContractBootstrap([google, airtable, airtable]);
    const result = await composite.load({
      member,
      query: 'copy the July Airtable orders into a sheet',
      toolIds: ['googleSheets', 'airtableRecords'],
      connections: [connection],
    });

    assert.deepEqual(result.contracts.map(contract => contract.nativeTool), [
      'read_sheet_values',
      'list_records_for_table',
    ]);
    assert.deepEqual(result.unavailableNativeTools, ['create_spreadsheet']);
  });

  it('keeps a healthy provider\'s contracts when another provider throws', async () => {
    const broken: WorkContractBootstrapPort = {
      load: async () => {
        throw new Error('schema catalogue unreachable');
      },
    };
    const composite = new CompositeWorkContractBootstrap([broken, airtable]);
    const result = await composite.load({
      member,
      query: 'how many July orders',
      toolIds: ['airtableRecords'],
      connections: [connection],
    });

    assert.deepEqual(result.contracts.map(contract => contract.nativeTool), ['list_records_for_table']);
  });

  it('propagates cancellation instead of silently returning nothing', async () => {
    const controller = new AbortController();
    const composite = new CompositeWorkContractBootstrap([{
      load: async () => {
        controller.abort();
        throw new Error('aborted mid-load');
      },
    }]);

    await assert.rejects(() => composite.load({
      member,
      query: 'how many July orders',
      toolIds: ['airtableRecords'],
      connections: [connection],
      abortSignal: controller.signal,
    }));
  });
});
