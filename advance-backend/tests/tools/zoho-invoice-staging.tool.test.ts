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
import { WriteNotDispatchedError } from '../../src/shared/errors.ts';

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
    put: async (staged: StagedInvoice) => {
      rows.set(staged.stagingId, { createdAt: new Date(), ...staged });
    },
    get: async ({ stagingId }: { stagingId: string }) => rows.get(stagingId) ?? null,
    claim: async ({ stagingId, marker }: { stagingId: string; marker: string }) => {
      calls.push('claim');
      const row = rows.get(stagingId);
      if (!row) return { claimed: false };
      if (row.createdInvoiceId) return { claimed: false, heldBy: row.createdInvoiceId };
      rows.set(stagingId, { ...row, createdInvoiceId: marker, claimedAt: new Date() });
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
    markUnresolved: async ({ stagingId, marker, unresolved }: { stagingId: string; marker: string; unresolved: string }) => {
      calls.push('markUnresolved');
      const row = rows.get(stagingId);
      if (row?.createdInvoiceId === marker) rows.set(stagingId, { ...row, createdInvoiceId: unresolved });
    },
    markAbsent: async ({ stagingId, marker, absent }: { stagingId: string; marker: string; absent: string }) => {
      calls.push('markAbsent');
      const row = rows.get(stagingId);
      if (row?.createdInvoiceId === marker) rows.set(stagingId, { ...row, createdInvoiceId: absent });
    },
    findUnresolved: async ({ connectionId }: { connectionId: string }) => {
      calls.push('findUnresolved');
      return [...rows.values()].filter(row => {
        if (row.connectionId !== connectionId) return false;
        const held = row.createdInvoiceId ?? '';
        // An in-flight claim, a caught failure, and a search that came back
        // empty are all still open questions; how they differ decides what the
        // caller does, not whether it gets to see them.
        return held.startsWith('unknown:') || held.startsWith('pending:')
          || held.startsWith('absent:');
      });
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
    listOrganizations: async () => [{ organizationId: 'org-1', name: 'Books', isDefault: true }],
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
  attachmentSource?: any;
} = {}) {
  return createZohoBooksTool({
    booksClient: overrides.booksClient ?? makeBooksClient(),
    financeOps: {} as ZohoFinanceOps,
    invoiceStaging: (overrides.store ?? makeStore()) as never,
    invoiceReviewer: { review: async () => overrides.review ?? passingReview },
    ...(overrides.attachmentSource ? { attachmentSource: overrides.attachmentSource } : {}),
    appBaseUrl: 'https://books.zoho.com',
  });
}

