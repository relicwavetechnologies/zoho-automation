/**
 * The invariants that stop a draft becoming two invoices, or a different one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './tool-test.helpers.ts';
import { createZohoBooksTool } from '../../src/application/tools/families/zoho-books.tool.ts';
import type { ZohoFinanceOps } from '../../src/application/zoho/zoho-finance-ops.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';
import type { StagedInvoice } from '../../src/application/zoho/zoho-invoice-staging.ts';

const ctx = makeCtx('zohoBooks', ['read', 'create', 'update', 'delete']);

const soundPayload = {
  customer_id: '1500001',
  date: '2026-08-01',
  due_date: '2026-08-31',
  currency_code: 'INR',
  line_items: [{ name: 'Retainer', quantity: 1, rate: 50000 }],
};

function makeStore(seed?: Partial<StagedInvoice>) {
  const rows = new Map<string, StagedInvoice>();
  const calls: string[] = [];
  if (seed?.stagingId) rows.set(seed.stagingId, seed as StagedInvoice);
  return {
    calls,
    rows,
    put: async (staged: StagedInvoice) => { rows.set(staged.stagingId, staged); },
    get: async ({ stagingId }: { stagingId: string }) => rows.get(stagingId) ?? null,
    claim: async ({ stagingId, marker }: { stagingId: string; marker: string }) => {
      calls.push('claim');
      const row = rows.get(stagingId);
      if (!row) return { claimed: false };
      if (row.createdInvoiceId) return { claimed: false, heldBy: row.createdInvoiceId };
      rows.set(stagingId, { ...row, createdInvoiceId: marker });
      return { claimed: true };
    },
    settle: async ({ stagingId, invoiceId }: { stagingId: string; invoiceId: string }) => {
      calls.push('settle');
      const row = rows.get(stagingId);
      if (row) rows.set(stagingId, { ...row, createdInvoiceId: invoiceId });
    },
    release: async ({ stagingId }: { stagingId: string }) => {
      calls.push('release');
      const row = rows.get(stagingId);
      if (row) rows.set(stagingId, { ...row, createdInvoiceId: undefined });
    },
  };
}

function makeBooksClient(onMutate?: () => void) {
  return {
    mutate: async (input: any) => {
      onMutate?.();
      return {
        organizationId: 'org-1',
        payload: {
          invoice: {
            invoice_id: 'inv-created',
            invoice_number: 'INV-9',
            status: 'draft',
            currency_code: 'INR',
            sub_total: '50000.00',
            total: '59000.00',
            line_items: input.body?.line_items ?? [],
            customer_id: input.body?.customer_id,
          },
        },
      };
    },
    listRecords: async () => ({ organizationId: 'org-1', items: [], hasMore: false, page: 1 }),
    getEndpoint: async () => ({}),
  } as unknown as ZohoBooksPaginatedClient;
}

const passingReview = {
  outcome: 'pass' as const, reason: 'Everything traces to a source.', issues: [], unsourced: [],
};

function makeTool(overrides: {
  store?: ReturnType<typeof makeStore>;
  booksClient?: ZohoBooksPaginatedClient;
  review?: any;
} = {}) {
  return createZohoBooksTool({
    booksClient: overrides.booksClient ?? makeBooksClient(),
    financeOps: {} as ZohoFinanceOps,
    invoiceStaging: (overrides.store ?? makeStore()) as never,
    invoiceReviewer: { review: async () => overrides.review ?? passingReview },
    appBaseUrl: 'https://books.zoho.com',
  });
}

describe('invoices must be staged', () => {
  it('refuses create_invoice with no staging', async () => {
    const result = await makeTool().execute({ op: 'create_invoice', fields: soundPayload } as never, ctx);
    assert.equal(result.ok, false);
    assert.match((result as any).error.payload.message, /needs a stagingId/);
  });

  it('stages without writing anything to Zoho', async () => {
    let mutated = false;
    const store = makeStore();
    const tool = makeTool({ store, booksClient: makeBooksClient(() => { mutated = true; }) });

    const result = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);

    assert.equal(result.ok, true);
    assert.equal(mutated, false, 'staging must not call Zoho');
    assert.ok((result as any).value.stagingId);
    assert.match((result as any).value.stagedSummary, /Retainer/);
  });

  it('will not create a draft the reviewer rejected', async () => {
    const store = makeStore();
    const tool = makeTool({
      store,
      review: {
        outcome: 'fail', reason: 'The amount contradicts what the member said.',
        issues: [{ field: 'amount', problem: 'member said 40000, draft says 50000' }],
        unsourced: [],
      },
    });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const stagingId = (staged as any).value.stagingId;
    assert.equal((staged as any).value.success, false);

    const created = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
    assert.equal(created.ok, false);
    assert.match((created as any).error.payload.message, /did not pass review/);
  });
});

describe('one approved draft makes one invoice', () => {
  it('refuses to create the same staging twice', async () => {
    let mutations = 0;
    const store = makeStore();
    const tool = makeTool({ store, booksClient: makeBooksClient(() => { mutations += 1; }) });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const stagingId = (staged as any).value.stagingId;

    const first = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
    const second = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.match((second as any).error.payload.message, /already created as invoice/);
    assert.equal(mutations, 1, 'Zoho must be called exactly once');
  });

  it('claims the draft before calling Zoho, and hands it back when the call throws', async () => {
    // Zoho has no idempotency key, so the claim has to happen first: a create
    // that succeeds and then times out must not be retried into a real second
    // invoice. A call that never reached Zoho has to be retryable, though.
    const store = makeStore();
    const failing = {
      ...makeBooksClient(),
      mutate: async () => { throw new Error('Zoho Books 500'); },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: failing });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const stagingId = (staged as any).value.stagingId;

    const result = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);

    assert.equal(result.ok, false);
    assert.deepEqual(store.calls, ['claim', 'release']);
    assert.equal(store.rows.get(stagingId)?.createdInvoiceId, undefined);
  });
});

describe('what Zoho stored versus what was approved', () => {
  it('reports a customer Zoho did not keep', async () => {
    const store = makeStore();
    const drifting = {
      ...makeBooksClient(),
      mutate: async () => ({
        organizationId: 'org-1',
        payload: { invoice: { invoice_id: 'inv-1', status: 'draft', customer_id: '9999999', currency_code: 'INR' } },
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: drifting });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const created = await tool.execute(
      { op: 'create_invoice', stagingId: (staged as any).value.stagingId } as never,
      ctx,
    );

    assert.equal(created.ok, true);
    const drift = (created as any).value.drift;
    assert.ok(drift.some((entry: any) => entry.field === 'customer'));
    assert.match((created as any).value.message, /stored some values differently/);
  });
});
