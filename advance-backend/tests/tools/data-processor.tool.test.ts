import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './tool-test.helpers.ts';
import { createDataProcessorTool } from '../../src/application/orchestration/tools/families/data-processor.tool.ts';
import { getModuleSchema, injectSyntheticFields, toSchemaHint } from '../../src/infrastructure/zoho/zoho-books-schema.cache.ts';
import {
  DatasetSourceRegistry,
  type DataExportSource,
} from '../../src/application/data-export/data-export.types.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { ZOHO_BOOKS_FIELDS } from '../../src/shared/zoho-books-row-contract.ts';

describe('Zoho Books schema synthetic fields', () => {
  it('maps bill totals and balances to distinct synthetic fields', () => {
    const schema = getModuleSchema('bills');
    const [bill] = injectSyntheticFields([
      {
        bill_id: 'bill-1',
        total: 7670,
        balance: 1170,
        date: '2026-04-15',
        status: 'open',
        vendor_name: 'Acme',
      },
    ], schema);

    assert.equal(bill._amount, 7670);
    assert.equal(bill._total, 7670);
    assert.equal(bill._balance, 1170);
    assert.equal(bill._date, '2026-04-15');
    assert.equal(bill._id, 'bill-1');
    assert.equal(bill._status, 'open');

    const hint = toSchemaHint(schema, bill);
    assert.equal(hint.balanceField, 'balance -> item._balance (unpaid/outstanding)');
    assert.deepEqual((hint.syntheticFields as Record<string, unknown>)._total, 'alias for _amount');
    assert.equal((hint.syntheticFields as Record<string, unknown>)._status, 'status from status');
    assert.ok((hint.sampleFieldNames as string[]).includes('vendor_name'));
  });

  it('falls back to _amount for modules without a balance field', () => {
    const schema = getModuleSchema('expenses');
    const [expense] = injectSyntheticFields([
      {
        expense_id: 'exp-1',
        total: 250,
        date: '2026-04-20',
      },
    ], schema);

    assert.equal(expense._amount, 250);
    assert.equal(expense._total, 250);
    assert.equal(expense._balance, 250);
  });

  it('normalizes official invoice list fields into the documented processor contract', () => {
    const [invoice] = injectSyntheticFields([{
      invoice_id: 'invoice-1',
      status: 'overdue',
      currency_code: 'USD',
      exchange_rate: 83.25,
      total: 100,
      balance: 40,
      date: '2026-07-29',
    }], getModuleSchema('invoices'), {
      toINR: () => { throw new Error('recorded exchange rate should be used'); },
    });

    assert.deepEqual(
      Object.values(ZOHO_BOOKS_FIELDS).filter(field => !(field in invoice)),
      [],
    );
    assert.equal(invoice._id, 'invoice-1');
    assert.equal(invoice._status, 'overdue');
    assert.equal(invoice._currency, 'USD');
    assert.equal(invoice._total_inr, 8325);
    assert.equal(invoice._balance_inr, 3330);
  });

  it('keeps omitted customer-payment currency unknown while trusting Zoho base amount', () => {
    const [payment] = injectSyntheticFields([{
      payment_id: 'payment-1',
      amount: 100,
      bcy_amount: 9_500,
      date: '2026-07-29',
    }], getModuleSchema('customerpayments'), {
      toINR: () => { throw new Error('Zoho bcy_amount should be used'); },
    });

    assert.equal(payment._currency, 'UNKNOWN');
    assert.equal(payment._amount, 100);
    assert.equal(payment._amount_inr, 9_500);
    assert.match(
      String((toSchemaHint(getModuleSchema('customerpayments')).syntheticFields as any)._currency),
      /never treat UNKNOWN as INR/i,
    );
  });
});

describe('dataProcessor bounded input', () => {
  it('processes direct small data without owning provider fetch or export logic', async () => {
    const tool = createDataProcessorTool();
    const result = await tool.execute({
      data: [{ amount: 10 }, { amount: 20 }],
      script: 'return data.reduce((sum, item) => sum + item.amount, 0)',
    }, makeCtx('dataProcessor', ['read']));
    assert.equal(result.ok, true);
    assert.equal((result as any).value.data, 30);
    assert.doesNotMatch(tool.description, /Cloudinary|Zoho source/i);
  });
});