const larkCtx = makeCtx('zohoBooks', ['read', 'create', 'update', 'delete'], {
  chatId: 'oc-1',
} as never);

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

  it('blocks a draft whose invoice number Zoho would reject later', async () => {
    let mutated = false;
    const store = makeStore();
    const tool = makeTool({ store, booksClient: makeBooksClient(() => { mutated = true; }) });

    const result = await tool.execute({
      op: 'stage_invoice',
      fields: { ...soundPayload, invoice_number: 'DIVO-QA-INV-20260814-001' },
    } as never, ctx);

    assert.equal(result.ok, true);
    assert.equal((result as any).value.success, false);
    assert.equal(mutated, false, 'staging must not call Zoho');
    assert.match((result as any).value.stagedSummary, /allow at most 16/);
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

  it('hands the draft back only when Zoho proves it wrote nothing', async () => {
    // A validation refusal is the one failure that proves it: Zoho read the
    // payload, rejected it, wrote nothing. That draft has to stay retryable.
    const store = makeStore();
    const rejecting = {
      ...makeBooksClient(),
      mutate: async () => { throw new Error('Zoho Books 400 Bad Request: {"code":4000,"message":"Invalid customer"}'); },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: rejecting });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const stagingId = (staged as any).value.stagingId;

    const result = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);

    assert.equal(result.ok, false);
    assert.deepEqual(store.calls, ['findUnresolved', 'claim', 'release']);
    assert.equal(store.rows.get(stagingId)?.createdInvoiceId, undefined);
  });

  it('hands the draft back when the write was never dispatched', async () => {
    // A revoked refresh token, a missing connection, an unresolvable
    // organisation: none of these sent a byte. Holding them would strand a
    // draft that never reached Zoho and send the member hunting for an invoice
    // that does not exist.
    for (const failure of [
      new WriteNotDispatchedError('invalid_client'),
      new WriteNotDispatchedError('Zoho connection not found or access denied'),
    ]) {
      const store = makeStore();
      let mutations = 0;
      const failing = {
        ...makeBooksClient(),
        mutate: async () => { mutations += 1; throw failure; },
      } as unknown as ZohoBooksPaginatedClient;
      const tool = makeTool({ store, booksClient: failing });

      const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
      const stagingId = (staged as any).value.stagingId;

      const first = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
      assert.equal(first.ok, false, failure.message);
      assert.deepEqual(store.calls, ['findUnresolved', 'claim', 'release'], failure.message);
      assert.equal(
        /may already exist/.test(String((first as any).error.payload.message)),
        false,
        'nothing was sent, so nothing may exist',
      );

      // Once the connection is fixed, the same draft must still be creatable.
      const second = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
      assert.equal(second.ok, false);
      assert.equal(mutations, 2, 'the retry must actually reach Zoho');
    }
  });

  it('refuses to retry a draft whose create never reported back', async () => {
    // A 5xx, a timeout or a dropped socket all leave the same question open:
    // did Zoho write the invoice before the answer was lost? Releasing would
    // answer "no" on the member's behalf and invite the retry that bills twice.
    for (const failure of [
      new Error('Zoho Books 500 Internal Server Error: '),
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      new Error('fetch failed'),
    ]) {
      const store = makeStore();
      let mutations = 0;
      const failing = {
        ...makeBooksClient(),
        mutate: async () => { mutations += 1; throw failure; },
      } as unknown as ZohoBooksPaginatedClient;
      const tool = makeTool({ store, booksClient: failing });

      const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
      const stagingId = (staged as any).value.stagingId;

      const first = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
      assert.equal(first.ok, false, failure.message);
      assert.deepEqual(store.calls, ['findUnresolved', 'claim', 'markAbsent'], failure.message);

      // The retry the error text would otherwise invite must not reach Zoho.
      const second = await tool.execute({ op: 'create_invoice', stagingId } as never, ctx);
      assert.equal(second.ok, false);
      assert.match((second as any).error.payload.message, /already sent to Zoho once/);
      assert.equal(mutations, 1, `Zoho must be called once for ${failure.message}`);
    }
  });
});

