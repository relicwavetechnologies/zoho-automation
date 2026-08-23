import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AirtableMcpToolDescription } from '../../src/application/tools/families/airtable-mcp.tool.ts';
import {
  airtableNativeToolsForMode,
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
  access: 'read_write' as const,
  scopes: [],
  connectedAt: new Date('2026-07-01T00:00:00.000Z'),
};

const LIST_RECORDS_SCHEMA = {
  type: 'object',
  properties: {
    filters: { type: 'object' },
    pageSize: { type: 'number', maximum: 8_000 },
  },
} as const;

function resolverReturning(describeTool: (name: string) => Promise<AirtableMcpToolDescription | null>) {
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

  it('can select the complete provider-owned Airtable surface for one-time runtime preload', () => {
    const selected = airtableNativeToolsForMode('', ['airtableRecords'], 'complete');
    const nativeTools = selected.map(item => item.nativeTool);

    assert.ok(nativeTools.includes('search_bases'));
    assert.ok(nativeTools.includes('list_records_for_table'));
    assert.ok(nativeTools.includes('create_records_for_table'));
    assert.ok(nativeTools.includes('delete_records_for_table'));
    assert.equal(nativeTools.includes('list_fields_for_table'), false);
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
      description: 'List records Divo returns record values under records[].cellValuesByFieldId, the exact filtered count at metadata.totalRecordCount, and continuation at nextCursor when present. Direct calls are previews; use the same call through divo-local for protected file pages.',
      inputSchema: {
        ...LIST_RECORDS_SCHEMA,
        properties: {
          ...LIST_RECORDS_SCHEMA.properties,
          pageSize: { type: 'number', maximum: 200 },
        },
      },
    });
    assert.equal(LIST_RECORDS_SCHEMA.properties.pageSize.maximum, 8_000, 'provider schema is not mutated');
  });

  it('loads every selected product schema in complete mode without prompt wording', async () => {
    const described: string[] = [];
    const service = new AirtableContractBootstrapService(resolverReturning(async (name) => {
      described.push(name);
      return { name, inputSchema: { type: 'object' } };
    }));

    const result = await service.load({
      member,
      query: '',
      contractMode: 'complete',
      toolIds: ['airtableRecords'],
      connections: [connection],
    });

    assert.ok(described.includes('search_bases'));
    assert.ok(described.includes('list_records_for_table'));
    assert.ok(described.includes('create_records_for_table'));
    assert.ok(described.includes('delete_records_for_table'));
    assert.equal(described.includes('list_fields_for_table'), false);
    assert.equal(result.unavailableNativeTools.length, 0);
    assert.equal(result.contracts.length, described.length);
  });

  it('starts complete cache refresh without blocking speculative Pi preload', async () => {
    const waits: Array<boolean | undefined> = [];
    const service = new AirtableContractBootstrapService(async () => ({
      status: 'resolved' as const,
      connection: {
        client: {
          describeTool: async (
            _name: string,
            options?: { readonly waitForProvider?: boolean },
          ) => {
            waits.push(options?.waitForProvider);
            return null;
          },
          callTool: async () => null,
        },
      },
    }));

    const result = await service.load({
      member,
      query: '',
      contractMode: 'complete_cached',
      toolIds: ['airtableRecords'],
      connections: [connection],
    });

    assert.ok(waits.length > 1);
    assert.equal(waits.every(wait => wait === false), true);
    assert.equal(result.contracts.length, 0);
    assert.equal(result.unavailableNativeTools.length, waits.length);
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