describe('dataProcessor governed sources', () => {
  const connectionId = '11111111-1111-4111-8111-111111111111';
  const source = (module: 'invoices' | 'bills'): DataExportSource => ({
    kind: 'zoho_books',
    connectionId,
    module,
  });
  const airtableSource: DataExportSource = {
    kind: 'airtable_records',
    connectionId,
    toolId: 'airtableRecords',
    nativeTool: 'list_records_for_table',
    input: { baseId: 'appTest', tableId: 'tblTest' },
  };
  const args = {
    sources: [
      { alias: 'invoices', source: source('invoices') },
      { alias: 'airtable', source: airtableSource },
    ],
    program: {
      initialState: {},
      reduce: `
        if (!state[source]) state[source] = { count: 0, total: 0 };
        state[source].count += 1;
        state[source].total += row.amount;
        return state;
      `,
      finalize: 'return { aggregates: state, complete: meta.complete };',
    },
  };

  it('aggregates multiple paged sources and returns complete provenance', async () => {
    const registry = new DatasetSourceRegistry();
    registry.register({
      kind: 'zoho_books',
      async *read() {
        yield { rows: [{ amount: 10 }] };
        yield { rows: [{ amount: 15 }] };
      },
    });
    registry.register({
      kind: 'airtable_records',
      async *read() {
        yield { rows: [{ amount: 7 }] };
      },
    });
    const tool = createDataProcessorTool({ sources: registry });
    const ctx = makeCtx();
    const dataProcessor = asToolId('dataProcessor');
    const zohoBooks = asToolId('zohoBooks');
    const airtableRecords = asToolId('airtableRecords');
    const result = await tool.execute(args, {
      ...ctx,
      perm: {
        allowedToolIds: new Set([dataProcessor, zohoBooks, airtableRecords]),
        allowedActionsByTool: new Map([
          [dataProcessor, new Set(['read' as const])],
          [zohoBooks, new Set(['read' as const])],
          [airtableRecords, new Set(['read' as const])],
        ]),
        decisions: [],
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.data, {
      aggregates: {
        invoices: { count: 2, total: 25 },
        airtable: { count: 1, total: 7 },
      },
      complete: true,
    });
    assert.equal(result.value.recordsProcessed, 3);
    assert.equal(result.value.complete, true);
    assert.deepEqual(result.value.provenance, {
      invoices: { kind: 'zoho_books', pagesRead: 2, recordsRead: 2, complete: true },
      airtable: { kind: 'airtable_records', pagesRead: 1, recordsRead: 1, complete: true },
    });
  });

  it('requires read permission for every underlying source tool', () => {
    const tool = createDataProcessorTool({ sources: new DatasetSourceRegistry() });
    const dataProcessor = asToolId('dataProcessor');
    const zohoBooks = asToolId('zohoBooks');
    const result = tool.permissionCheck(args, {
      allowedToolIds: new Set([dataProcessor, zohoBooks]),
      allowedActionsByTool: new Map([
        [dataProcessor, new Set(['read' as const])],
        [zohoBooks, new Set(['read' as const])],
      ]),
      decisions: [],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /airtableRecords.*read/i);
  });

  it('marks a source incomplete when the governed row boundary is reached', async () => {
    const registry = new DatasetSourceRegistry();
    registry.register({
      kind: 'zoho_books',
      async *read() {
        yield {
          rows: [{ amount: 10 }, { amount: 20 }],
          hasMore: true,
        };
      },
    });
    const tool = createDataProcessorTool({ sources: registry, sourceRowLimit: 1 });
    const ctx = makeCtx();
    const dataProcessor = asToolId('dataProcessor');
    const zohoBooks = asToolId('zohoBooks');
    const result = await tool.execute({
      sources: [{ alias: 'invoices', source: source('invoices') }],
      program: {
        initialState: { total: 0 },
        reduce: 'state.total += row.amount; return state;',
      },
    }, {
      ...ctx,
      perm: {
        allowedToolIds: new Set([dataProcessor, zohoBooks]),
        allowedActionsByTool: new Map([
          [dataProcessor, new Set(['read' as const])],
          [zohoBooks, new Set(['read' as const])],
        ]),
        decisions: [],
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.data, { total: 10 });
    assert.equal(result.value.complete, false);
    assert.equal(result.value.provenance?.['invoices']?.complete, false);
    assert.match(result.value.message ?? '', /do not present.*exact/i);
  });

  it('returns an error result when sandbox initialization rejects oversized state', async () => {
    const tool = createDataProcessorTool({ sources: new DatasetSourceRegistry() });
    const ctx = makeCtx();
    const result = await tool.execute({
      sources: [{ alias: 'invoices', source: source('invoices') }],
      program: {
        initialState: { value: 'x'.repeat(2 * 1024 * 1024) },
        reduce: 'return state;',
      },
    }, ctx);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /initial computation state exceeds 2 MB/i);
  });
});