describe('the same invoice, staged a second time', () => {
  // The claim protects one draft. Nothing protected the *work*: a member told
  // "that may or may not have gone through" asks again, the model stages a
  // fresh draft, and that draft carries no claim. Every guard waved it through.
  //
  // What Zoho stores when the answer to a create is lost.
  const createdInvoice = {
    invoice_id: 'inv-landed',
    invoice_number: 'INV-77',
    customer_id: soundPayload.customer_id,
    date: soundPayload.date,
    status: 'draft',
    currency_code: 'INR',
    sub_total: '50000.00',
    line_items: soundPayload.line_items,
  };

  /** Fails the create, then answers read-back lookups with `found`. */
  const clientThatLosesTheAnswer = (found: Record<string, unknown>[], onList?: () => void) => {
    let mutations = 0;
    return {
      client: {
        ...makeBooksClient(),
        mutate: async () => { mutations += 1; throw new Error('Zoho Books 500 Internal Server Error: '); },
        listRecords: async () => {
          onList?.();
          return { organizationId: 'org-1', items: found, hasMore: false, page: 1 };
        },
        getEndpoint: async () => ({}),
      } as unknown as ZohoBooksPaginatedClient,
      mutations: () => mutations,
    };
  };

  it('finds the invoice the lost answer created, and refuses to bill it twice', async () => {
    const store = makeStore();
    const { client, mutations } = clientThatLosesTheAnswer([createdInvoice]);
    const tool = makeTool({ store, booksClient: client });

    // First attempt: the answer is lost, but Divo reads back and finds it.
    const first = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const recovered = await tool.execute({
      op: 'create_invoice', stagingId: (first as any).value.stagingId,
    } as never, ctx);
    assert.equal(recovered.ok, true, 'a read-back that finds the invoice is a success, not a mystery');
    assert.equal((recovered as any).value.id, 'inv-landed');
    assert.match((recovered as any).value.message, /Divo checked Zoho: the invoice was created/);
    assert.equal(mutations(), 1);
  });

  it('refuses a fresh draft that repeats an unresolved one', async () => {
    const store = makeStore();
    let readBacks = 0;
    let mutations = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async () => {
        mutations += 1;
        throw new Error('Zoho Books 500 Internal Server Error: ');
      },
      listRecords: async (input: any) => {
        // Only the customer-plus-date-window lookup is a read-back; staging
        // makes plenty of other list calls and they must not be counted.
        const isReadBack = input.moduleName === 'invoices'
          && Boolean(input.filters?.customer_id) && Boolean(input.filters?.date_start);
        if (!isReadBack) return { organizationId: 'org-1', items: [], hasMore: false, page: 1 };
        readBacks += 1;
        // Invisible on the first look, visible by the second: Zoho did write
        // it, and only said so once its own indexes caught up.
        return {
          organizationId: 'org-1',
          items: readBacks > 1 ? [createdInvoice] : [],
          hasMore: false, page: 1,
        };
      },
      getEndpoint: async () => ({}),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: client });

    const first = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const failed = await tool.execute({
      op: 'create_invoice', stagingId: (first as any).value.stagingId,
    } as never, ctx);
    assert.equal(failed.ok, false, 'the first attempt is left unresolved');

    // The member is told there was a problem, so they ask for it again. A brand
    // new draft, no claim on it, and the member approves it believing nothing
    // was created.
    const second = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const blocked = await tool.execute({
      op: 'create_invoice', stagingId: (second as any).value.stagingId,
    } as never, ctx);

    assert.equal(blocked.ok, false, 'the second draft must not become a second invoice');
    assert.match((blocked as any).error.payload.message, /did reach Zoho after all/);
    assert.match((blocked as any).error.payload.message, /INV-77/);
    assert.equal(mutations, 1, 'Zoho must have been written to exactly once');
  });

  it('lets a fresh draft through once the search proves the earlier one never landed', async () => {
    const store = makeStore();
    let mutations = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async () => {
        mutations += 1;
        // Only the first attempt fails; the retry is allowed to succeed.
        if (mutations === 1) throw new Error('Zoho Books 500 Internal Server Error: ');
        return {
          organizationId: 'org-1',
          payload: { invoice: { ...createdInvoice, invoice_id: 'inv-retry' } },
        };
      },
      listRecords: async () => ({ organizationId: 'org-1', items: [], hasMore: false, page: 1 }),
      getEndpoint: async () => ({}),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: client });

    const first = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    await tool.execute({ op: 'create_invoice', stagingId: (first as any).value.stagingId } as never, ctx);

    const second = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const created = await tool.execute({
      op: 'create_invoice', stagingId: (second as any).value.stagingId,
    } as never, ctx);

    assert.equal(created.ok, true, 'evidence of absence must not become a permanent block');
    assert.equal((created as any).value.id, 'inv-retry');
    assert.equal(mutations, 2);
  });

  it('fetches the record when a list row cannot settle it, and finds the invoice', async () => {
    // Zoho's invoice LIST rows carry `total` but neither `sub_total` nor
    // `line_items` (verified against the live API). A draft that let Zoho
    // assign the number is therefore undecidable from a list row — and reading
    // that as "not found" is what green-lights the duplicate.
    const listRow = {
      invoice_id: 'inv-landed', invoice_number: 'INV-77',
      customer_id: soundPayload.customer_id, date: soundPayload.date,
      status: 'draft', total: 59000, balance: 59000,
    };
    let mutations = 0;
    let detailFetches = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async () => { mutations += 1; throw new Error('Zoho Books 500 Internal Server Error: '); },
      listRecords: async (input: any) => ({
        organizationId: 'org-1',
        items: input.filters?.customer_id ? [listRow] : [],
        hasMore: false, page: 1,
      }),
      getEndpoint: async ({ path }: { path: string }) => {
        if (!path.startsWith('/invoices/')) return {};
        detailFetches += 1;
        return { invoice: { ...listRow, sub_total: '50000.00', line_items: soundPayload.line_items } };
      },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store: makeStore(), booksClient: client });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const recovered = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId,
    } as never, ctx);

    assert.equal(recovered.ok, true, 'the invoice exists and must be reported as created');
    assert.equal((recovered as any).value.id, 'inv-landed');
    assert.ok(detailFetches > 0, 'an undecidable list row must be fetched in full, not written off');
    assert.equal(mutations, 1);
  });

  it('will not call an unfetchable candidate absent', async () => {
    const listRow = {
      invoice_id: 'inv-maybe', invoice_number: 'INV-78',
      customer_id: soundPayload.customer_id, date: soundPayload.date, total: 59000,
    };
    let mutations = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async () => { mutations += 1; throw new Error('Zoho Books 500 Internal Server Error: '); },
      listRecords: async (input: any) => ({
        organizationId: 'org-1',
        items: input.filters?.customer_id ? [listRow] : [],
        hasMore: false, page: 1,
      }),
      getEndpoint: async ({ path }: { path: string }) => {
        if (!path.startsWith('/invoices/')) return {};
        throw new Error('Zoho Books 503 Service Unavailable: ');
      },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store: makeStore(), booksClient: client });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const failed = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId,
    } as never, ctx);

    assert.equal(failed.ok, false);
    assert.match((failed as any).error.payload.message, /genuinely unknown/,
      'a candidate that could not be fetched is not evidence of absence');
    assert.equal(mutations, 1);
  });

  it('treats a claim orphaned by a dead process as unresolved', async () => {
    // `pending:` becomes `unknown:` only in the catch block. A process killed
    // mid-write never reaches it, so the row stays `pending:` forever — and the
    // retry's fresh draft used to sail past the guard entirely.
    const store = makeStore();
    let mutations = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async () => { mutations += 1; return { organizationId: 'org-1', payload: { invoice: { invoice_id: 'inv-second' } } }; },
      listRecords: async (input: any) => ({
        organizationId: 'org-1',
        items: input.filters?.customer_id ? [{ ...createdInvoice }] : [],
        hasMore: false, page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: client });

    // A draft whose create was claimed an hour ago and never came back.
    const orphan = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const orphanId = (orphan as any).value.stagingId;
    const row = store.rows.get(orphanId)!;
    store.rows.set(orphanId, {
      ...row,
      createdInvoiceId: 'pending:dead-process',
      // Claimed long enough ago that no live request could still hold it.
      claimedAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    const fresh = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const blocked = await tool.execute({
      op: 'create_invoice', stagingId: (fresh as any).value.stagingId,
    } as never, ctx);

    assert.equal(blocked.ok, false, 'a stale in-flight claim must still block the twin');
    assert.match((blocked as any).error.payload.message, /did reach Zoho after all/);
    assert.equal(mutations, 0, 'nothing may be posted while an orphaned claim is unexplained');
  });

  it('will not claim an invoice that existed before the draft did', async () => {
    // A monthly retainer: same customer, same amount, same lines. Matching on
    // those alone means last month's invoice answers this month's question —
    // reporting a write that never landed as a success, and uploading the
    // approved file onto a record nobody approved.
    const lastMonth = {
      invoice_id: 'inv-old', invoice_number: 'INV-01',
      customer_id: soundPayload.customer_id, date: soundPayload.date,
      created_time: '2020-01-01T00:00:00+0530',
      sub_total: '50000.00', line_items: soundPayload.line_items,
    };
    let mutations = 0;
    let attachments = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async (input: any) => {
        if (input.multipart) { attachments += 1; return { organizationId: 'org-1', payload: {} }; }
        mutations += 1;
        throw new Error('Zoho Books 500 Internal Server Error: ');
      },
      listRecords: async (input: any) => ({
        organizationId: 'org-1',
        items: input.filters?.customer_id ? [lastMonth] : [],
        hasMore: false, page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store: makeStore(), booksClient: client });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload, fileName: 'invoice.pdf',
    } as never, ctx);
    const result = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId,
    } as never, ctx);

    assert.equal(result.ok, false, 'an older invoice is not proof this write landed');
    assert.equal(attachments, 0, 'nothing may be uploaded onto an unrelated invoice');
    assert.equal(mutations, 1);
  });

  it('will not call a truncated search absent', async () => {
    let mutations = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async () => { mutations += 1; throw new Error('Zoho Books 500 Internal Server Error: '); },
      listRecords: async (input: any) => ({
        organizationId: 'org-1',
        // Nothing matches on this page — but there are more pages.
        items: input.filters?.customer_id
          ? [{ invoice_id: 'other', customer_id: soundPayload.customer_id, sub_total: '1.00', line_items: [] }]
          : [],
        hasMore: Boolean(input.filters?.customer_id), page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store: makeStore(), booksClient: client });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const result = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId,
    } as never, ctx);

    assert.equal(result.ok, false);
    assert.match((result as any).error.payload.message, /genuinely unknown/,
      'a page that is not the whole answer cannot rule anything out');
    assert.equal(mutations, 1);
  });

  it('reports no drift when it recovered the invoice from a list row', async () => {
    // A list row has no line_items and no sub_total. Comparing the draft
    // against one invents differences and tells the member their invoice is
    // wrong when it is not.
    const numbered = { ...soundPayload, invoice_number: 'EMI/2026/114' };
    const listRow = {
      invoice_id: 'inv-landed', invoice_number: 'EMI/2026/114',
      customer_id: numbered.customer_id, date: numbered.date,
      // Stamped at test time: an invoice created before the draft was staged is
      // correctly ignored, which is a different test.
      created_time: new Date().toISOString(), status: 'draft', total: 59000,
    };
    const client = {
      ...makeBooksClient(),
      mutate: async () => { throw new Error('Zoho Books 500 Internal Server Error: '); },
      listRecords: async (input: any) => ({
        organizationId: 'org-1',
        items: input.filters?.customer_id ? [listRow] : [],
        hasMore: false, page: 1,
      }),
      getEndpoint: async ({ path }: { path: string }) => (
        path.startsWith('/invoices/')
          ? {
            invoice: {
              ...listRow,
              due_date: numbered.due_date, currency_code: numbered.currency_code,
              sub_total: '50000.00', line_items: numbered.line_items,
            },
          }
          : {}
      ),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store: makeStore(), booksClient: client });

    const staged = await tool.execute({ op: 'stage_invoice', fields: numbered } as never, ctx);
    const recovered = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId,
    } as never, ctx);

    assert.equal(recovered.ok, true);
    assert.equal((recovered as any).value.drift, undefined, 'a list row must not be compared as if it were the record');
    assert.doesNotMatch((recovered as any).value.message, /stored some values differently/);
  });

  it('refuses a twin while the first attempt is still in flight', async () => {
    // A claim younger than the write ceiling means a request is very likely
    // still running. Reading back would race it and find nothing simply
    // because it has not finished — and that "nothing" would authorise a
    // second real invoice.
    const store = makeStore();
    let mutations = 0;
    const tool = makeTool({ store, booksClient: makeBooksClient(() => { mutations += 1; }) });

    const first = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const firstId = (first as any).value.stagingId;
    const row = store.rows.get(firstId)!;
    store.rows.set(firstId, {
      // Claimed at the instant the test clock reports as "now".
      ...row, createdInvoiceId: 'pending:in-flight', claimedAt: new Date('2025-01-01'),
    });

    const second = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const blocked = await tool.execute({
      op: 'create_invoice', stagingId: (second as any).value.stagingId,
    } as never, ctx);

    assert.equal(blocked.ok, false);
    assert.match((blocked as any).error.payload.message, /being sent to Zoho right now/);
    assert.equal(mutations, 0, 'nothing may be posted alongside a live create for the same invoice');
  });

  it('guards across members, because the books are shared even when drafts are not', async () => {
    const store = makeStore();
    let mutations = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async () => { mutations += 1; return { organizationId: 'org-1', payload: { invoice: { invoice_id: 'inv-2' } } }; },
      listRecords: async (input: any) => ({
        organizationId: 'org-1',
        items: input.filters?.customer_id ? [{ ...createdInvoice }] : [],
        hasMore: false, page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: client });

    const staged = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);

    // A colleague's lost attempt at the same invoice, on the same connection.
    const mine = store.rows.get((staged as any).value.stagingId)!;
    store.rows.set('other-member', {
      ...mine,
      stagingId: 'other-member', userId: 'someone-else',
      createdInvoiceId: 'unknown:lost',
    });
    const blocked = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId,
    } as never, ctx);

    assert.equal(blocked.ok, false, "another member's lost attempt still bills the same customer");
    assert.equal(mutations, 0);
  });

  it('will not let a months-old orphan claim next month\'s invoice', async () => {
    // A retainer billed monthly, Zoho assigning the numbers. An orphaned draft
    // from July matches August's draft perfectly — same customer, same amount,
    // same lines. If the read-back has no upper bound, July's draft claims the
    // invoice created for July, and August is refused and never billed.
    const store = makeStore();
    let mutations = 0;
    const julyInvoice = {
      invoice_id: 'inv-july', invoice_number: 'INV-88',
      customer_id: soundPayload.customer_id, date: soundPayload.date,
      // Created a month after the orphaned draft was dispatched.
      created_time: '2024-12-31T10:00:00+0530',
      sub_total: '50000.00', line_items: soundPayload.line_items,
    };
    const client = {
      ...makeBooksClient(),
      mutate: async (input: any) => {
        if (input.multipart) return { organizationId: 'org-1', payload: {} };
        mutations += 1;
        return { organizationId: 'org-1', payload: { invoice: { invoice_id: 'inv-august' } } };
      },
      listRecords: async (input: any) => ({
        organizationId: 'org-1',
        items: input.filters?.customer_id ? [julyInvoice] : [],
        hasMore: false, page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: client });

    const july = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const julyId = (july as any).value.stagingId;
    const julyRow = store.rows.get(julyId)!;
    // Dispatched a month before "now" (the test clock reads 2025-01-01) and
    // never heard from again.
    const monthAgo = new Date('2024-12-01T00:00:00.000Z');
    store.rows.set(julyId, {
      ...julyRow, createdInvoiceId: 'pending:dead', claimedAt: monthAgo, createdAt: monthAgo,
    });

    const august = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const created = await tool.execute({
      op: 'create_invoice', stagingId: (august as any).value.stagingId,
    } as never, ctx);

    assert.equal(created.ok, true, "an invoice created a month after a dispatch cannot be from it");
    assert.equal((created as any).value.id, 'inv-august');
    assert.equal(mutations, 1, 'August must actually be billed');
    assert.notEqual(store.rows.get(julyId)?.createdInvoiceId, 'inv-july',
      'the orphaned draft must not be settled against an invoice it never created');
  });

  it('refuses rather than grinding through an unbounded pile of unresolved twins', async () => {
    const store = makeStore();
    let mutations = 0;
    const tool = makeTool({ store, booksClient: makeBooksClient(() => { mutations += 1; }) });

    const seed = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const template = store.rows.get((seed as any).value.stagingId)!;
    for (let i = 0; i < 8; i += 1) {
      store.rows.set(`lost-${i}`, {
        ...template, stagingId: `lost-${i}`, createdInvoiceId: `unknown:lost-${i}`,
      });
    }
    store.rows.delete((seed as any).value.stagingId);

    const fresh = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const refused = await tool.execute({
      op: 'create_invoice', stagingId: (fresh as any).value.stagingId,
    } as never, ctx);

    assert.equal(refused.ok, false);
    assert.match((refused as any).error.payload.message, /too many for Divo to check/);
    assert.equal(mutations, 0);
  });

  it('refuses when the earlier attempt cannot be checked at all', async () => {
    const store = makeStore();
    let mutations = 0;
    let listCalls = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async () => { mutations += 1; throw new Error('Zoho Books 500 Internal Server Error: '); },
      listRecords: async () => {
        listCalls += 1;
        throw new Error('Zoho Books 503 Service Unavailable: ');
      },
      getEndpoint: async () => ({}),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ store, booksClient: client });

    const first = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    await tool.execute({ op: 'create_invoice', stagingId: (first as any).value.stagingId } as never, ctx);

    const second = await tool.execute({ op: 'stage_invoice', fields: soundPayload } as never, ctx);
    const blocked = await tool.execute({
      op: 'create_invoice', stagingId: (second as any).value.stagingId,
    } as never, ctx);

    assert.equal(blocked.ok, false);
    assert.match((blocked as any).error.payload.message, /cannot check whether it exists/);
    assert.equal(mutations, 1, 'a lookup that failed is not evidence the invoice is missing');
    assert.ok(listCalls > 0);
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

describe('a draft is created where it was reviewed', () => {
  it('posts to the organisation it was staged against, not the one the confirming call names', async () => {
    // The draft was checked against one organisation's customers, items and
    // taxes. Creating it elsewhere posts ids that mean something different
    // there — and the drift check cannot see it, because Zoho echoes back the
    // customer_id it was sent.
    const writes: any[] = [];
    const client = {
      ...makeBooksClient(),
      mutate: async (input: any) => {
        writes.push(input);
        return {
          organizationId: input.organizationId,
          payload: { invoice: { invoice_id: 'inv-created', status: 'draft', currency_code: 'INR', customer_id: input.body?.customer_id } },
        };
      },
    } as unknown as ZohoBooksPaginatedClient;
    const store = makeStore();
    const tool = makeTool({ store, booksClient: client });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload,
      connectionId: 'conn-a', organizationId: 'ORG-A',
    } as never, ctx);
    const stagingId = (staged as any).value.stagingId;

    // The tool docs tell the model to omit organizationId; doing so must not
    // silently redirect the invoice to the connection's default organisation.
    const created = await tool.execute({
      op: 'create_invoice', stagingId, connectionId: 'conn-a',
    } as never, ctx);

    assert.equal(created.ok, true);
    const post = writes.find(w => w.path === '/invoices');
    assert.equal(post.organizationId, 'ORG-A');
    assert.equal(post.connectionId, 'conn-a');
  });

  it('refuses to create a draft against a different Zoho account', async () => {
    const store = makeStore();
    const tool = makeTool({ store });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload,
      connectionId: 'conn-a', organizationId: 'ORG-A',
    } as never, ctx);
    const stagingId = (staged as any).value.stagingId;

    const wrongConnection = await tool.execute({
      op: 'create_invoice', stagingId, connectionId: 'conn-b',
    } as never, ctx);
    const wrongOrg = await tool.execute({
      op: 'create_invoice', stagingId, connectionId: 'conn-a', organizationId: 'ORG-B',
    } as never, ctx);

    assert.equal(wrongConnection.ok, false);
    assert.match((wrongConnection as any).error.payload.message, /different Zoho account/);
    assert.equal(wrongOrg.ok, false);
    assert.match((wrongOrg as any).error.payload.message, /different Zoho organisation/);
    assert.equal(store.calls.includes('claim'), false, 'nothing may be claimed for a refused destination');
  });
});

