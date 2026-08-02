import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleZohoList } from '../../src/application/zoho/zoho-list-handler.ts';

describe('handleZohoList', () => {
  it('reads one bounded page and points overflow to the governed export pipeline', async () => {
    let listAllCalled = false;
    const result = await handleZohoList({
      companyId: 'co-1',
      userId: 'user-1',
      connectionId: '11111111-1111-4111-8111-111111111111',
      moduleName: 'invoices',
      moduleLabel: 'invoices',
      inlineThreshold: 2,
      summarize: (items) => `${items.length} invoices shown.`,
      booksClient: {
        listRecords: async () => ({
          organizationId: 'org-1',
          items: [{ id: '1' }, { id: '2' }, { id: '3' }],
          hasMore: true,
          page: 1,
        }),
        listAllRecords: async () => {
          listAllCalled = true;
          throw new Error('must not exhaust inside the interactive tool');
        },
      } as any,
    });
    assert.deepEqual(result.items, [{ id: '1' }, { id: '2' }]);
    assert.equal(result.suggestExport, true);
    assert.equal(result.truncated, true);
    assert.equal(result.hasMore, true);
    assert.equal(result.totalCount, undefined);
    assert.match(result.summary, /prepare the remaining data as an export/i);
    assert.deepEqual(result.coverage, {
      kind: 'truncated',
      returnedRows: 2,
      reason: 'source_has_more',
    });
    assert.equal(listAllCalled, false);
  });

  it('does not suggest an export when the bounded result fits inline', async () => {
    const result = await handleZohoList({
      companyId: 'co-1',
      moduleName: 'bills',
      moduleLabel: 'bills',
      summarize: (items) => `${items.length} bills.`,
      booksClient: {
        listRecords: async () => ({
          organizationId: 'org-1',
          items: [{ id: '1' }],
          hasMore: false,
          page: 1,
        }),
      } as any,
    });
    assert.equal(result.suggestExport, false);
    assert.equal(result.truncated, false);
    assert.equal(result.totalCount, 1);
    assert.equal(result.summary, '1 bills.');
    assert.deepEqual(result.coverage, { kind: 'complete', totalRows: 1 });
  });
});