describe('the file the summary promised', () => {
  const pdf = {
    kind: 'resolved' as const,
    fileName: 'acme-po.pdf',
    mimeType: 'application/pdf',
    content: Buffer.from('%PDF-1.4'),
  };

  it('attaches it after creating, and says what Zoho confirms', async () => {
    const writes: any[] = [];
    const client = {
      ...makeBooksClient(),
      mutate: async (input: any) => {
        writes.push(input);
        return {
          organizationId: 'org-1',
          payload: { invoice: { invoice_id: 'inv-created', status: 'draft', currency_code: 'INR', customer_id: input.body?.customer_id } },
        };
      },
      getEndpoint: async () => (writes.some(w => String(w.path).includes('/attachment'))
        ? { invoice: { invoice_id: 'inv-created', documents: [{ file_name: 'acme-po.pdf' }] } }
        : { invoice: { invoice_id: 'inv-created', documents: [] } }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient: client, attachmentSource: { resolve: async () => pdf } });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload, fileName: 'acme-po.pdf',
    } as never, larkCtx);
    assert.match((staged as any).value.stagedSummary, /Attachment: acme-po\.pdf/);

    const created = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId,
    } as never, larkCtx);

    assert.equal(created.ok, true);
    assert.ok(writes.some(w => String(w.path).includes('/attachment')), 'the approved file must be attached');
    assert.match((created as any).value.message, /Attached "acme-po\.pdf"/);
  });

  it('says the invoice stands without its file when the attachment fails', async () => {
    // The member approved a summary promising the file. Silence here would let
    // them assume it landed.
    const tool = makeTool({
      attachmentSource: { resolve: async () => ({ kind: 'unavailable', message: 'No file called "acme-po.pdf" was sent in this conversation.' }) },
    });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload, fileName: 'acme-po.pdf',
    } as never, larkCtx);
    const created = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId,
    } as never, larkCtx);

    assert.equal(created.ok, true);
    // Never dispatched, so it is safe to say the file can still be put on later.
    assert.match((created as any).value.message, /never uploaded/);
    assert.match((created as any).value.message, /No file called/);
    assert.match((created as any).value.message, /attach_document can still put it on/);
  });
});

describe('a number that is already in use', () => {
  it('blocks a draft whose invoice number Zoho already has', async () => {
    // create_invoice sets ignore_auto_number_generation when a number is
    // supplied, so this is the one path where a repeat can reach the books.
    const client = {
      ...makeBooksClient(),
      listRecords: async ({ moduleName }: any) => ({
        organizationId: 'org-1',
        items: moduleName === 'invoices'
          ? [{ invoice_id: 'inv-existing', invoice_number: 'EMI/2026/114' }]
          : [],
        hasMore: false, page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient: client });

    const staged = await tool.execute({
      op: 'stage_invoice',
      fields: { ...soundPayload, invoice_number: 'EMI/2026/114' },
    } as never, ctx);

    assert.equal((staged as any).value.success, false);
    assert.match((staged as any).value.stagedSummary, /EMI\/2026\/114 is already used by inv-existing/);
  });
});

describe('verifying an attachment follows the write', () => {
  it('confirms the file in the organisation the invoice was created in', async () => {
    // The upload went to the staged organisation; a verification read against
    // the connection's default one 404s and reports a file that did land as
    // missing.
    let uploaded = false;
    const client = {
      ...makeBooksClient(),
      mutate: async (input: any) => {
        if (String(input.path).includes('/attachment')) {
          // The upload must itself go to the staged organisation.
          assert.equal(input.organizationId, 'ORG-A');
          uploaded = true;
          return { organizationId: input.organizationId, payload: {} };
        }
        return {
          organizationId: input.organizationId,
          payload: { invoice: { invoice_id: 'inv-created', status: 'draft', currency_code: 'INR' } },
        };
      },
      getEndpoint: async (input: any) => {
        // The read has to follow the write, or a file that landed reads as missing.
        if (input.organizationId !== 'ORG-A') throw new Error('Zoho Books 404 Not Found: invoice does not exist');
        return {
          invoice: {
            invoice_id: 'inv-created',
            documents: uploaded ? [{ file_name: 'acme-po.pdf' }] : [],
          },
        };
      },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({
      booksClient: client,
      attachmentSource: {
        resolve: async () => ({
          kind: 'resolved' as const,
          fileName: 'acme-po.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('%PDF-1.4'),
        }),
      },
    });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload, fileName: 'acme-po.pdf',
      connectionId: 'conn-a', organizationId: 'ORG-A',
    } as never, larkCtx);

    // organizationId omitted on the confirming call, as the tool docs instruct.
    const created = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId, connectionId: 'conn-a',
    } as never, larkCtx);

    assert.equal(created.ok, true);
    assert.match((created as any).value.message, /Attached "acme-po\.pdf"/);
  });

  it('does not call an accepted upload a failed one, or invite a blind retry', async () => {
    // The POST succeeded and only the verification read failed. Saying the
    // record is unchanged would invite a retry, and Zoho appends rather than
    // replaces — the same PDF twice.
    let attachments = 0;
    const client = {
      ...makeBooksClient(),
      mutate: async (input: any) => {
        if (String(input.path).includes('/attachment')) { attachments += 1; return { organizationId: 'org-1', payload: {} }; }
        return { organizationId: 'org-1', payload: { invoice: { invoice_id: 'inv-created', status: 'draft', currency_code: 'INR' } } };
      },
      getEndpoint: async () => { throw new Error('Zoho Books 503 Service Unavailable: '); },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({
      booksClient: client,
      attachmentSource: {
        resolve: async () => ({
          kind: 'resolved' as const,
          fileName: 'po.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('%PDF-1.4'),
        }),
      },
    });

    const result = await tool.execute({
      op: 'attach_document', recordType: 'invoice', recordId: 'inv-1', fileName: 'po.pdf',
    } as never, larkCtx);

    assert.equal(result.ok, true, 'an accepted upload is not a refusal');
    assert.equal((result as any).value.success, false, 'but it is not confirmed either');
    assert.equal(
      /itself is unchanged/.test((result as any).value.message),
      false,
      'the upload was accepted, so the record may well have changed',
    );
    assert.match((result as any).value.message, /Do not upload it again/);
    assert.equal(attachments, 1);
  });
});

describe('the organisation a draft was judged in', () => {
  it('creates in the organisation the review read from, even when nobody named one', async () => {
    // A connection can expose several organisations with no default flag, and
    // which one a later call resolves to is Zoho's response order rather than a
    // contract. Reviewing against one and creating in another puts a customer_id
    // that means someone else on a real invoice — and the drift check cannot see
    // it, because Zoho echoes the id back unchanged.
    let listedOrg = 'ORG-A';
    const writes: any[] = [];
    const client = {
      mutate: async (input: any) => {
        writes.push(input);
        return {
          organizationId: input.organizationId,
          payload: { invoice: { invoice_id: 'inv-created', status: 'draft', currency_code: 'INR' } },
        };
      },
      listRecords: async (input: any) => ({
        organizationId: input.organizationId ?? listedOrg, items: [], hasMore: false, page: 1,
      }),
      listOrganizations: async () => [{ organizationId: listedOrg, name: 'Books' }],
      getEndpoint: async () => ({}),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient: client });

    const staged = await tool.execute({
      op: 'stage_invoice', fields: soundPayload, connectionId: 'conn-a',
    } as never, ctx);

    // Zoho's ordering changes between the two calls.
    listedOrg = 'ORG-B';

    const created = await tool.execute({
      op: 'create_invoice', stagingId: (staged as any).value.stagingId, connectionId: 'conn-a',
    } as never, ctx);

    assert.equal(created.ok, true);
    const post = writes.find(w => w.path === '/invoices');
    assert.equal(post.organizationId, 'ORG-A', 'the invoice must land where it was reviewed');
  });
});
